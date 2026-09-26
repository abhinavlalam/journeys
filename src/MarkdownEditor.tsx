// The note pane, over the file's own bytes.
//
// **The document is the markdown.** There is no serialiser here and nothing parses
// and regenerates the text: what CodeMirror holds is the string that was read off
// disk, and what autosave writes is that string with the user's edits in it. That
// single property is what this file is for. The editor before it was a WYSIWYG that
// rewrote text nobody had touched on its way back out — `[[wikilink]]` escaped,
// `- ` turned into `* `, a blank line inserted between every list item — and a
// whole module existed to repair one of those. Nothing here needs repairing.
//
// Formatting is therefore *syntax*. ⌘B puts `**` in the document, deleting the `**`
// by hand unbolds, and the markers are hidden by a decoration rather than consumed
// by a parser — so there is always a caret position between them.

import { useEffect, useRef } from 'react'
import { type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import {
  autocompletion,
  nextSnippetField,
  prevSnippetField,
} from '@codemirror/autocomplete'
import { EditorHost } from './EditorHost'
import { formatKeymap, insertTimeKeymap } from './editorCommands'
import {
  collectionSource,
  completionAppearance,
  slashSource,
  wikiLinkSource,
} from './editorComplete'
import type { CollectionOption } from './editorComplete'
import {
  collectionAt,
  collectionDeclarations,
  isCollectionClick,
  isLinkClick,
  isTagClick,
  isTaskClick,
  tagNameAt,
  taskAt,
  toggledTask,
  linkTargetAt,
  livePreview,
} from './editorPreview'
import { splitFrontmatter } from './frontmatter'
import type { VaultFile } from './vaultModel'

interface MarkdownEditorProps {
  /**
   * Read at mount only, exactly as `EditorHost`'s is: the parent keys this component on
   * the open note's path and `editorEpoch`, so switching notes or picking up an
   * external edit *remounts* it rather than pushing text into a live editor.
   *
   * That is what makes "this editor holds this note" a fact instead of an invariant
   * to maintain — and it is also why `onChange` cannot fire on open: there is no
   * programmatic document swap to fire it, and CodeMirror's update listener does
   * not run for the initial state.
   */
  initialMarkdown: string
  /**
   * The configurable insert-timestamp combo, in this app's own `mod+shift+t` form,
   * or `null` to disable it (the settings panel is open, so capturing a rebind must
   * not fire the action being rebound).
   */
  insertTimeCombo?: string | null
  /** Every note in the vault, for the `[[` picker. Read through a ref, so a note
      created since this mounted is still offered. */
  notes?: VaultFile[]
  /** The vault's collections, for the `--` picker: a declared one completes to the
      line it declares. Read through a ref, like the notes. */
  collections?: CollectionOption[]
  /** Spaces per indent level, from the settings. Applied through a compartment, so
      moving the slider does not remount the editor. */
  indentWidth?: number
  /** A click on a link, with the raw target — `Roadmap` from `[[Roadmap]]`, or
      `Notes/Roadmap.md` from `[Roadmap](Notes/Roadmap.md)`. The caller resolves it;
      this editor knows nothing about the vault. */
  onOpenLink?: (target: string, wiki: boolean) => void
  /** A click on a `--keyword`, with its name. A collection is a page, and the
      keyword is the only place in a note that names one. */
  onOpenCollection?: (keyword: string) => void
  /** A `#tag` was pressed: its page is every line in the vault carrying it. */
  onOpenTag?: (tag: string) => void
  /** Where today's note lives, for the `/` menu's Today. Through a ref like the
      rest, so changing the setting does not remount the editor. */
  dailyFolder?: string
  /** Called synchronously, on every document change and on no other update. */
  onChange: (markdown: string) => void
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

/**
 * What is markdown about this editor. Everything else — the box, the gutters, the
 * line numbers, folding, the caret, wrapping, the change listener — is
 * `EditorHost`, and is the same for any file the app opens.
 *
 * `markdownLanguage` and not the CommonMark base: task lists and strikethrough are
 * GFM, and a vault written in Obsidian is full of both.
 */
function markdownExtensions(
  insertTime: () => string | null,
  getNotes: () => VaultFile[],
  getCollections: () => CollectionOption[],
  getDailyFolder: () => string,
  openLink: (target: string, wiki: boolean) => void,
  openCollection: (keyword: string) => void,
  openTag: (tag: string) => void
): Extension[] {
  return [
    // The declarations, for the renderer — an empty field hides with its lead-in,
    // and only the declaration knows which prose led into which field.
    collectionDeclarations.of(getCollections),
    /**
     * A press on a link follows it, as it does in Obsidian's live preview. The
     * caret still lands anywhere else, so text stays editable by clicking into it
     * — including in the space past the end of a line that ends in a link, which
     * is what `isLinkClick` is for.
     *
     * **`mousedown`, and this is the whole of why.** It was `click`, and a click
     * needs the press and the release on the *same element*: pressing a link puts
     * the caret in it, live preview reveals the syntax it had hidden, and the very
     * span that was pressed is **replaced** before the button comes back up. So no
     * click was ever generated, and following a link took two presses — the second
     * landing on a line whose syntax was already revealed. Read out of the running
     * app's own event log, after three fixes aimed at the wrong thing:
     *
     *     mousedown span.cm-md-link < div.cm-line < div.cm-content
     *     mouseup   span.cm-md-link < div.cm-line < div.cm-content
     *     (no click)
     *
     * The press is the only event a decoration cannot outrun.
     */
    EditorView.domEventHandlers({
      mousedown(event, view) {
        // The left button alone: the right one is the menu's, and a modifier is the
        // platform's — ⌘-click and ⌥-drag are not "follow this link".
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return false
        /**
         * **A press on a checkbox checks it**, and `mousedown` matters here more
         * than anywhere else in this handler: the toggle changes the document, the
         * decoration is rebuilt, and the very element that was pressed is gone
         * before the button comes back up. A `click` would never be generated —
         * exactly the bug the comment above this one records, waiting to happen a
         * second time.
         *
         * One character is written, the state between the brackets. Everything
         * else on the line is the user's and is not re-spelled.
         */
        if (isTaskClick(event.target)) {
          const at = event.target instanceof Node ? view.posAtDOM(event.target) : null
          const task = at == null ? null : taskAt(view.state, at)
          if (!task) return false
          event.preventDefault()
          view.dispatch({
            changes: { from: task.from + 1, to: task.from + 2, insert: toggledTask(task.mark) },
          })
          return true
        }
        /** A press on a `#tag` opens its page, the same act a `--keyword` gets. */
        if (isTagClick(event.target)) {
          const at = event.target instanceof Node ? view.posAtDOM(event.target) : null
          const tag = at == null ? null : tagNameAt(view.state, at)
          if (!tag) return false
          event.preventDefault()
          openTag(tag)
          return true
        }
        const link = isLinkClick(event.target)
        // **A keyword goes somewhere too**, and the somewhere is a page rather than
        // a note: `--expense` in a line is the only place a collection is named, so
        // pressing it is the shortest way to ask what else says that. Same event,
        // same reason — the mark is on the keyword whether the line is being edited
        // or not, so the span survives the press either way.
        if (!link && !isCollectionClick(event.target)) return false
        // **From the node, not the coordinates.** The test above has already said
        // the press landed on the mark's own element, so `posAtDOM` answers from
        // the thing that was pressed rather than from where the pointer was — no
        // measuring, and nothing to be wrong about at the edges of a glyph.
        const pos = event.target instanceof Node ? view.posAtDOM(event.target) : null
        if (pos == null) return false
        if (!link) {
          const keyword = collectionAt(view.state, pos)
          if (!keyword) return false
          event.preventDefault()
          openCollection(keyword)
          return true
        }
        const found = linkTargetAt(view.state, pos)
        if (!found) return false
        event.preventDefault()
        openLink(found.target, found.wiki)
        return true
      },
    }),
    placeholder('Start writing…'),
    completionAppearance,
    autocompletion({
      override: [
        wikiLinkSource(getNotes),
        slashSource(getDailyFolder),
        collectionSource(getCollections),
      ],
    }),
    // Ahead of everything, and rebuilt from a getter each keypress so a rebind in
    // the settings panel takes effect without remounting the editor.
    keymap.of([
      // **Ahead of the list commands**, because a completed declaration leaves the
      // caret in a snippet field and Tab has to move to the next hole rather than
      // indent the line it is on. Both decline when no field is active, so Tab is
      // the list's again the moment the structure is filled in.
      { key: 'Tab', run: nextSnippetField },
      { key: 'Shift-Tab', run: prevSnippetField },
      insertTimeKeymap(insertTime),
      ...formatKeymap,
      // `@codemirror/lang-markdown`'s own: Enter continues a list, Backspace
      // removes the marker. These sit ahead of the host's `defaultKeymap`, whose
      // plain Enter would otherwise win — which is what `EditorHost` puts a
      // caller's extensions first for.
      ...markdownKeymap,
    ]),
    // **`addKeymap: false`, and the bindings above are the whole order.**
    // `markdown()` adds `markdownKeymap` itself at `Prec.high`, which outranks any
    // keymap a caller passes however it is ordered — so `continueIndent` was bound,
    // reached by a direct call, and dead under the key. Switched off here, the array
    // above is the precedence, and the same bindings are still in it.
    markdown({ base: markdownLanguage, addKeymap: false }),
    livePreview,
  ]
}

/**
 * Where a note opens: past its properties, and past its title.
 *
 * Past the properties, because at offset 0 the caret sits between the opening
 * `---` and the first key, so the first thing typed edits a property. Past the
 * title for the same reason one step down — a note's first line is usually its
 * name, and the caret being *in* it both invites editing the name and reveals the
 * `#`, since this editor shows the syntax the caret is in. A new action file is
 * created as `# owner` and nothing else, which is where that was noticed.
 *
 * Only a heading on the note's *first* line after the block: further down, a
 * heading is a section and the caret has no business skipping it.
 */
export function caretOnOpen(text: string): number {
  const body = splitFrontmatter(text)
  const first = body.body.split('\n', 1)[0]
  if (!/^#{1,6}\s/.test(first)) return body.prefix.length
  // The line after it, or the end of the note when the title is all there is.
  const past = body.prefix.length + first.length + 1
  return Math.min(past, text.length)
}

export function MarkdownEditor({
  initialMarkdown,
  onChange,
  insertTimeCombo,
  notes = [],
  collections = [],
  indentWidth = 2,
  onOpenLink,
  onOpenCollection,
  onOpenTag,
  dailyFolder = '',
}: MarkdownEditorProps) {
  // Everything the extension list closes over is pinned to the mount, so each of
  // these arrives through a ref: a note created since, a rebound combo, a fresh
  // `onOpenLink` from a re-render.
  const openLinkRef = useRef(onOpenLink)
  useEffect(() => {
    openLinkRef.current = onOpenLink
  }, [onOpenLink])
  const openCollectionRef = useRef(onOpenCollection)
  useEffect(() => {
    openCollectionRef.current = onOpenCollection
  }, [onOpenCollection])
  const openTagRef = useRef(onOpenTag)
  useEffect(() => {
    openTagRef.current = onOpenTag
  }, [onOpenTag])
  const notesRef = useRef(notes)
  useEffect(() => {
    notesRef.current = notes
  }, [notes])
  const collectionsRef = useRef(collections)
  useEffect(() => {
    collectionsRef.current = collections
  }, [collections])
  const dailyFolderRef = useRef(dailyFolder)
  useEffect(() => {
    dailyFolderRef.current = dailyFolder
  }, [dailyFolder])
  const comboRef = useRef(insertTimeCombo ?? null)
  useEffect(() => {
    comboRef.current = insertTimeCombo ?? null
  }, [insertTimeCombo])

  // Built once, for the same reason the host mounts once: this is the language, and
  // the language does not change under an open document.
  const extensionsRef = useRef<Extension[] | null>(null)
  extensionsRef.current ??= markdownExtensions(
    () => comboRef.current,
    () => notesRef.current,
    () => collectionsRef.current,
    () => dailyFolderRef.current,
    (target, wiki) => openLinkRef.current?.(target, wiki),
    (keyword) => openCollectionRef.current?.(keyword),
    (tag) => openTagRef.current?.(tag)
  )

  return (
    <EditorHost
      initialText={initialMarkdown}
      initialSelection={caretOnOpen(initialMarkdown)}
      onChange={onChange}
      extensions={extensionsRef.current}
      ariaLabel="Markdown source"
      className="markdown-editor"
      indentWidth={indentWidth}
    />
  )
}

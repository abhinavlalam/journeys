// The note editor, over the file's own bytes.
//
// The document is the markdown. Nothing parses and regenerates the text:
// autosave writes what was read, with the edits in it. The editor before
// this one was a WYSIWYG that rewrote text nobody touched (`[[links]]`
// escaped, `- ` turned into `* `, blank lines between list items).
//
// So formatting is syntax. ⌘B types `**`, and the markers are hidden
// by a decoration, so there is always a caret position between them.

import { useRef } from 'react'
import { type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionKeymap,
  selectedCompletion,
} from '@codemirror/autocomplete'
import { EditorHost } from './EditorHost'
import { formatKeymap, insertTimeKeymap } from './editorCommands'
import { propertySource, completionAppearance, slashSource, wikiLinkSource } from './editorComplete'
import {
  propertyTypes,
  isLinkClick,
  isTagClick,
  isTaskClick,
  tagNameAt,
  taskAt,
  toggledTask,
  linkTargetAt,
  livePreview,
} from './editorPreview'
import { splitPageProperties } from './properties'
import type { VaultFile } from './vaultModel'
import type { Entries } from './configEntries'

interface MarkdownEditorProps {
  /**
   * Read at mount only, as in `EditorHost`. The parent keys this on the
   * note's path and `editorEpoch`, so a new note or an outside edit
   * remounts the editor. That is also why `onChange` never fires on open.
   */
  initialMarkdown: string
  /**
   * The insert-timestamp combo, like `mod+shift+t`, or `null` to
   * turn it off while the settings panel is capturing a rebind.
   */
  insertTimeCombo?: string | null
  /**
   * Every note in the vault, for the `[[` popup. Read through a
   * ref, so notes made after mount are offered too.
   */
  notes?: VaultFile[]
  /** Each property's type, to know where a block property's value ends. */
  propertyTypes?: Entries
  /** Each tag's structure, for the properties its line is offered. */
  tagStructures?: Entries
  /** Open with the caret at the end. A daily note's next line goes at the bottom. */
  caretAtEnd?: boolean
  /** On screen; see `EditorHost`. */
  shown?: boolean
  /**
   * Spaces per indent level, from the settings. Changed through
   * a compartment, so the slider does not remount the editor.
   */
  indentWidth?: number
  /**
   * A click on a link, with its raw target: `Roadmap` from `[[Roadmap]]`, or
   * `Notes/Roadmap.md` from `[Roadmap](Notes/Roadmap.md)`. The caller resolves it.
   */
  onOpenLink?: (target: string, wiki: boolean) => void
  /** A `#tag` was pressed. Its page lists every line in the vault that carries it. */
  onOpenTag?: (tag: string) => void
  /**
   * Where today's note lives, for Today in the `/` menu. Read
   * through the ref, so a change does not remount.
   */
  dailyFolder?: string
  /** Called on every document change, and nothing else. */
  onChange: (markdown: string) => void
  /**
   * An editor for one line (a timeline entry) instead of a note: no gutters, and Enter,
   * Escape and leaving are the caller's. An open popup still takes its keys first.
   */
  line?: { onEnter: (text: string) => void; onEscape: () => void; onLeave?: (text: string) => void }
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

/**
 * What is markdown about this editor. The box, gutters, folding, caret,
 * wrapping and change listener are `EditorHost`'s, the same for every file.
 *
 * `markdownLanguage` rather than plain CommonMark, for GFM task
 * lists and strikethrough.
 */
function markdownExtensions(latest: { current: MarkdownEditorProps }): Extension[] {
  const getTypes = () => latest.current.propertyTypes ?? {}
  return [
    propertyTypes.of(getTypes),
    /**
     * A press on a link follows it. Clicks elsewhere, including past the end
     * of a line that ends in a link (`isLinkClick`), still place the caret.
     *
     * This is `mousedown` on purpose. With `click`, pressing a link moved the
     * caret into it, the hidden syntax showed, and the pressed span was replaced
     * before the release, so no click fired. Following a link took two presses.
     */
    EditorView.domEventHandlers({
      mousedown(event, view) {
        // Left button only, with no modifier. Right click is the
        // menu; ⌘-click and ⌥-drag are the platform's.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return false
        /**
         * A press on a checkbox toggles it. Also `mousedown`,
         * since the toggle rebuilds the box before the release.
         * Only the character between the brackets is written.
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
        /** A press on a `#tag` opens its page. */
        if (isTagClick(event.target)) {
          const at = event.target instanceof Node ? view.posAtDOM(event.target) : null
          const tag = at == null ? null : tagNameAt(view.state, at)
          if (!tag) return false
          event.preventDefault()
          latest.current.onOpenTag?.(tag)
          return true
        }
        if (!isLinkClick(event.target)) return false
        // Position from the pressed node (`posAtDOM`), not the pointer's coordinates.
        const pos = event.target instanceof Node ? view.posAtDOM(event.target) : null
        if (pos == null) return false
        const found = linkTargetAt(view.state, pos)
        if (!found) return false
        event.preventDefault()
        latest.current.onOpenLink?.(found.target, found.wiki)
        return true
      },
      blur(_event, view) {
        latest.current.line?.onLeave?.(view.state.sliceDoc())
      },
    }),
    placeholder('Start writing…'),
    completionAppearance,
    // Its keys are bound in the array below, not at the `Prec.highest` it would use.
    autocompletion({
      defaultKeymap: false,
      override: [
        wikiLinkSource(() => latest.current.notes ?? []),
        slashSource(() => latest.current.dailyFolder ?? ''),
        propertySource(() => latest.current.tagStructures ?? {}, getTypes),
      ],
    }),
    // Before everything else. The timestamp combo is read on
    // each key press, so a rebind works without a remount.
    keymap.of([
      // Enter over a property's name in the popup makes a new
      // line, not the name: a line may end at its tag. Tab takes
      // the name. This comes before the popup's own Enter.
      {
        key: 'Enter',
        run: (view) => {
          if (selectedCompletion(view.state)?.type === 'property') closeCompletion(view)
          return false
        },
      },
      // The popup's arrows, Enter and Escape. They do nothing while it is closed.
      ...completionKeymap,
      // A one-line editor hands Enter and Escape to the caller.
      {
        key: 'Enter',
        run: (view) => {
          latest.current.line?.onEnter(view.state.sliceDoc())
          return latest.current.line !== undefined
        },
      },
      {
        key: 'Escape',
        run: () => {
          latest.current.line?.onEscape()
          return latest.current.line !== undefined
        },
      },
      // Tab takes the popup's pick, if there is one.
      { key: 'Tab', run: acceptCompletion },
      insertTimeKeymap(() => latest.current.insertTimeCombo ?? null),
      ...formatKeymap,
      // lang-markdown's own keys: Enter continues a quote, Backspace removes a
      // marker. Before the host's `defaultKeymap`, whose plain Enter would win.
      ...markdownKeymap,
    ]),
    // `addKeymap: false`, so the array above is the whole key order.
    // `markdown()` would add its keymap at `Prec.high`, above
    // everything here, and `continueIndent` never ran from the key.
    markdown({ base: markdownLanguage, addKeymap: false }),
    livePreview,
  ]
}

/**
 * Where a note opens: after its properties, and after its title.
 *
 * At offset 0 the first key typed edits a property. On the title
 * line it would edit the name and show the `#`. Only a heading on
 * the first line is skipped; a heading further down is a section.
 */
export function caretOnOpen(text: string): number {
  const body = splitPageProperties(text)
  const first = body.body.split('\n', 1)[0]
  if (!/^#{1,6}\s/.test(first)) return body.prefix.length
  // The next line, or the end of the note when the title is all there is.
  const past = body.prefix.length + first.length + 1
  return Math.min(past, text.length)
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  // The extensions are built once, as the host mounts once, so
  // they read this render's props through one ref.
  const latest = useRef(props)
  latest.current = props
  const extensionsRef = useRef<Extension[] | null>(null)
  extensionsRef.current ??= markdownExtensions(latest)
  const { initialMarkdown, onChange, indentWidth = 2 } = props

  return (
    <EditorHost
      shown={props.shown}
      initialText={initialMarkdown}
      initialSelection={props.caretAtEnd ? initialMarkdown.length : caretOnOpen(initialMarkdown)}
      onChange={onChange}
      extensions={extensionsRef.current}
      ariaLabel="Markdown source"
      className="markdown-editor"
      indentWidth={indentWidth}
      gutters={!props.line}
    />
  )
}

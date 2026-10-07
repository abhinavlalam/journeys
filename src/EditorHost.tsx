// The editor, minus the language.
//
// What every text file gets: it scrolls, numbers its lines, folds by indent, draws
// its own caret and selection, wraps, and reports each change. Anything that knows
// what the bytes mean (grammar, popups, decorations) is passed in by the caller.

import { useEffect, useRef } from 'react'
import { Compartment, EditorState, Text, Transaction, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { codeFolding, indentUnit, syntaxTree } from '@codemirror/language'
import { indentFold, indentFoldGutter, keepFolded } from './editorFold'
import { onAndroid } from './platform'

interface EditorHostProps {
  /**
   * Whether the editor is on screen. A hidden tab keeps its editor and
   * its undo. Hidden, it lost the keyboard; it takes it back when shown.
   */
  shown?: boolean
  /**
   * Read at mount only. The caller keys this on the document (a
   * note's path and epoch, a file's version), so new text is a
   * remount. That is also why `onChange` never fires on open.
   */
  initialText: string
  /**
   * The file as it is now on disk, after a change made outside this editor (an
   * agent, a pull, the app's own write). Applied as a change to the open document,
   * not a remount, so the caret, folds, scroll and undo stay. Rebuilt, the editor
   * put the caret at a daily note's end and dropped its folds after every outside
   * write. `n` counts the reads, so the same text read twice is applied once.
   */
  incoming?: { text: string; n: number } | null
  /** Called on every document change, and nothing else. */
  onChange: (text: string) => void
  /**
   * The language and everything that knows what the bytes mean. Read at mount,
   * and placed before the shared extensions so its keys outrank `defaultKeymap`.
   */
  extensions?: Extension[]
  /** CodeMirror gives `.cm-content` `role="textbox"` and no name. */
  ariaLabel: string
  /**
   * Added to `code-editor`, which carries the box, gutters and
   * caret. A file type only changes the face.
   */
  className: string
  /**
   * Where the caret starts, read at mount. The default, 0, is
   * inside a note's properties, so the caller says where.
   */
  initialSelection?: number
  /**
   * Spaces per indent level, from the settings. Changed through a
   * compartment, so the slider does not remount the editor and lose the undo.
   */
  indentWidth?: number
  /** Line numbers and folding. A one-line field, like a timeline entry, has neither. */
  gutters?: boolean
  /**
   * Takes the keyboard on mount and when shown. Not on a phone, where the keyboard
   * would cover half of every page opened to read; a line editor still does.
   */
  autoFocus?: boolean
}

const indentSize = new Compartment()
const editable = new Compartment()
/** Shown, an editor as usual; hidden, one no key, cut or paste can change. */
const hiddenGuard = (shown: boolean) => [EditorView.editable.of(shown), EditorState.readOnly.of(!shown)]

/**
 * `drawSelection` instead of the native caret, which is as tall as
 * the line box and in the system colour. No `highlightActiveLine`.
 */
function shared(
  onChange: (text: string) => void,
  ariaLabel: string,
  indentWidth: number,
  gutters: boolean
): Extension[] {
  return [
    indentSize.of(indentUnit.of(' '.repeat(indentWidth))),
    // Folding by indent works for JSON too: a pretty-printed `{`
    // opens an indented block as a heading opens a section.
    gutters ? [codeFolding(), indentFoldGutter, indentFold, keepFolded] : [],
    drawSelection(),
    // Line numbers on every file type; they were taken off notes once and asked
    // back. The gutter is a fixed width, so crossing 10 or 100 moves nothing.
    gutters ? lineNumbers() : [],
    history(),
    keymap.of([
      // Tab indents, ⇧Tab outdents. `defaultKeymap` leaves Tab
      // alone so focus can leave the editor; a text editor opts in.
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
    // On document changes only; a selection move is not an edit. `sliceDoc`,
    // not `doc.toString()`, which joins lines with `\n` whatever the file used.
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.sliceDoc())
    }),
  ]
}

/**
 * The line break a file uses: the most common of the three. Otherwise CodeMirror
 * writes `\n`, and the first key in a CRLF file rewrote every line ending.
 */
function lineBreakOf(text: string): string {
  const crlf = text.split('\r\n').length - 1
  const cr = text.split('\r').length - 1 - crlf
  const lf = text.split('\n').length - 1 - crlf
  return crlf > lf && crlf >= cr ? '\r\n' : cr > lf ? '\r' : '\n'
}

/**
 * A field of the app's own (a rename, a new name, the search
 * box) has the keyboard, outside this editor.
 */
function typingElsewhere(root: HTMLElement): boolean {
  const at = document.activeElement as HTMLElement | null
  if (!at || at === document.body || root.contains(at)) return false
  return at.tagName === 'INPUT' || at.tagName === 'TEXTAREA' || at.isContentEditable
}

/**
 * A plugin that draws `decorate` over the visible span, and
 * knows when to redraw. Markdown and JSON both use it.
 *
 * The viewport is one span: without folding, `visibleRanges` is one
 * range, and merging its ends keeps decorations from overlapping.
 *
 * It also redraws when the syntax tree changes. A long note is parsed in idle
 * time, and the update carrying the finished tree changes neither the text nor
 * the selection, so without the check the end of a long note never rendered.
 */
export function decorated(
  decorate: (state: EditorState, from: number, to: number) => DecorationSet
): Extension {
  const forView = (view: EditorView) => {
    const ranges = view.visibleRanges
    if (ranges.length === 0) return Decoration.none
    return decorate(view.state, ranges[0].from, ranges[ranges.length - 1].to)
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = forView(view)
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          !update.state.selection.eq(update.startState.selection) ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = forView(update.view)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}

/** The one change from `was` to `now`: what lies between their common start and common end. */
function smallestChange(was: string, now: string): { from: number; to: number; insert: string } {
  let from = 0
  while (from < was.length && from < now.length && was[from] === now[from]) from++
  let end = 0
  while (end < was.length - from && end < now.length - from && was[was.length - 1 - end] === now[now.length - 1 - end]) end++
  return { from, to: was.length - end, insert: now.slice(from, now.length - end) }
}

export function EditorHost({
  initialText,
  onChange,
  extensions = [],
  ariaLabel,
  className,
  initialSelection = 0,
  indentWidth = 2,
  shown = true,
  gutters = true,
  autoFocus = !onAndroid,
  incoming,
}: EditorHostProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  // What was applied, so a mount never applies a read meant for the editor before it.
  const taken = useRef(incoming?.n)
  const viewRef = useRef<EditorView | null>(null)
  // The mount effect sees one render, and `onChange` is new on each.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // The one setting that reaches a live editor rather than a remount.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: indentSize.reconfigure(indentUnit.of(' '.repeat(indentWidth))),
    })
  }, [indentWidth])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    viewRef.current = null
    const lineBreak = lineBreakOf(initialText)
    // Clamped, so a stale position for a shorter text does not throw. Then
    // mapped into the document, where the caller's `\r\n` counts as one.
    const anchor = Math.min(initialSelection, initialText.length)
    const breaks = initialText.slice(0, anchor).split(lineBreak).length - 1
    const head = anchor - breaks * (lineBreak.length - 1)
    const view = new EditorView({
      state: EditorState.create({
        doc: initialText,
        selection: { anchor: head },
        extensions: [
          EditorState.lineSeparator.of(lineBreak),
          editable.of(hiddenGuard(shown)),
          ...extensions,
          ...shared((text) => onChangeRef.current(text), ariaLabel, indentWidth, gutters),
        ],
      }),
      parent: root,
      // Scrolled into sight: a caret at the end of a long day is
      // otherwise below the fold.
      scrollTo: EditorView.scrollIntoView(head, { y: 'nearest' }),
    })
    viewRef.current = view
    // Focused, so the caret shows: CodeMirror draws it only in a focused editor.
    //
    // Unless the owner is typing somewhere else. A double click on a row opens the
    // note and starts a rename, and focusing here ended the rename as it appeared.
    if (autoFocus && !typingElsewhere(root)) view.focus()
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // Intentionally mount-once — see `initialText` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !incoming || incoming.n === taken.current) return
    taken.current = incoming.n
    // In the document's terms, where a break is one character whatever the file uses:
    // in the file's, a CRLF note's change took a `\r` into the line, and the save wrote it.
    const now = view.state.doc.toString()
    const next = incoming.text.split(view.state.lineBreak).join('\n')
    if (now === next) return
    const { from, to, insert } = smallestChange(now, next)
    view.dispatch({ changes: { from, to, insert: Text.of(insert.split('\n')) }, annotations: Transaction.addToHistory.of(false) })
  }, [incoming])

  // Hidden, it takes no keys. A tab's press does not move the focus in WebKit, so the
  // keyboard stayed in a note when the terminal's tab showed, and select-all and
  // delete meant for the terminal emptied the note out of sight.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: editable.reconfigure(hiddenGuard(shown)) })
    if (!shown && view.hasFocus) view.contentDOM.blur()
  }, [shown])

  // After the event that showed it: a tab switches on mousedown,
  // and that press then clears the focus the editor had just taken.
  useEffect(() => {
    if (!shown || !autoFocus) return
    const later = setTimeout(() => {
      const root = rootRef.current
      if (root && !typingElsewhere(root)) viewRef.current?.focus()
    })
    return () => clearTimeout(later)
  }, [shown, autoFocus])

  return <div className={`code-editor ${className}`} ref={rootRef} />
}

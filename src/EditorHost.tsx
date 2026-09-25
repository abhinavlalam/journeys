// The editor, minus the language.
//
// **One editor, two kinds of file.** Everything here is true of any text file the
// app opens: it scrolls inside itself, it numbers its lines, it folds by
// indentation, it draws its own caret and selection, it wraps, and it reports every
// document change synchronously. What is *not* here is anything that knows what the
// bytes mean — no grammar, no completions, no decorations — because that is the
// half that differs, and the caller passes it in.
//
// The JSON pane was a `<textarea>` before this. It had none of the above: no line
// numbers, no folding, and it never joined `.viewer`'s centring list, so a config
// file ran the full width of the window while a note sat in a 720px column beside
// it. The list's own comment in the sheet says what happens to anything that does
// not join it.

import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
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
import { indentFold, indentFoldGutter } from './editorFold'

interface EditorHostProps {
  /**
   * Read at mount **only**. The caller keys this component on what the document is
   * — a note's path and epoch, a file's version — so replacing the text is a
   * remount rather than a push into a live editor.
   *
   * That is what makes "this editor holds this file" a fact instead of an invariant
   * to maintain, and it is why `onChange` cannot fire on open: there is no
   * programmatic document swap to fire it, and CodeMirror's update listener does
   * not run for the initial state.
   */
  initialText: string
  /** Called synchronously, on every document change and on no other update. */
  onChange: (text: string) => void
  /** The language and everything that knows what the bytes mean. Read at mount,
   *  like `initialText`, and placed **ahead** of the shared extensions so a
   *  language's keymap outranks `defaultKeymap` — which is how Enter continues a
   *  markdown list instead of just breaking the line. */
  extensions?: Extension[]
  /** CodeMirror gives `.cm-content` `role="textbox"` and no name. */
  ariaLabel: string
  /** Beside `code-editor`, which carries the box, the gutters and the caret. The
   *  only thing a file type changes here is the face. */
  className: string
  /**
   * Where the caret starts, read at mount with the text.
   *
   * The default is 0, which for a note is *inside* its properties — the first
   * thing typed would edit the frontmatter. What is past them is the language's
   * question, so the caller answers it.
   */
  initialSelection?: number
  /** Spaces per indent level, from the settings. Through a compartment, so moving
   *  the slider does not remount the editor and throw away the undo history. */
  indentWidth?: number
}

const indentSize = new Compartment()

/**
 * No `highlightActiveLine`, and `drawSelection` rather than the browser's own: the
 * native caret is as tall as the *line box* — which at a note's leading reads as a
 * long bar — and its colour is the OS's. Drawn, both are styleable, and the same
 * two rules dress every file type.
 */
function shared(
  onChange: (text: string) => void,
  ariaLabel: string,
  indentWidth: number
): Extension[] {
  return [
    indentSize.of(indentUnit.of(' '.repeat(indentWidth))),
    codeFolding(),
    // By indentation, and that is the whole reason it works for both: a pretty
    // printed `{` opens an indented block exactly as a heading opens a section, so
    // JSON folds between its braces without a grammar to tell it where they are.
    indentFoldGutter,
    indentFold,
    drawSelection(),
    // **Line numbers, for every file type.** They were taken off notes for a day
    // on the argument that a note is not code, and asked straight back: they were
    // never the complaint. The gutter they sit in is right-aligned and a fixed
    // width, so a count crossing 10 or 100 moves nothing — see `.cm-lineNumbers`.
    lineNumbers(),
    history(),
    keymap.of([
      // Tab indents, ⇧Tab outdents. `defaultKeymap` leaves Tab alone on purpose —
      // it is how you move focus out of an editor — so a text editor has to opt in.
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
    // **Synchronous**, and `docChanged` only: a selection move is not an edit. The
    // cost of firing per keystroke is a string copy; what the caller does with it —
    // autosave a note, dirty a JSON file — is the caller's business. `sliceDoc` and
    // not `doc.toString()`, which joins lines with `\n` whatever the file used.
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.sliceDoc())
    }),
  ]
}

/**
 * The line break a file is written with: the commonest of the three. Left to
 * itself CodeMirror splits on all three and writes `\n`, so the first keystroke in
 * a CRLF file rewrote every line ending; told, a mixed file's strays stay as written.
 */
function lineBreakOf(text: string): string {
  const crlf = text.split('\r\n').length - 1
  const cr = text.split('\r').length - 1 - crlf
  const lf = text.split('\n').length - 1 - crlf
  return crlf > lf && crlf >= cr ? '\r\n' : cr > lf ? '\r' : '\n'
}

/** A field of the app's own chrome has the keyboard — a rename, a new name, the
 *  search box — and it is not inside this editor. */
function typingElsewhere(root: HTMLElement): boolean {
  const at = document.activeElement as HTMLElement | null
  if (!at || at === document.body || root.contains(at)) return false
  return at.tagName === 'INPUT' || at.tagName === 'TEXTAREA' || at.isContentEditable
}

/**
 * A plugin that draws `decorate` over the visible span, and knows when to redraw.
 *
 * Both editors need this and both had written it: markdown's live preview and
 * JSON's colour, each with its own copy of the same class and its own `forView`.
 * The copies had started to differ — the parse check below was in one and not the
 * other — which is the only difference that mattered and the easiest to forget.
 *
 * **The viewport as one span**: `visibleRanges` is a single range without folding,
 * and merging the ends is what keeps a caller's decorations free of overlap.
 *
 * **The parse is the half that is easy to forget.** A long note is parsed
 * incrementally in idle time, and the update carrying the finished tree changes
 * neither the document nor the selection — so without the tree comparison the
 * bottom of a long note renders once and never again. A file with no language
 * extension has one empty tree that never changes, so the check costs it nothing.
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

export function EditorHost({
  initialText,
  onChange,
  extensions = [],
  ariaLabel,
  className,
  initialSelection = 0,
  indentWidth = 2,
}: EditorHostProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // The mount effect pins one render, and `onChange` is a fresh function on each.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // The one setting that reaches a live editor rather than a remounted one.
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
    // Clamped: the caller works this out from the text, and a stale answer for a
    // shorter document would throw rather than land somewhere harmless. Then moved
    // into the document's positions, where a `\r\n` the caller counted as two is one.
    const anchor = Math.min(initialSelection, initialText.length)
    const breaks = initialText.slice(0, anchor).split(lineBreak).length - 1
    const view = new EditorView({
      state: EditorState.create({
        doc: initialText,
        selection: { anchor: anchor - breaks * (lineBreak.length - 1) },
        extensions: [
          EditorState.lineSeparator.of(lineBreak),
          ...extensions,
          ...shared((text) => onChangeRef.current(text), ariaLabel, indentWidth),
        ],
      }),
      parent: root,
    })
    viewRef.current = view
    // **Focused, so the caret is visible.** CodeMirror draws it only for a focused
    // editor, and opening a file with the caret placed and nothing showing is the
    // same as not placing it. Every mount of this component is a file arriving in
    // the pane, which is the moment to take the keyboard.
    //
    // Unless the user is typing somewhere else: a double click on a row opens the
    // note *and* starts a rename, the file arrives a read later, and the rename
    // field commits on blur — so taking the keyboard here ended the rename a
    // moment after it appeared.
    if (!typingElsewhere(root)) view.focus()
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // Intentionally mount-once — see `initialText` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className={`code-editor ${className}`} ref={rootRef} />
}

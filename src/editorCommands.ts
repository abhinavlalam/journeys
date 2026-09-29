// The editor's keys: every command that writes markdown syntax into the document.
//
// **Formatting is syntax.** ⌘B puts `**` in the document and deleting the `**` by
// hand unbolds — see `MarkdownEditor.tsx` for why that is the whole point — so
// every command here is an edit to the text and none of them is a mode.

import { EditorSelection, type EditorState, type Line } from '@codemirror/state'
import { EditorView, type Command } from '@codemirror/view'
import { getIndentUnit } from '@codemirror/language'
import { localTimeStamp } from './clock'
import { indentOf } from './prose'

/**
 * Wrap the selection in `marker`, or unwrap it if it is already wrapped.
 *
 * Both spellings of "already wrapped" are handled, because both are what a user
 * has in front of them: the markers can be **outside** the selection (⌘B, then ⌘B
 * again — the selection is left over the word, with the `**` either side of it) or
 * **inside** it (the user dragged across `**word**` themselves). Checking only one
 * gave a command that could not undo its own work.
 *
 * An empty cursor gets `****` with the caret between the pairs, which is what an
 * "insert syntax" command means when there is nothing to wrap.
 *
 * `changeByRange`, so the selection is mapped through the edit rather than
 * recomputed: the two insertions shift every position after the first one, and
 * doing that arithmetic by hand is how the caret ends up inside the marker.
 */
export function toggleMarker(marker: string): Command {
  const width = marker.length
  return ({ state, dispatch }) => {
    const spec = state.changeByRange((range) => {
      if (
        state.sliceDoc(range.from - width, range.from) === marker &&
        state.sliceDoc(range.to, range.to + width) === marker
      ) {
        return {
          changes: [
            { from: range.from - width, to: range.from },
            { from: range.to, to: range.to + width },
          ],
          range: EditorSelection.range(range.from - width, range.to - width),
        }
      }
      const inner = state.sliceDoc(range.from, range.to)
      if (inner.length >= width * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
        return {
          changes: [
            { from: range.from, to: range.from + width },
            { from: range.to - width, to: range.to },
          ],
          range: EditorSelection.range(range.from, range.to - width * 2),
        }
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: range.empty
          ? EditorSelection.cursor(range.from + width)
          : EditorSelection.range(range.from + width, range.to + width),
      }
    })
    // `userEvent: 'input'`, so `@codemirror/commands`' history groups it as typing
    // and one ⌘Z takes the whole pair of markers back out.
    dispatch(state.update(spec, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

/** A `KeyboardEvent` in the same notation `cmKey` produces, so the two can be compared. */
function keyNameOf(event: KeyboardEvent): string {
  const mods: string[] = []
  if (event.metaKey) mods.push('Mod')
  if (event.ctrlKey) mods.push('Ctrl')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  return [...mods, event.key.toLowerCase()].join('-')
}

/**
 * This app's combo notation into CodeMirror's. `mod+shift+t` is ours; `Mod-Shift-t`
 * is CodeMirror's, and it wants the modifiers in that order.
 */
function cmKey(combo: string): string | null {
  const parts = combo.toLowerCase().split('+')
  const key = parts.pop()
  if (!key) return null
  const order = ['mod', 'ctrl', 'alt', 'shift']
  const mods = order.filter((m) => parts.includes(m)).map((m) => (m === 'mod' ? 'Mod' : m[0].toUpperCase() + m.slice(1)))
  return [...mods, key].join('-')
}

/** Tab on a line with lines nested under it: the whole block moves one indent width. */
const indentBlock: Command = ({ state, dispatch }) => {
  const block = blockAt(state)
  if (!block) return false
  dispatch(shift(state, block, getIndentUnit(state), 'input.indent'))
  return true
}

/** Shift-Tab on such a line: the block moves out one indent width. */
const outdentBlock: Command = ({ state, dispatch }) => {
  const block = blockAt(state)
  if (!block || block.indent === 0) return false
  dispatch(shift(state, block, -getIndentUnit(state), 'delete.dedent'))
  return true
}

/** The line the caret is on when it heads a run of deeper lines, or null. A selection is
 *  left to `indentMore`, and a line with nothing under it to the general Tab. */
function blockAt(state: EditorState): { line: Line; indent: number; last: Line } | null {
  const range = state.selection.main
  if (!range.empty) return null
  const line = state.doc.lineAt(range.from)
  if (line.text.trim() === '') return null
  const indent = indentOf(line.text)
  const last = runUnder(state, line, indent)
  return last.number === line.number ? null : { line, indent, last }
}

/** The last line of the block `line` heads: the deepest run below it, blanks
 *  included while something deeper follows. `collectLines`' rule, one scale down. */
function runUnder(state: EditorState, line: Line, indent: number): Line {
  let last = line
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const next = state.doc.line(n)
    if (next.text.trim() === '') continue
    if (indentOf(next.text) <= indent) break
    last = next
  }
  return last
}

/**
 * Every line of the block moved by `delta` spaces — which is all either command
 * does, and the only edit that moves a marker without touching its text.
 *
 * A **delta** and not a column, so the lines under the first keep their offsets and
 * the nesting inside the block survives. Clamped at zero per line: outdenting a
 * block whose first line has room to move but whose deepest child does not must not
 * push that child's text off the front of the line.
 */
const shift = (
  state: EditorState,
  item: { line: Line; indent: number; last: Line },
  delta: number,
  userEvent: string
) => {
  const changes = []
  for (let n = item.line.number; n <= item.last.number; n++) {
    const line = state.doc.line(n)
    if (line.text.trim() === '') continue
    const was = indentOf(line.text)
    const next = Math.max(0, was + delta)
    if (next === was) continue
    changes.push({ from: line.from, to: line.from + was, insert: ' '.repeat(next) })
  }
  return state.update({ changes, userEvent })
}

/** A list line: its indent, then a bullet or a number with its `.` or `)`, the space
 *  after it, and a task's box if it has one. */
const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(\[.\][ \t]+)?/

/**
 * Enter, for a note written as plain indented lines:
 *
 * - on a list line, the next line starts with the same indent and marker (the next
 *   number for a numbered one, an empty box for a task);
 * - on an empty item, the marker goes and the indent stays;
 * - on an empty indented line, the line moves out one indent width;
 * - on any other indented line, the next line keeps the indent;
 * - before a line's text, a blank line opens above it.
 *
 * A line with no indent and no marker is left to markdown's Enter.
 */
export const continueIndent: Command = ({ state, dispatch }) => {
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  const lead = line.text.slice(0, indentOf(line.text))
  const item = LIST_ITEM.exec(line.text)
  const write = (from: number, to: number, insert: string) => {
    dispatch(
      state.update({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        userEvent: 'input',
        scrollIntoView: true,
      })
    )
    return true
  }
  if (!item && !lead) return false
  if (item && line.text === item[0]) return write(line.from, line.to, lead)
  if (line.text === lead) return write(line.from, line.to, lead.slice(0, Math.max(0, lead.length - getIndentUnit(state))))
  if (range.head < line.from + (item ? item[0].length : lead.length)) return write(line.from, line.from, '\n')
  const marker = item ? (item[2] ?? `${Number(item[3]) + 1}${item[4]}`) + item[5] + (item[6] ? '[ ] ' : '') : ''
  return write(range.head, range.head, `\n${lead}${marker}`)
}

export const formatKeymap = [
  // Ahead of the markdown keymap, whose Enter follows the list the line is in.
  { key: 'Enter', run: continueIndent },
  // Ahead of the host's Tab: a line with lines under it moves with them.
  { key: 'Tab', run: indentBlock },
  { key: 'Shift-Tab', run: outdentBlock },
  { key: 'Mod-b', run: toggleMarker('**') },
  // `*`, not `_`: one asterisk is italic and two are bold, so the two shortcuts
  // and the two keystrokes all speak the same marker.
  { key: 'Mod-i', run: toggleMarker('*') },
  { key: 'Mod-e', run: toggleMarker('`') },
  // `[` over a selection wraps it instead of replacing it, and leaves the caret
  // inside the brackets — which is what the `[[` completion below reads, so the
  // picker opens on the word already filtered. With no selection it returns false
  // and a plain `[` types, which is the only reason this can own a bare character.
  { key: '[', run: wrapInWikiLink },
  // The other half of that: the second `[` writes `[]]`, so Backspace between the
  // pairs takes what one keystroke made.
  { key: 'Backspace', run: deleteWikiLinkPair },
  // A second press wraps again: one `*` is italic, two are bold, and `~` twice is
  // `~~struck~~` — GFM for the last one, since CommonMark has no strikethrough.
  { key: '*', run: wrapWith('*') },
  { key: '~', run: wrapWith('~') },
  { key: '`', run: wrapWith('`') },
]

/**
 * Wrap the selection in `mark`, keeping the selection over the word.
 *
 * Keeping it is the point: pressing the key again wraps a second layer, so `*`
 * twice gives `**bold**` and `~` twice gives `~~struck~~` — the markers appear at
 * both ends and stay editable, which is what a markdown document should do.
 * Removing them is ⌘B / ⌘I / ⌘E, which toggle, exactly as Obsidian does it.
 *
 * With no selection it declines, and the character types normally. That is the only
 * reason a command may own a bare key.
 */
export function wrapWith(mark: string): Command {
  return (view) => {
    const { from, to } = view.state.selection.main
    if (from === to) return false
    view.dispatch(
      view.state.update({
        changes: [
          { from, to: from, insert: mark },
          { from: to, to, insert: mark },
        ],
        selection: { anchor: from + mark.length, head: to + mark.length },
        scrollIntoView: true,
      })
    )
    return true
  }
}

/**
 * **Backspace between `[[` and `]]` takes all four.**
 *
 * The second `[` writes `[]]` and puts the caret in the middle — one keystroke,
 * four characters — so one Backspace should undo it. Without this the `[[` went and
 * the `]]` stayed, sitting in the sentence as punctuation nobody typed. Reported
 * that way. This is what `closeBrackets` does for the pairs it owns; these are the
 * app's own, so the pairing is the app's to undo.
 *
 * Only with the caret exactly between them and nothing selected: `[[note|]]` is a
 * Backspace on `e`, which is the ordinary one.
 */
export function deleteWikiLinkPair(view: EditorView): boolean {
  const { from, to } = view.state.selection.main
  if (from !== to) return false
  if (view.state.sliceDoc(from - 2, from) !== '[[') return false
  if (view.state.sliceDoc(to, to + 2) !== ']]') return false
  view.dispatch(
    view.state.update({
      changes: { from: from - 2, to: to + 2 },
      selection: { anchor: from - 2 },
      scrollIntoView: true,
    })
  )
  return true
}

export function wrapInWikiLink(view: EditorView): boolean {
  const { from, to } = view.state.selection.main

  // Nothing selected: the *second* `[` closes the pair, as Obsidian does — `[[]]`
  // with the caret in the middle, so the picker opens and a name typed into it
  // never leaves two brackets to type by hand. The first `[` is left alone; a
  // bracket is ordinary punctuation until it is doubled.
  if (from === to) {
    if (from === 0 || view.state.sliceDoc(from - 1, from) !== '[') return false
    view.dispatch(
      view.state.update({
        changes: { from, insert: '[]]' },
        selection: { anchor: from + 1 },
        scrollIntoView: true,
      })
    )
    return true
  }

  const before = from > 0 ? view.state.sliceDoc(from - 1, from) : ''
  const after = to < view.state.doc.length ? view.state.sliceDoc(to, to + 1) : ''

  // The second bracket is what makes a wikilink, as in Obsidian: one `[` gives
  // `[word]`, and pressing it again over the same word gives `[[word]]`. So this
  // only becomes a link when the selection is *already* bracketed.
  if (before === '[' && after === ']') {
    view.dispatch(
      view.state.update({
        changes: [
          { from: from - 1, to: from, insert: '[[' },
          { from: to, to: to + 1, insert: ']]' },
        ],
        // Caret inside, right after the word — which is what the `[[` completion
        // source reads, so the picker opens on it already filtered.
        selection: { anchor: to + 1 },
        scrollIntoView: true,
      })
    )
    return true
  }

  // The first bracket wraps and *keeps the selection*, so a second press can see
  // it and complete the pair.
  view.dispatch(
    view.state.update({
      changes: [
        { from, to: from, insert: '[' },
        { from: to, to, insert: ']' },
      ],
      selection: { anchor: from + 1, head: to + 1 },
      scrollIntoView: true,
    })
  )
  return true
}

/**
 * The configurable insert-timestamp key, as a keymap entry.
 *
 * `any` rather than a `key`, because the combo is a *setting*: the binding is read
 * from a getter on every keypress, so a rebind in the settings panel takes effect
 * without remounting the editor. `cmKey` and `keyNameOf` are the two halves of
 * comparing this app's own `mod+shift+t` spelling with what the browser reports.
 */
export function insertTimeKeymap(insertTime: () => string | null) {
  return {
    any: (view: EditorView, event: KeyboardEvent) => {
      const combo = insertTime()
      if (!combo) return false
      const want = cmKey(combo)
      if (!want || keyNameOf(event) !== want) return false
      const at = view.state.selection.main
      // The space is part of the stamp. `LEADING_CLOCK` wants whitespace or the line
      // end after the time, so a caret left tight against it turns `09:41` into
      // `09:41w` on the next keystroke and the accent goes out.
      const stamp = `${localTimeStamp()} `
      // And the caret is placed rather than mapped: an insertion *at* the caret
      // maps it to the front of what was inserted, which left every timestamp
      // typed in behind the time it had just written.
      view.dispatch({
        changes: { from: at.from, to: at.to, insert: stamp },
        selection: { anchor: at.from + stamp.length },
        scrollIntoView: true,
      })
      return true
    },
  }
}

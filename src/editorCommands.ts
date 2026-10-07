// The editor's keys that write markdown syntax. Each is an edit to the
// text, never a mode: ⌘B types `**`, and deleting the `**` unbolds.

import { EditorSelection, type EditorState, type Line } from '@codemirror/state'
import { EditorView, type Command } from '@codemirror/view'
import { getIndentUnit } from '@codemirror/language'
import { localTimeStamp } from './clock'
import { indentOf } from './prose'

/**
 * Wrap the selection in `marker`, or unwrap it if it is already wrapped.
 *
 * The markers may be outside the selection (⌘B twice leaves the word selected between
 * them) or inside it (the owner selected `**word**`). Both unwrap, so the command can
 * undo itself. An empty selection gets `****` with the caret in the middle.
 *
 * `changeByRange` maps the selection through the edit, so the
 * caret does not land inside a marker.
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
    // `userEvent: 'input'`, so history counts it as typing and
    // one ⌘Z removes both markers.
    dispatch(state.update(spec, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

/**
 * Tab on a line with lines nested under it: the whole block moves in one indent width.
 */
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

/**
 * The caret's line when deeper lines sit under it, or null. A selection
 * goes to `indentMore`, and a line with nothing under it to the plain Tab.
 */
function blockAt(state: EditorState): { line: Line; indent: number; last: Line } | null {
  const range = state.selection.main
  if (!range.empty) return null
  const line = state.doc.lineAt(range.from)
  if (line.text.trim() === '') return null
  const indent = indentOf(line.text)
  const last = runUnder(state, line, indent)
  return last.number === line.number ? null : { line, indent, last }
}

/**
 * The last line of the block `line` heads: the run of deeper lines
 * below it, blank lines included while something deeper follows.
 */
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
 * Move every line of the block by `delta` spaces. A delta, not a
 * column, so the nesting inside the block is kept. Clamped at
 * zero per line, so outdenting never cuts into a child's text.
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

/**
 * A list line: its indent, a bullet or a number with `.` or `)`,
 * the space after it, and a task box if it has one.
 */
export const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(\[.\][ \t]+)?/

/**
 * Enter on plain indented lines and list lines:
 *
 * - on a list line, the next line gets the same indent and
 *   marker (the next number, or an empty box for a task);
 * - on an empty item, the marker goes and the indent stays;
 * - on an empty indented line, the line moves out one indent width;
 * - on any other indented line, the next line keeps the indent;
 * - before a line's text, a blank line opens above it;
 * - on a plain line, a plain new line.
 *
 * Only a quote line is left to markdown's Enter, which continues the `>`. On a plain
 * line under a task it took the line for an empty item and deleted it, when the line
 * was shorter than the task's marker.
 */
export const continueIndent: Command = ({ state, dispatch }) => {
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  const lead = line.text.slice(0, indentOf(line.text))
  const item = LIST_ITEM.exec(line.text)
  const write = (from: number, to: number, insert: string) => {
    const changes = state.changes({ from, to, insert })
    // Mapped, not counted: a line break is one position however the file spells it.
    dispatch(state.update({ changes, selection: { anchor: changes.mapPos(to, 1) }, userEvent: 'input', scrollIntoView: true }))
    return true
  }
  // The file's own line break: in a CRLF file a bare `\n` is a stray character.
  const br = state.lineBreak
  if (!item && !lead) return /^>/.test(line.text) ? false : write(range.head, range.head, br)
  if (item && line.text === item[0]) return write(line.from, line.to, lead)
  if (line.text === lead) return write(line.from, line.to, lead.slice(0, Math.max(0, lead.length - getIndentUnit(state))))
  if (range.head < line.from + (item ? item[0].length : lead.length)) return write(line.from, line.from, br)
  const marker = item ? (item[2] ?? `${Number(item[3]) + 1}${item[4]}`) + item[5] + (item[6] ? '[ ] ' : '') : ''
  return write(range.head, range.head, `${br}${lead}${marker}`)
}

export const formatKeymap = [
  // Before markdown's Enter, which would continue a list its own way.
  { key: 'Enter', run: continueIndent },
  // Before the host's Tab, so a line moves with the lines under it.
  { key: 'Tab', run: indentBlock },
  { key: 'Shift-Tab', run: outdentBlock },
  { key: 'Mod-b', run: toggleMarker('**') },
  // `*`, not `_`: one is italic and two are bold, so the
  // shortcuts and the keys use the same marker.
  { key: 'Mod-i', run: toggleMarker('*') },
  { key: 'Mod-e', run: toggleMarker('`') },
  // `[` over a selection wraps it and leaves the caret inside, so the `[[` popup opens
  // already filtered. With no selection it returns false and `[` types normally.
  { key: '[', run: wrapInWikiLink },
  // The second `[` writes `[]]`, so Backspace between the pairs
  // removes what one key made.
  { key: 'Backspace', run: deleteWikiLinkPair },
  // Press again to wrap again: `*` twice is bold, `~` twice is `~~struck~~`.
  { key: '*', run: wrapWith('*') },
  { key: '~', run: wrapWith('~') },
  { key: '`', run: wrapWith('`') },
]

/**
 * A `KeyboardEvent` in the same form `cmKey` gives, so the two can be compared. Not
 * `matchesCombo`: `shortcuts.ts` reads `formatKeymap` from here, and importing back
 * left that list undefined as the modules loaded.
 */
function keyNameOf(event: KeyboardEvent): string {
  const mods: string[] = []
  if (event.metaKey) mods.push('Mod')
  if (event.ctrlKey) mods.push('Ctrl')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  return [...mods, event.key.toLowerCase()].join('-')
}

/**
 * The app's combo form to CodeMirror's: `mod+shift+t` to
 * `Mod-Shift-t`, modifiers in that order.
 */
function cmKey(combo: string): string | null {
  const parts = combo.toLowerCase().split('+')
  const key = parts.pop()
  if (!key) return null
  const order = ['mod', 'ctrl', 'alt', 'shift']
  const mods = order.filter((m) => parts.includes(m)).map((m) => (m === 'mod' ? 'Mod' : m[0].toUpperCase() + m.slice(1)))
  return [...mods, key].join('-')
}

/**
 * Wrap the selection in `open` and `close` and keep it selected, so a second press
 * wraps again: `*` twice gives `**bold**`, `~` twice gives
 * `~~struck~~`. ⌘B, ⌘I and ⌘E toggle, as in Obsidian.
 *
 * With no selection it does nothing and the key types normally.
 * Only then may a command take a bare key.
 */
export function wrapWith(open: string, close = open): Command {
  return (view) => {
    const { from, to } = view.state.selection.main
    if (from === to) return false
    view.dispatch(
      view.state.update({
        changes: [
          { from, insert: open },
          { from: to, insert: close },
        ],
        selection: { anchor: from + open.length, head: to + open.length },
        scrollIntoView: true,
      })
    )
    return true
  }
}

/**
 * Backspace between `[[` and `]]` removes all four.
 *
 * The second `[` writes four characters in one key, so one Backspace
 * should undo it. Without this the `]]` stayed behind in the sentence.
 * Only with the caret exactly between them and nothing selected.
 */
export function deleteWikiLinkPair(view: EditorView): boolean {
  const { from, to } = view.state.selection.main
  if (from !== to) return false
  if (view.state.sliceDoc(from - 2, from) !== '[[') return false
  if (view.state.sliceDoc(to, to + 2) !== ']]') return false
  view.dispatch(view.state.update({ changes: { from: from - 2, to: to + 2 }, selection: { anchor: from - 2 }, scrollIntoView: true }))
  return true
}

export function wrapInWikiLink(view: EditorView): boolean {
  const { from, to } = view.state.selection.main

  // With nothing selected, the second `[` closes the pair as `[[]]` with the caret
  // in the middle, so the popup opens. A single `[` is ordinary punctuation.
  if (from === to) {
    if (from === 0 || view.state.sliceDoc(from - 1, from) !== '[') return false
    view.dispatch(view.state.update({ changes: { from, insert: '[]]' }, selection: { anchor: from + 1 }, scrollIntoView: true }))
    return true
  }

  const before = from > 0 ? view.state.sliceDoc(from - 1, from) : ''
  const after = to < view.state.doc.length ? view.state.sliceDoc(to, to + 1) : ''

  // Over a selection already in brackets, `[` makes it a link:
  // `[word]` becomes `[[word]]`.
  if (before === '[' && after === ']') {
    view.dispatch(
      view.state.update({
        changes: [
          { from: from - 1, to: from, insert: '[[' },
          { from: to, to: to + 1, insert: ']]' },
        ],
        // Caret right after the word, so the `[[` popup opens filtered on it.
        selection: { anchor: to + 1 },
        scrollIntoView: true,
      })
    )
    return true
  }

  // The first bracket wraps and keeps the selection, so a second
  // press can make the link.
  return wrapWith('[', ']')(view)
}

/**
 * The insert-timestamp key as a keymap entry. `any` rather than `key`, because the
 * combo is a setting read on each key press: a rebind works without a remount.
 */
export function insertTimeKeymap(insertTime: () => string | null) {
  return {
    any: (view: EditorView, event: KeyboardEvent) => {
      const combo = insertTime()
      const want = combo && cmKey(combo)
      if (!want || keyNameOf(event) !== want) return false
      const at = view.state.selection.main
      // The space is part of the stamp. `LEADING_CLOCK` needs a space or the
      // line end after the time, or the next key turns `09:41` into `09:41w`.
      const stamp = `${localTimeStamp()} `
      // The caret is set, not mapped: an insert at the caret maps it to
      // the front, which left the caret before the time just written.
      view.dispatch({
        changes: { from: at.from, to: at.to, insert: stamp },
        selection: { anchor: at.from + stamp.length },
        scrollIntoView: true,
      })
      return true
    },
  }
}

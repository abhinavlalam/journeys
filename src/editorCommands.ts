// The editor's keys: every command that writes markdown syntax into the document.
//
// **Formatting is syntax.** ⌘B puts `**` in the document and deleting the `**` by
// hand unbolds — see `MarkdownEditor.tsx` for why that is the whole point — so
// every command here is an edit to the text and none of them is a mode.

import { EditorSelection, type EditorState, type Line } from '@codemirror/state'
import { EditorView, type Command } from '@codemirror/view'
import { getIndentUnit } from '@codemirror/language'
import { localTimeStamp } from './clock'

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

/**
 * A list line, and where the item's own text starts.
 *
 * `LIST_LINE` is markdown's marker: a bullet or `1.`/`1)`, then the space that ends
 * it. The whole match's length is the item's **content column**, which is the one
 * number CommonMark nesting is expressed in — a child's marker sits at the
 * parent's content column, and **at most three spaces past it**, or the line stops
 * being a list and becomes an indented code block.
 */
const LIST_LINE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/

function contentColumn(text: string): number | null {
  const found = LIST_LINE.exec(text)
  return found ? found[0].length : null
}

function indentOf(text: string): number {
  const at = text.search(/\S/)
  return at < 0 ? text.length : at
}

/**
 * **Tab inside a list nests the item; the indent setting has nothing to say about
 * it.** A child's marker goes at the previous item's content column, which is
 * markdown's rule and the only depth that stays a list.
 *
 * `indentWithTab` — the general Tab — inserts one indent width, and at the
 * vault's own `indentWidth: 6` that put a child's marker six spaces past a parent
 * whose content column was two: four past the limit, so the line parsed as code
 * inside the item. It lost its bullet, and Enter from it continued nothing and
 * copied whitespace instead, which is a caret arriving at an indent nobody chose.
 *
 * Declines when the line is not an item, or when it is already as deep as the item
 * above allows — a list cannot skip a level — and the general Tab takes over.
 */
export const indentListItem: Command = ({ state, dispatch }) => {
  const item = itemAt(state)
  if (!item) return false
  for (const above of linesAbove(state, item.line)) {
    const column = contentColumn(above.text)
    // Not a list above, or a shallower item's own parent: nothing to nest under.
    if (column === null || indentOf(above.text) > item.indent) return false
    if (column <= item.indent) return false
    dispatch(shift(state, item, column - item.indent, 'input.indent'))
    return true
  }
  return false
}

/** Shift-Tab: back out to the level of the item this one sits under. */
export const outdentListItem: Command = ({ state, dispatch }) => {
  const item = itemAt(state)
  if (!item || item.indent === 0) return false
  let target = 0
  for (const above of linesAbove(state, item.line)) {
    if (contentColumn(above.text) === null) break
    const at = indentOf(above.text)
    if (at < item.indent) {
      target = at
      break
    }
  }
  dispatch(shift(state, item, target - item.indent, 'delete.dedent'))
  return true
}

/**
 * **A block is not only a list item.** Reported after the list case was fixed, and
 * the report was word for word the same: only the first line of a block indents. A
 * journal entry is the other kind of block this app has — "a line that opens with a
 * clock starts one", and `collectLines` gathers *any* line with the run nested under
 * it — and it carries no list marker, so `indentListItem` declined and the general
 * Tab moved the caret's line alone. Measured through the real keymap:
 *
 *     10:00 - Making feature-updates       ->    "  10:00 - Making feature-updates
 *           more detail                                 more detail
 *           and more                                    and more
 *
 * — the head indented and its own run left behind, which is the block pulled apart.
 *
 * So this sits between `indentListItem` and the general Tab: a **non-list** line
 * that heads a run moves with it, by one indent width, because that is what an
 * indent means outside a list. Everything else falls through — a plain line with
 * nothing under it, and any selection, are `indentMore`'s, which already handles
 * every line it is given.
 */
const indentBlock: Command = ({ state, dispatch }) => {
  const block = blockAt(state)
  if (!block) return false
  dispatch(shift(state, block, getIndentUnit(state), 'input.indent'))
  return true
}

/** Shift-Tab's half: out by one indent width, and `shift` clamps each line at 0. */
const outdentBlock: Command = ({ state, dispatch }) => {
  const block = blockAt(state)
  if (!block || block.indent === 0) return false
  dispatch(shift(state, block, -getIndentUnit(state), 'delete.dedent'))
  return true
}

/**
 * A non-list line that **heads a run**, or null.
 *
 * Three refusals, each so something else keeps working. A **selection** is
 * `indentMore`'s, which indents every line it is given; a **list item** is
 * `indentListItem`'s, whose depth is markdown's rather than the indent setting; and
 * a line with **nothing deeper under it** is an ordinary line the general Tab
 * indents on its own. What is left is exactly the case that was broken.
 */
function blockAt(state: EditorState): { line: Line; indent: number; last: Line } | null {
  const range = state.selection.main
  if (!range.empty) return null
  const line = state.doc.lineAt(range.from)
  if (line.text.trim() === '' || contentColumn(line.text) !== null) return null
  const indent = indentOf(line.text)
  const last = runUnder(state, line, indent)
  return last.number === line.number ? null : { line, indent, last }
}

/**
 * The list item Tab is about, and **every line that moves with it**.
 *
 * Reported as only the first line of a block indenting. Two ways of asking for more
 * than one line, and both were broken because this read `selection.main.head` and
 * nothing else:
 *
 * - **A selection over several lines.** Only the caret's line moved, so indenting a
 *   run of items reindented one of them and broke the list. (Whichever one the head
 *   happened to be on — measured, selecting two items and pressing Tab moved the
 *   *second*.)
 * - **An item with lines nested under it.** A list item and its children are one
 *   thing on screen: nesting the parent and leaving the children where they are
 *   turns one subtree into two siblings. The run is the same rule `collectLines`
 *   gathers a `--keyword` block with — lines deeper than the first, blanks not
 *   breaking it — so "block" means the same thing in both places.
 *
 * `first` is what the depth is decided from, because a list's rules are about where
 * a marker may sit relative to the item *above* it; the rest keep their offsets so
 * the shape inside the block survives the move.
 */
function itemAt(state: EditorState): { line: Line; indent: number; last: Line } | null {
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  if (contentColumn(line.text) === null) return null
  const indent = indentOf(line.text)
  return { line, indent, last: range.empty ? runUnder(state, line, indent) : state.doc.lineAt(range.to) }
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

/** The lines above, nearest first, **skipping blanks**: a blank line does not end
 *  a list, so it must not end the search for the item this one nests under. */
function* linesAbove(state: EditorState, from: Line): Generator<Line> {
  for (let n = from.number - 1; n >= 1; n--) {
    const above = state.doc.line(n)
    if (above.text.trim() !== '') yield above
  }
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

/**
 * **Enter keeps the indent of the line you are on.**
 *
 * Reported from the running app: Enter from a line indented six spaces put the
 * caret at three. Read out of the note's own bytes — line 17 six spaces, line 18
 * three. The lines above it were an ordered list, so the parser had that line
 * *inside* item `7.`, and `insertNewlineContinueMarkup` indents a continuation to
 * the item's content column, which for `7. ` is three. Markdown's answer, and not
 * the one a note takes: the indent is space characters the user typed, and the
 * next line starts where this one did.
 *
 * Declines on a list item's own line — there Enter continues the marker, which is
 * markdown's to do — and on a line with nothing in front of it, so a blockquote's
 * `> ` and an empty item's removal are untouched.
 */
export const continueIndent: Command = ({ state, dispatch }) => {
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  if (contentColumn(line.text) !== null) return false
  const lead = line.text.slice(0, indentOf(line.text))
  if (!lead) return false
  dispatch(
    state.update({
      changes: { from: range.head, insert: `\n${lead}` },
      selection: { anchor: range.head + 1 + lead.length },
      userEvent: 'input',
      scrollIntoView: true,
    })
  )
  return true
}

/** The keys that write syntax — Enter and Tab in a list, ⌘B/⌘I/⌘E, `[` and `<` over a
 *  selection — ahead of `defaultKeymap`, so a binding there cannot shadow them. */
export const formatKeymap = [
  // Ahead of the markdown keymap, whose Enter answers for the block the line is
  // in rather than for the line.
  { key: 'Enter', run: continueIndent },
  // Ahead of `indentWithTab`, which is the host's: inside a list the depth is
  // markdown's to define, and outside one Tab is still an indent.
  { key: 'Tab', run: indentListItem },
  { key: 'Shift-Tab', run: outdentListItem },
  // Between the list's Tab and the host's: a journal block is a block too, and its
  // run has to move with its head. Both decline unless that is the case.
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
  // `<` over a selection makes it a slot in one press — `<<word>>` — because a
  // single `<word>` is an autolink in markdown, so there is no half-way step for
  // a second press to complete. With no selection a plain `<` types.
  { key: '<', run: wrapInSlot },
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
 * `<` over a selection: the selected text becomes a slot's value, `<<value>>`, and
 * stays selected inside the brackets — so a value picked out of a sentence is
 * marked as one with a single keystroke, the way `[` makes a link. Asked for in
 * exactly those words. Both brackets at once, unlike `[`: `<word>` is an autolink
 * and never a step on the way to anything.
 */
export function wrapInSlot(view: EditorView): boolean {
  const { from, to } = view.state.selection.main
  if (from === to) return false
  view.dispatch(
    view.state.update({
      changes: [
        { from, to: from, insert: '<<' },
        { from: to, to, insert: '>>' },
      ],
      selection: { anchor: from + 2, head: to + 2 },
      scrollIntoView: true,
    })
  )
  return true
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
      // The space is part of the stamp. `STAMP` wants whitespace or the line end
      // after the time, so a caret left tight against it turns `09:41` into
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

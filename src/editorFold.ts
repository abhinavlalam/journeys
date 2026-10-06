// What folds, and the arrow that folds it.

import { EditorState } from '@codemirror/state'
import { GutterMarker, gutter } from '@codemirror/view'
import { foldEffect, foldService, foldedRanges, unfoldEffect } from '@codemirror/language'
import { chevronMarkup } from './icons'

/**
 * The range under `lineEnd` indented further than this line, or
 * null. By indent, since that is what nests here. A blank line
 * does not end a block, or one gap would split a list.
 */
function isListItem(text: string): boolean {
  return /^\s*([-*+]|\d+[.)])\s/.test(text)
}

export function indentRange(
  state: EditorState,
  lineStart: number,
  lineEnd: number
): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart)
  const indent = line.text.search(/\S/)
  if (indent < 0) return null
  const listLine = isListItem(line.text)

  let end = lineEnd
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const next = state.doc.line(n)
    if (next.text.trim() === '') continue
    const nextIndent = next.text.search(/\S/)
    // Anything indented further belongs to this line.
    if (nextIndent > indent) {
      end = next.to
      continue
    }
    // A list right after a line belongs to it too, at any level:
    // the line, then its bullets. Only for a line that is not a
    // list item, or sibling bullets would swallow each other.
    if (!listLine && nextIndent === indent && isListItem(next.text)) {
      end = next.to
      continue
    }
    break
  }
  return end > lineEnd ? { from: lineEnd, to: end } : null
}

export const indentFold = foldService.of(indentRange)

/**
 * A key never deletes what a fold hides: the fold opens instead, and the key does
 * nothing, so what was about to go is seen first. A fold is one unit to the cursor,
 * so Backspace after it, or deleting its line, took every line it hid: a heading
 * and the five lines under it went that way, unseen.
 */
export const keepFolded = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('delete') && !tr.isUserEvent('input')) return tr
  const folded = foldedRanges(tr.startState)
  const hidden: { from: number; to: number }[] = []
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (toA > fromA) folded.between(fromA, toA, (from, to) => void (fromA < to && toA > from && hidden.push({ from, to })))
  })
  return hidden.length === 0 ? tr : { effects: hidden.map((range) => unfoldEffect.of(range)) }
})

/** The fold already at this line's end, if any. */
function foldAt(state: EditorState, at: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  foldedRanges(state).between(at, at, (from, to) => {
    if (from === at) found = { from, to }
  })
  return found
}

class FoldMarker extends GutterMarker {
  // A plain field, not a constructor parameter property, which
  // `erasableSyntaxOnly` forbids.
  folded: boolean
  constructor(folded: boolean) {
    super()
    this.folded = folded
  }
  eq(other: FoldMarker) {
    return other.folded === this.folded
  }
  toDOM() {
    const span = document.createElement('span')
    // The tree's own arrow, so every open/close control looks the same.
    span.innerHTML = chevronMarkup(!this.folded)
    return span
  }
}

/**
 * The arrow a gutter line shows, or null. Takes the block's start and
 * finds its line: a folded block's `to` is the end of the fold, and
 * asking about that line made the arrow vanish where it could unfold.
 */
export function foldMarkerFor(state: EditorState, blockFrom: number): { folded: boolean } | null {
  const line = state.doc.lineAt(blockFrom)
  if (!indentRange(state, line.from, line.to)) return null
  return { folded: foldAt(state, line.to) !== null }
}

/**
 * Our own fold gutter, not `foldGutter()`. That one falls back to the syntax tree,
 * and `lang-markdown` folds any block but headings and lists, so a plain paragraph
 * offered to fold. `indentRange` shows an arrow only where something is nested.
 */
export const indentFoldGutter = gutter({
  class: 'cm-foldGutter',
  lineMarker(view, block) {
    const marker = foldMarkerFor(view.state, block.from)
    return marker ? new FoldMarker(marker.folded) : null
  },
  initialSpacer: () => new FoldMarker(false),
  domEventHandlers: {
    click(view, block) {
      // The block's own line; see `foldMarkerFor`.
      const line = view.state.doc.lineAt(block.from)
      const range = indentRange(view.state, line.from, line.to)
      if (!range) return false
      const folded = foldAt(view.state, line.to)
      view.dispatch({ effects: folded ? unfoldEffect.of(folded) : foldEffect.of(range) })
      return true
    },
  },
})

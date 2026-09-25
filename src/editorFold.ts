// What folds, and the arrow that folds it.
//
// Our own gutter rather than `foldGutter()` from `@codemirror/language`: that one
// asks `foldable()`, which falls back to the syntax tree when no fold service
// answers, and `lang-markdown` folds **any block except headings and lists** — so a
// three-line paragraph offered to fold from its first line to its last. Asking
// `indentRange` directly means an arrow appears only where something is nested.

import type { EditorState } from '@codemirror/state'
import { GutterMarker, gutter } from '@codemirror/view'
import { foldEffect, foldService, foldedRanges, unfoldEffect } from '@codemirror/language'
import { chevronMarkup } from './icons'

/**
 * The range under `lineEnd` that is indented further than this line, or null.
 *
 * Indentation, because that is what nests here — a sub-bullet, a wrapped paragraph
 * under an item. A blank line does not close a block, or one gap inside a list
 * would split it in two.
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
    // And a list that *follows* a line belongs to it too, level or not — a note
    // reads as "the line, then its bullets", which is the shape being collapsed.
    // Only for a non-list line, or sibling bullets would swallow each other.
    if (!listLine && nextIndent === indent && isListItem(next.text)) {
      end = next.to
      continue
    }
    break
  }
  return end > lineEnd ? { from: lineEnd, to: end } : null
}

export const indentFold = foldService.of(indentRange)

/** The fold already sitting at this line's end, if there is one. */
function foldAt(state: EditorState, at: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  foldedRanges(state).between(at, at, (from, to) => {
    if (from === at) found = { from, to }
  })
  return found
}

class FoldMarker extends GutterMarker {
  // A plain field, not a constructor parameter property: `erasableSyntaxOnly` is on
  // in this project's tsconfig, and that syntax is not erasable.
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
    // The tree's own arrow, not `›` and `⌄` from the reading face: the same glyph
    // at the same weight, wherever the app offers to open or shut something.
    span.innerHTML = chevronMarkup(!this.folded)
    return span
  }
}

/**
 * The arrow one line of the gutter should show, or null for none.
 *
 * Takes the **start** of the block and finds its line itself, which is the whole of
 * a bug: once a range is folded, the block that begins at the fold reaches to the
 * end of everything it swallowed. Handing that `to` to `indentRange` asked "is
 * anything nested under the *last* line of this fold" — usually nothing — so the
 * arrow vanished on exactly the line that could unfold it.
 */
export function foldMarkerFor(state: EditorState, blockFrom: number): { folded: boolean } | null {
  const line = state.doc.lineAt(blockFrom)
  if (!indentRange(state, line.from, line.to)) return null
  return { folded: foldAt(state, line.to) !== null }
}

/**
 * Our own fold gutter, rather than `foldGutter()` from `@codemirror/language`.
 *
 * That one asks `foldable()`, which falls back to the syntax tree when no fold
 * service answers — and `lang-markdown` folds **any block except headings and
 * lists**, so a multi-line paragraph offered to fold from its first line to its
 * last. That is the "collapses lines that are not indented" bug: the arrow was the
 * tree's, not ours. Asking `indentRange` directly means an arrow appears only where
 * something is actually nested.
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
      // The block's own line, for the reason `foldMarkerFor` explains: a folded
      // block's `to` is the end of everything under it.
      const line = view.state.doc.lineAt(block.from)
      const range = indentRange(view.state, line.from, line.to)
      if (!range) return false
      const folded = foldAt(view.state, line.to)
      view.dispatch({ effects: folded ? unfoldEffect.of(folded) : foldEffect.of(range) })
      return true
    },
  },
})

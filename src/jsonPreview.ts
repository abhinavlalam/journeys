// Colour for a JSON file: what each token is, and how deep the brackets are.
//
// A scan, not a grammar. JSON is strings, numbers, three keywords and five punctuation
// marks, so one regex reads it, as the markdown pane builds its own decorations.
//
// Pure: a state and a span in, decorations out, so a test can
// read the marks without a layout.

import { Decoration, type DecorationSet } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import type { Range } from '@codemirror/state'
import { decorated } from './EditorHost'

/**
 * Every JSON token in one pattern. Strings come first with their escapes,
 * so a `"` or `:` inside a string neither ends it nor makes it a key.
 */
const TOKEN = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]]/g

/** How many bracket colours before they repeat. */
const DEPTHS = 3

const MARK = {
  key: Decoration.mark({ class: 'cm-json-key' }),
  /**
   * The pair the caret is on, and a bracket with no pair. Separate marks over the same
   * range as the depth mark, so a pair is highlighted and keeps its depth colour.
   */
  match: Decoration.mark({ class: 'cm-json-match' }),
  unmatched: Decoration.mark({ class: 'cm-json-unmatched' }),
  string: Decoration.mark({ class: 'cm-json-string' }),
  number: Decoration.mark({ class: 'cm-json-number' }),
  atom: Decoration.mark({ class: 'cm-json-atom' }),
  bracket: Array.from({ length: DEPTHS }, (_, depth) =>
    Decoration.mark({ class: `cm-json-bracket cm-json-depth-${depth}` })
  ),
}

/**
 * The marks for `[from, to)`. The scan starts at the top of the document, since
 * a bracket's colour is its depth. Only tokens that reach `from` are marked.
 * Config files are small; for a large one, keep the depth at each line.
 */
export function jsonDecorations(state: EditorState, from: number, to: number): DecorationSet {
  const text = state.doc.sliceString(0, to)
  const found: Range<Decoration>[] = []
  /**
   * Every bracket the scan passed, in order. The caret's pair is read from this, so a
   * brace inside a string is never one. CodeMirror's `bracketMatching` counts
   * characters, and with no grammar one brace in a value shifts every pair after it.
   */
  const brackets: { at: number; char: string }[] = []
  let depth = 0

  TOKEN.lastIndex = 0
  for (let hit = TOKEN.exec(text); hit; hit = TOKEN.exec(text)) {
    const start = hit.index
    const end = start + hit[0].length
    const token = hit[0]

    // A closing bracket takes the depth it closed, so a pair is one colour.
    if (token === '}' || token === ']') depth = Math.max(0, depth - 1)
    const mark = markFor(token, text, end, depth)
    if (token === '{' || token === '[') depth += 1
    if (token.length === 1 && PARTNER[token]) brackets.push({ at: start, char: token })

    if (end > from && mark) found.push(mark.range(start, end))
  }

  for (const at of pairForCaret(brackets, state)) {
    if (at.to > from) found.push((at.matched ? MARK.match : MARK.unmatched).range(at.from, at.to))
  }
  return Decoration.set(found, true)
}

/**
 * Each bracket's other half, both ways, which also says whether
 * a character is a bracket.
 */
const PARTNER: Record<string, string> = { '{': '}', '}': '{', '[': ']', ']': '[' }
const OPENERS = '{['

/**
 * The bracket the caret is on and its partner, or nothing. On means either
 * side, as in CodeMirror. Only with a caret; a selection highlights nothing.
 */
function pairForCaret(
  brackets: readonly { at: number; char: string }[],
  state: EditorState
): { from: number; to: number; matched: boolean }[] {
  const caret = state.selection.main
  if (!caret.empty) return []

  const index = brackets.findIndex(
    (bracket) => bracket.at === caret.head || bracket.at === caret.head - 1
  )
  if (index === -1) return []

  const here = brackets[index]
  const step = OPENERS.includes(here.char) ? 1 : -1
  const wanted = PARTNER[here.char]
  let depth = 0
  for (let at = index + step; at >= 0 && at < brackets.length; at += step) {
    const char = brackets[at].char
    if (char === here.char) depth += 1
    else if (char === wanted) {
      if (depth === 0) {
        return [
          { from: here.at, to: here.at + 1, matched: true },
          { from: brackets[at].at, to: brackets[at].at + 1, matched: true },
        ]
      }
      depth -= 1
    }
    // A bracket of the other kind is skipped: in `{ "a": [1] }`
    // the braces pair whatever the array does.
  }
  // Nothing closed it: an unbalanced file, which Save will refuse.
  return [{ from: here.at, to: here.at + 1, matched: false }]
}


function markFor(token: string, text: string, end: number, depth: number): Decoration | null {
  if (token === '{' || token === '}' || token === '[' || token === ']') {
    return MARK.bracket[depth % DEPTHS]
  }
  if (token === 'true' || token === 'false' || token === 'null') return MARK.atom
  if (token.startsWith('"')) {
    // A string followed by a colon is a name.
    return /^\s*:/.test(text.slice(end)) ? MARK.key : MARK.string
  }
  return MARK.number
}

/**
 * The selection is in `decorated`'s redraw list, since the caret's bracket pair
 * is drawn. Nothing here hides or shows as the caret moves; it only highlights.
 */
export const jsonPreview = decorated(jsonDecorations)

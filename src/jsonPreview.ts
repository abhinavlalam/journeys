// Colour for a JSON file: what each token is, and how deep the brackets are.
//
// **A scan, not a grammar.** `@codemirror/lang-json` would bring a real parser and
// a highlight style, and it would also bring a package for a job JSON makes easy:
// its tokens are strings, numbers, three keywords and five punctuation marks, and
// one regex reads all of them. The markdown pane hand-rolls its decorations for the
// same reason, so this is the shape the app already has. What a grammar would add
// on top is bracket *matching* and a parse error before you press Save.
//
// **Pure**: a state and a span in, decorations out — which is what lets a test hand
// it a whole document and read the marks back, without a layout.

import { Decoration, type DecorationSet } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import type { Range } from '@codemirror/state'
import { decorated } from './EditorHost'

/**
 * Every JSON token in one pattern, in the order that resolves them.
 *
 * The string case comes first and carries its own escapes — `[^"\\]|\\.` — so a
 * `"` inside a string cannot end it and a `:` inside one cannot make it a key.
 * Numbers before keywords is arbitrary; they cannot overlap.
 */
const TOKEN = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]]/g

/** How many bracket colours there are before the cycle repeats. */
const DEPTHS = 3

const MARK = {
  key: Decoration.mark({ class: 'cm-json-key' }),
  /** The pair the caret is on, and a bracket that has no pair. Separate marks over
   *  the same range as the depth mark below, which is what lets the pair be
   *  highlighted without losing what depth it sits at. */
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
 * The marks for `[from, to)`.
 *
 * Tokenising starts at the **top of the document** rather than at `from`, because
 * a bracket's colour is its nesting depth and depth is not visible in a span taken
 * out of the middle. Only tokens that reach `from` are marked. A config file is
 * small; if this ever meets a large one, the fix is to remember the depth at each
 * line rather than to colour a bracket wrongly.
 */
export function jsonDecorations(state: EditorState, from: number, to: number): DecorationSet {
  const text = state.doc.sliceString(0, to)
  const found: Range<Decoration>[] = []
  /** Every bracket the scan passed, in order: what and where. The pair for the
   *  caret is read off this, so a brace *inside a string* can never be one — the
   *  scan never offered it. `bracketMatching` from `@codemirror/language` counts
   *  characters instead, and with no grammar to tell it what a string is, one brace
   *  in a value shifts every pair after it. */
  const brackets: { at: number; char: string }[] = []
  let depth = 0

  TOKEN.lastIndex = 0
  for (let hit = TOKEN.exec(text); hit; hit = TOKEN.exec(text)) {
    const start = hit.index
    const end = start + hit[0].length
    const token = hit[0]

    // Closing brackets take the depth they closed, so a pair is one colour.
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

/** Each bracket's other half, both ways round — which is also the test for "is
 *  this character a bracket at all". */
const PARTNER: Record<string, string> = { '{': '}', '}': '{', '[': ']', ']': '[' }
const OPENERS = '{['

/**
 * The bracket the caret is on and its partner, or nothing.
 *
 * "On" means either side of the character, which is CodeMirror's own convention and
 * the only one that works: a caret sits *between* characters, so a caret after `}`
 * is as much on it as one before it. A cursor, not a range — highlighting a pair
 * while text is selected says something about the selection that is not true.
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
    // A bracket of the *other* kind is skipped: `{ "a": [1] }` has the object's
    // braces as a pair whatever the array between them does.
  }
  // Nothing closed it. Worth saying: an unbalanced file is one Save will refuse.
  return [{ from: here.at, to: here.at + 1, matched: false }]
}


function markFor(token: string, text: string, end: number, depth: number): Decoration | null {
  if (token === '{' || token === '}' || token === '[' || token === ']') {
    return MARK.bracket[depth % DEPTHS]
  }
  if (token === 'true' || token === 'false' || token === 'null') return MARK.atom
  if (token.startsWith('"')) {
    // A string is a **name** when a colon follows it: the one distinction JSON
    // draws between the two halves of a property, and the same distinction the
    // frontmatter block draws in a note.
    return /^\s*:/.test(text.slice(end)) ? MARK.key : MARK.string
  }
  return MARK.number
}

/** The selection is in `decorated`'s redraw list, which this needs: the bracket
 *  pair under the caret is part of what is drawn. Nothing here hides or reveals as
 *  the caret moves — that is markdown's bargain with its markers; this only
 *  highlights. */
export const jsonPreview = decorated(jsonDecorations)

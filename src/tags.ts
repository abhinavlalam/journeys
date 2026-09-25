// Tags: `#word` written into a note's prose.
//
// The third thing a note's text declares about itself, beside a `--keyword` on a
// line and a `key:` in its block — and the one with no file anywhere. A tag exists
// because a note carries it, which is the arrangement Properties already has: the
// pane lists what the notes say and the row opens a page asking the notes back.

import { gatherLines, proseLines, type CollectedLine } from './actions'

/**
 * A tag is `#` and a word, and **the guards are most of the definition**.
 *
 * - `(^|\s)` in front, so `abc#def` is not one, and neither is the `#anchor` of a
 *   URL or of `[[Note#Heading]]`. The same guard `OPENER` uses, for the same
 *   reason: a mark in the middle of a word is somebody's text.
 * - **No space after the `#`**, which is exactly what separates a tag from a
 *   heading: `# Plans` is a heading and `#plans` is a tag, and CommonMark agrees —
 *   a heading *requires* the space, so `#Plans` was never one. `##` is not matched
 *   because `#` is not a tag character, so every heading level is safe.
 * - **At least one letter.** `#2026` is a number somebody wrote, not a tag, and
 *   Obsidian draws the line in the same place.
 *
 * `/` is a tag character, so `#todo/urgent` is one tag and nests the way Obsidian's
 * do. `-` and `_` are the two word separators a tag is written with.
 */
export const TAG = /(^|\s)#([\w/-]*[A-Za-z][\w/-]*)/g

/**
 * Every tag the lines of a note carry, in the order written.
 *
 * Off `proseLines`, so a `#` inside a fence or a backtick span is not a tag — a
 * vault holds `#!/bin/sh` and `#include` in shell and C blocks, and a colour is
 * written `#ef476f`. (The last is excluded twice over: it is in code *and* it is
 * matched only if it carries a letter, which `#ef476f` does — so the mask is doing
 * real work there.)
 *
 * The names only, the arrangement `actionKeywords` and `propertyKeys` have, so the
 * list in the pane and the lines a tag's page shows cannot disagree about what
 * counts.
 *
 * **Lowercased**, and this is the one place in the app that folds a name rather
 * than keeping the first spelling it met. A property does the latter, because a
 * `key:` is a word someone chose for a block and `Status` is how they want to read
 * it back. A tag is a *label*, and `#Travel` beside `#travel` in a list of labels
 * is one label that looks like two — the case is never information, it is whatever
 * the sentence needed or the phone's keyboard did. So the list, the page and the
 * counts are all one spelling.
 *
 * **The note's own bytes are untouched.** Nothing rewrites what you typed: the
 * line still says `#Travel`, and the editor still draws it that way. This folds
 * only the name the app *shows* and gathers under.
 */
export function tagNames(raw: string): string[] {
  return proseLines(raw).flatMap((line) =>
    [...line.matchAll(TAG)].map((one) => one[2].toLowerCase())
  )
}

/** The lines carrying `#tag`, each with the run nested under it — `collectLines`'
 *  own rule, through the `gatherLines` both of them read. */
export function collectTagLines(raw: string, tag: string): CollectedLine[] {
  const want = tag.toLowerCase()
  return gatherLines(raw, (prose) =>
    [...prose.matchAll(TAG)].some((one) => one[2].toLowerCase() === want)
  )
}

/**
 * The tag at `offset` in a line, or null — so a press can open its page.
 *
 * `linkTargetAt` and `collectionAt`'s shape, read off the line's own text for the
 * same reason: the tag is not a node in any grammar the editor has.
 */
export function tagAt(line: string, offset: number): string | null {
  for (const hit of line.matchAll(TAG)) {
    // Past the leading space the guard captured, which is not part of the tag.
    const at = (hit.index ?? 0) + hit[1].length
    // Folded, as `tagNames` folds: pressing `#Travel` has to open the same page the
    // pane's `travel` row opens, or one tag has two pages.
    if (offset >= at && offset <= at + hit[2].length + 1) return hit[2].toLowerCase()
  }
  return null
}

// Tags: `#word` written into a note's prose, and the lines that carry one.
//
// A tag exists because a note carries it, which is the arrangement Properties
// already has: the pane lists what the notes say and the row opens a page asking
// the notes back. A tag has no file; its structure, if it has one, is an entry in
// `tags.json`.

import { proseLines } from './prose'
import type { Entries } from './configEntries'

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
export const TAG_NAME = String.raw`[\w/-]*[A-Za-z][\w/-]*`
export const TAG = new RegExp(String.raw`(^|\s)#(${TAG_NAME})`, 'g')

/**
 * Every tag the lines of a note carry, in the order written.
 *
 * Off `proseLines`, so a `#` inside a fence or a backtick span is not a tag — a
 * vault holds `#!/bin/sh` and `#include` in shell and C blocks, and a colour is
 * written `#ef476f`. (The last is excluded twice over: it is in code *and* it is
 * matched only if it carries a letter, which `#ef476f` does — so the mask is doing
 * real work there.)
 *
 * The names only, the arrangement `propertyKeys` has, so the
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

/** A gathered line: an entry, and what is written under it. */
export interface CollectedLine {
  /** The line itself, its own indent and trailing space off. */
  text: string
  /** The lines nested under it, in order, with **the entry's indent removed and
   *  nothing else touched**, so a page can print the nesting as it was written. */
  below: string[]
  /** 0-based line number in the note: two identical lines in one note are two. */
  at: number
}

/** A line's indent, or **-1 for a blank one**, which must not end the run below an
 *  entry and so has to be told apart from a line at indent 0. */
function indentOrBlank(line: string): number {
  return line.trim() === '' ? -1 : line.length - line.trimStart().length
}

/**
 * Every line `wanted` accepts, **with the run nested under it**: the one rule for
 * an entry and what belongs to it. `wanted` is handed the line with its code
 * masked, so a `#tag` inside a fence or a backtick span is not one; the text kept
 * is the line itself.
 *
 * The run continues while the lines are deeper than the entry's own and ends at the
 * first one back at its level — the rule the eye uses. A blank line does not break
 * it, since a nested block can hold one, and trailing blanks are dropped.
 */
export function gatherLines(raw: string, wanted: (prose: string) => boolean): CollectedLine[] {
  const lines = raw.split(/\r?\n/)
  // Masked in one pass: the run below an entry is gathered looking forward, and
  // cannot re-count fences as it goes.
  const prose = proseLines(raw)
  const found: CollectedLine[] = []
  for (let at = 0; at < lines.length; at++) {
    if (!wanted(prose[at])) continue
    const indent = indentOrBlank(lines[at])
    const below: string[] = []
    for (let next = at + 1; next < lines.length; next++) {
      const deeper = indentOrBlank(lines[next])
      if (deeper !== -1 && deeper <= indent) break
      below.push(lines[next].slice(indent).replace(/\s+$/, ''))
    }
    while (below.length > 0 && below[below.length - 1].trim() === '') below.pop()
    found.push({ text: lines[at].trim(), below, at })
  }
  return found
}

/** The lines carrying `#tag`, each with the run nested under it. */
export function collectTagLines(raw: string, tag: string): CollectedLine[] {
  const want = tag.toLowerCase()
  return gatherLines(raw, (prose) =>
    [...prose.matchAll(TAG)].some((one) => one[2].toLowerCase() === want)
  )
}

/**
 * The tag at `offset` in a line, or null — so a press can open its page.
 *
 * `linkTargetAt`'s shape, read off the line's own text for the same reason: the tag
 * is not a node in any grammar the editor has.
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

/**
 * **A tag's structure**: the properties its lines carry, one per line on its page,
 * in `.config/tags.json` — `{ "expense": { "properties": ["amount", "merchant"] } }`,
 * keyed by the tag's folded name. What each property's values are is the
 * property's own type, set on its page; a tag only says which it takes.
 */
export const TAGS_FILE = 'tags.json'

/** How a tag draws its lines — as the sentences, or as a table of their values —
 *  on its page, and later the timeline. A tag's own choice, in its entry. */
export const LINE_VIEWS = ['list', 'table'] as const
export type LineView = (typeof LINE_VIEWS)[number]

/** The tag's chosen view, or, with none chosen, a table for a tag with properties
 *  and a list for one without. */
export function viewOf(entries: Entries, tag: string): LineView {
  const chosen = entries[tag.toLowerCase()]?.view
  return LINE_VIEWS.find((one) => one === chosen) ?? (propertiesOf(entries, tag).length > 0 ? 'table' : 'list')
}

/** Every tag drawn as a table, with its structure — what a table-view entry shows
 *  as fields. */
export function tablesOf(entries: Entries): Record<string, string[]> {
  return Object.fromEntries(
    Object.keys(entries)
      .filter((tag) => viewOf(entries, tag) === 'table')
      .map((tag) => [tag.toLowerCase(), propertiesOf(entries, tag)])
  )
}

/** The properties a tag's structure names, in order; none for a tag with none. */
export function propertiesOf(entries: Entries, tag: string): string[] {
  const listed = entries[tag.toLowerCase()]?.properties
  return Array.isArray(listed) ? listed.filter((one): one is string => typeof one === 'string') : []
}

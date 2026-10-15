// Tags: `#word` in a note's prose, and the lines that carry one. A tag exists because a
// note carries it; it has no file. Its structure, if any, is an entry in `tags.json`.

import { indentOf, proseLines } from './prose'
import { oneOf, type Entries } from './configEntries'

/**
 * A tag is `#` and a word:
 *
 * - after the line start or a space, so `abc#def`, a URL's
 *   `#anchor` and `[[Note#Heading]]` are not tags;
 * - no space after the `#`, which is what makes `# Plans` a heading and `#plans` a tag;
 * - at least one letter, so `#2026` is not one.
 *
 * `/` is part of a tag, so `#todo/urgent` is one tag that nests.
 * `-` and `_` join words.
 */
export const TAG_NAME = String.raw`[\w/-]*[A-Za-z][\w/-]*`
export const TAG = new RegExp(String.raw`(^|\s)#(${TAG_NAME})`, 'g')

/**
 * Every tag on a note's lines, in order. Read off `proseLines`,
 * so `#!/bin/sh`, `#include` and `#ef476f` in code are not tags.
 *
 * Folded to lower case: the one name the app folds. `#Travel` and `#travel`
 * are one label, so the pane, the page and the counts use one spelling. The
 * note's text is never changed; the line still says `#Travel`.
 */
export function tagNames(raw: string): string[] {
  return proseLines(raw).flatMap((line) =>
    [...line.matchAll(TAG)].map((one) => one[2].toLowerCase())
  )
}

/**
 * A line of tags and nothing else. In a day it heads a group (`#diet`, its
 * entries nested under it), and it is no record of its own: in a tag's
 * table it was a row of empty cells.
 */
export const tagsOnly = (line: string) => line.trim() !== '' && line.replace(TAG, '').trim() === ''

/** A gathered line: an entry, and what is written under it. */
export interface CollectedLine {
  /** The line, without its indent or trailing space. */
  text: string
  /**
   * The lines nested under it, in order, with only the entry's
   * indent taken off, so a page can show the nesting as written.
   */
  below: string[]
  /** 0-based line number in the note, so two identical lines are two entries. */
  at: number
}

/**
 * A line's indent, or -1 for a blank line, which must not end the run under an entry.
 */
function indentOrBlank(line: string): number {
  return line.trim() === '' ? -1 : indentOf(line)
}

/**
 * Every line `wanted` accepts, with the run nested under it. `wanted`
 * gets the line with code masked; the text kept is the line itself.
 *
 * The run goes on while lines are deeper than the entry and ends at the first line
 * back at its level. A blank line does not end it; trailing blanks are dropped.
 */
function gatherLines(raw: string, wanted: (prose: string) => boolean): CollectedLine[] {
  const lines = raw.split(/\r?\n/)
  // Masked in one pass, since the run under an entry is gathered looking ahead.
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

/** The tag at `offset` in a line, or null, so a press can open its page. */
export function tagAt(line: string, offset: number): string | null {
  for (const hit of line.matchAll(TAG)) {
    // Skip the space before the tag.
    const at = (hit.index ?? 0) + hit[1].length
    // Folded, as `tagNames` does, so pressing `#Travel` opens
    // the same page as the `travel` row.
    if (offset >= at && offset <= at + hit[2].length + 1) return hit[2].toLowerCase()
  }
  return null
}

/**
 * What the app keeps about a tag, in `.config/tags.json` by folded name: its colour
 * (`{ "expense": { "color": "green" } }`). Until 2026-10-15 a tag also had a structure
 * of properties, a view and daily totals; a tracker's table does that work now.
 */
export const TAGS_FILE = 'tags.json'

/**
 * The colours a tag can take, the palette's six hues (`--hue-*`), so each follows
 * the theme. Chosen on a tag's page and kept as `color` in its `tags.json` entry.
 */
export const TAG_COLOURS = ['blue', 'green', 'amber', 'violet', 'teal', 'red'] as const
export type TagColour = (typeof TAG_COLOURS)[number]

/** Each tag's colour, for those given one. */
export function coloursOf(entries: Entries): Record<string, TagColour> {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([tag, entry]) => {
      const colour = oneOf(TAG_COLOURS, entry?.color)
      return colour ? [[tag.toLowerCase(), colour]] : []
    })
  )
}

/** How a column of numbers becomes one: a table's total under it (`CsvTable`). */
export const COMBINES = ['sum', 'average', 'count', 'min', 'max'] as const
export type Combine = (typeof COMBINES)[number]
/** How each way of combining is named: in its menu, and in a total's label. */
export const COMBINE_NAMES: Record<Combine, string> = { sum: 'Sum', average: 'Average', count: 'Count', min: 'Lowest', max: 'Highest' }

/** How a table's column of numbers is totalled under it: combined, or not at all, as a balance is. */
export const COLUMN_TOTALS = [...COMBINES, 'none'] as const
export type ColumnTotal = (typeof COLUMN_TOTALS)[number]

/** `values` combined `by` the owner's choice, or null with none to combine. */
export function combine(values: readonly number[], by: Combine): number | null {
  if (values.length === 0) return null
  if (by === 'count') return values.length
  if (by === 'min') return Math.min(...values)
  if (by === 'max') return Math.max(...values)
  const sum = values.reduce((total, one) => total + one, 0)
  return by === 'average' ? sum / values.length : sum
}


// Tags: `#word` in a note's prose, and the lines that carry one. A tag exists because a
// note carries it; it has no file. Its structure, if any, is an entry in `tags.json`.

import { indentOf, proseLines } from './prose'
import { oneOf, type Entries } from './configEntries'
import { leadingClock } from './clock'
import { blockProperties, propertyText, type PropertyType } from './properties'

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

/**
 * A tag's line from a form: the clock, the tag, the words, then each property of its
 * structure that has a value, in the structure's order and as its type reads it.
 */
export function tagLine(
  tag: string,
  properties: readonly string[],
  { clock, what, fields }: { clock: string; what: string; fields: Record<string, string> },
  typeOf: (name: string) => PropertyType
): string {
  const carried = properties.filter((name) => fields[name]?.trim())
  return [clock, `#${tag}`, what.trim(), ...carried.map((name) => propertyText(name, fields[name].trim(), typeOf(name)))]
    .filter(Boolean)
    .join(' ')
}

/**
 * A line's own words, for a tag's table: the line without its clock, its tags, its
 * `name:: value`s and a leading list mark, as the calendar reads an event's title.
 * Without them, a tag of measured things listed its amounts and not what they were
 * for, and `#task` its due dates and not the task. A line that is all properties has none.
 */
export function lineWords(line: string, typeOf: (name: string) => PropertyType): string {
  let words = ''
  let at = leadingClock(line)?.length ?? 0
  for (const one of blockProperties(line, typeOf)) {
    words += line.slice(at, one.from)
    at = one.to
  }
  return (words + line.slice(at))
    .replace(TAG, '$1')
    .replace(/^\s*(?:[-*+–—]\s+)?(?:\[.\]\s+)?/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

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
 * A tag's structure: the properties its lines carry, kept in
 * `.config/tags.json` by folded name, like `{ "expense": { "properties":
 * ["amount", "merchant"] } }`. Each property's type is set on its own page.
 */
export const TAGS_FILE = 'tags.json'

/**
 * How a tag's page and the timeline draw its lines: as sentences,
 * or as a table of their values. Kept in the tag's entry.
 */
export const LINE_VIEWS = ['list', 'table'] as const
export type LineView = (typeof LINE_VIEWS)[number]

/** The tag's chosen view. Unchosen: a table for a tag with properties, else a list. */
export function viewOf(entries: Entries, tag: string): LineView {
  const chosen = entries[tag.toLowerCase()]?.view
  return oneOf(LINE_VIEWS, chosen) ?? (propertiesOf(entries, tag).length > 0 ? 'table' : 'list')
}

/**
 * Every tag drawn as a table, with its structure: what a table entry shows as fields.
 */
export function tablesOf(entries: Entries): Record<string, string[]> {
  return Object.fromEntries(
    Object.keys(entries)
      .filter((tag) => viewOf(entries, tag) === 'table')
      .map((tag) => [tag.toLowerCase(), propertiesOf(entries, tag)])
  )
}

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

/** How a day's values of a property become one number. */
export const COMBINES = ['sum', 'average', 'count', 'min', 'max'] as const
export type Combine = (typeof COMBINES)[number]
/** How each way of combining is named: in its menu, and in a total's label. */
export const COMBINE_NAMES: Record<Combine, string> = { sum: 'Sum', average: 'Average', count: 'Count', min: 'Lowest', max: 'Highest' }

/** Where a day's total shows: the day's card in the timeline, the end of its note, or both. */
export const TOTAL_PLACES = ['both', 'timeline', 'note'] as const
export type TotalPlace = (typeof TOTAL_PLACES)[number]

/** One of a tag's daily totals: a property, how it is combined, what it is called, where it shows. */
export interface DayTotal {
  property: string
  by: Combine
  /** What the tile says under the number; empty is the property and the tag. */
  label: string
  show: TotalPlace
}

/**
 * Each tag's daily totals: `totals` in its `tags.json` entry, set on its page, each a
 * property and how it is combined, labelled and shown. Unset, the tag's `number`
 * properties, summed, however its lines are drawn: tied to the table view, switching
 * `#food` to a list took its calories off every day. A property no longer a `number`
 * drops out. Nothing is read from
 * a value but its digits: what a value means is the owner's to say here.
 */
export function dayTotalsOf(entries: Entries, typeOf: (name: string) => PropertyType): Record<string, DayTotal[]> {
  return Object.fromEntries(
    Object.keys(entries).flatMap((tag) => {
      const chosen = entries[tag]?.totals
      const listed: unknown[] = Array.isArray(chosen) ? chosen : propertiesOf(entries, tag)
      const totals = listed.flatMap((one): DayTotal[] => {
        const given = typeof one === 'string' ? { property: one } : one && typeof one === 'object' ? (one as Record<string, unknown>) : {}
        const property = typeof given.property === 'string' ? given.property : ''
        if (!property || typeOf(property) !== 'number') return []
        return [{
          property,
          by: oneOf(COMBINES, given.by) ?? 'sum',
          label: typeof given.label === 'string' ? given.label : '',
          show: oneOf(TOTAL_PLACES, given.show) ?? 'both',
        }]
      })
      return totals.length > 0 ? [[tag.toLowerCase(), totals]] : []
    })
  )
}

/** The properties a tag's structure names, in order. */
export function propertiesOf(entries: Entries, tag: string): string[] {
  const listed = entries[tag.toLowerCase()]?.properties
  return Array.isArray(listed) ? listed.filter((one): one is string => typeof one === 'string') : []
}

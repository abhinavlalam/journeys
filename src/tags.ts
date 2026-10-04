// Tags: `#word` in a note's prose, and the lines that carry one. A tag exists because a
// note carries it; it has no file. Its structure, if any, is an entry in `tags.json`.

import { indentOf, proseLines } from './prose'
import type { Entries } from './configEntries'
import { propertyText, type PropertyType } from './properties'

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
export function gatherLines(raw: string, wanted: (prose: string) => boolean): CollectedLine[] {
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
  return LINE_VIEWS.find((one) => one === chosen) ?? (propertiesOf(entries, tag).length > 0 ? 'table' : 'list')
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

/** The properties a tag's structure names, in order. */
export function propertiesOf(entries: Entries, tag: string): string[] {
  const listed = entries[tag.toLowerCase()]?.properties
  return Array.isArray(listed) ? listed.filter((one): one is string => typeof one === 'string') : []
}

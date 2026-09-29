// The timeline: the daily notes as each day happened.
//
// A daily note is written by kind — a group is a line of tags alone (`#expense`,
// `#diet`) with that kind's entries nested under it — and read here by clock: every
// entry of the day, from every group, in the order it happened. Nothing here writes;
// an entry carries the line it came from, which is what an edit writes back.

import { leadingClock, minutesOf } from './clock'
import { dayOf, isDailyNote } from './daily'
import { blockProperties, readBlock, splitPageProperties, type PropertyType } from './properties'
import { indentOf, proseLines } from './prose'
import { TAG, tagNames } from './tags'
import type { VaultFile } from './vaultModel'

export interface TimelineEntry {
  note: VaultFile
  /** 0-based line in the note: the one an edit writes back. */
  at: number
  /** The line as written, its indent off. */
  text: string
  /** The line's leading clock: a line without one is not an entry. */
  clock: string
  /** Minutes into the day it starts, and, for a block of time rather than a
   *  moment, ends: past 24 hours for a block that crosses midnight. */
  start: number
  end: number | null
  /** The group it is written under: the innermost heading's first tag. */
  group: string | null
  /** The lines nested under it, its own indent off. */
  below: string[]
}

export interface TimelineDay {
  day: string
  note: VaultFile
  entries: TimelineEntry[]
}

const DAY_MINUTES = 24 * 60

/** A line of tags and nothing else heads a group. */
const isGroupHead = (prose: string) => prose.trim() !== '' && prose.replace(TAG, '').trim() === ''

/** A group of a day's note: its heading's first tag, the heading's line and indent,
 *  and the last line of its run. */
interface Group {
  name: string
  at: number
  indent: number
  end: number
}

/**
 * A day's note read: its entries as written, and its groups.
 *
 * **An entry is a line with a clock** that is not a group's heading, and what is
 * nested under an entry is its detail, as a tag's page reads it. A line without a
 * clock is neither an entry nor a place for one — the timeline is what happened
 * when — so what is nested under it is read on its own. A heading's lines are its
 * group's however deep the headings nest; code is nobody's entry.
 */
function readDay(note: VaultFile, raw: string): { entries: TimelineEntry[]; groups: Group[] } {
  const lines = raw.split(/\r?\n/)
  const prose = proseLines(raw)
  const first = splitPageProperties(raw).prefix.split('\n').length - 1
  const entries: TimelineEntry[] = []
  const groups: Group[] = []
  const heads: Group[] = []
  let entry: { indent: number; below: string[] } | null = null
  for (let at = first; at < lines.length; at++) {
    const line = lines[at]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (entry && indent > entry.indent) {
      entry.below.push(line.slice(entry.indent).trimEnd())
      for (const head of heads) head.end = at
      continue
    }
    entry = null
    if (prose[at].trim() === '') continue
    while (heads.length > 0 && heads[heads.length - 1].indent >= indent) heads.pop()
    for (const head of heads) head.end = at
    if (isGroupHead(prose[at])) {
      const head = { name: tagNames(prose[at])[0], at, indent, end: at }
      heads.push(head)
      groups.push(head)
      continue
    }
    const text = line.trim()
    const clock = leadingClock(text)
    if (!clock) continue
    const [start, stop = null] = minutesOf(clock)
    const one: TimelineEntry = {
      note,
      at,
      text,
      clock,
      start,
      end: stop === null ? null : stop < start ? stop + DAY_MINUTES : stop,
      group: heads[heads.length - 1]?.name ?? null,
      below: [],
    }
    entries.push(one)
    entry = { indent, below: one.below }
  }
  return { entries, groups }
}

/** A day's entries in the order it happened, by when they start; a tie keeps the
 *  order written. */
export function dayEntries(note: VaultFile, raw: string): TimelineEntry[] {
  return readDay(note, raw).entries.sort((a, b) => a.start - b.start)
}

/** The group an entry is filed under when none of its tags has one. */
const TIMELINE_GROUP = 'timeline'

/**
 * A day's note with a new entry filed in it, as its owner writes a day: under the
 * group headed by one of its tags; else the group already holding an entry that
 * carries one (`#food` under `#diet`); else `#timeline`, made at the note's end when
 * it has none. It goes after the group's last line, indented as the group's own
 * lines are — or `indent` in from the heading, in a group with none — and nothing
 * else in the note moves.
 */
export function withNewEntry(note: VaultFile, raw: string, text: string, indent: string): string {
  const { entries, groups } = readDay(note, raw)
  const tags = tagNames(text)
  const carrying = entries.find((one) => one.group && tagNames(one.text).some((tag) => tags.includes(tag)))
  const group =
    groups.find((one) => tags.includes(one.name)) ??
    groups.find((one) => one.name === carrying?.group) ??
    groups.find((one) => one.name === TIMELINE_GROUP)
  if (!group) {
    const gap = raw === '' || raw.endsWith('\n\n') ? '' : raw.endsWith('\n') ? '\n' : '\n\n'
    return `${raw}${gap}#${TIMELINE_GROUP}\n${indent}${text}\n`
  }
  const lines = raw.split('\n')
  const inside = lines.slice(group.at + 1, group.end + 1).find((line) => line.trim() !== '')
  const pad = inside ? inside.slice(0, indentOf(inside)) : ' '.repeat(group.indent) + indent
  lines.splice(group.end + 1, 0, pad + text)
  return lines.join('\n')
}

/**
 * The note with an entry's line reading `text` — its indent and line ending kept,
 * and nothing else in the note touched — or null when that line is no longer the
 * entry's: the note changed since it was read, and writing would land on another.
 */
export function withEditedEntry(raw: string, entry: TimelineEntry, text: string): string | null {
  const lines = raw.split('\n')
  const line = lines[entry.at]
  if (line === undefined || line.trim() !== entry.text) return null
  const indent = line.slice(0, indentOf(line))
  lines[entry.at] = indent + text.replace(/\s+/g, ' ').trim() + (line.endsWith('\r') ? '\r' : '')
  return lines.join('\n')
}

/**
 * What an entry says past its clock. Its properties read as the note reads them —
 * names and quotes out — or, when they are drawn as fields beside it, are left out
 * of the sentence entirely.
 */
export function wordsOf(entry: TimelineEntry, typeOf: (name: string) => PropertyType, asFields: boolean): string {
  const line = entry.text.slice(entry.clock.length)
  if (!asFields) return readBlock(line, typeOf).trim()
  let out = ''
  let at = 0
  for (const one of blockProperties(line, typeOf)) {
    out += line.slice(at, one.from)
    at = one.to
  }
  return (out + line.slice(at)).replace(/\s+/g, ' ').trim()
}

/** Every daily note with anything in it, oldest first: the log reads down to today. */
export function timelineDays(notes: readonly { note: VaultFile; text: string }[], folder: string): TimelineDay[] {
  return notes
    .filter(({ note }) => isDailyNote(note.path, folder))
    .map(({ note, text }) => ({ day: dayOf(note.path), note, entries: dayEntries(note, text) }))
    .filter((one) => one.entries.length > 0)
    .sort((a, b) => a.day.localeCompare(b.day))
}

/**
 * The fields a line shows as a table-view tag's entry: each property of those tags'
 * structures that the line gives a value, in the structure's order. `tables` is the
 * structure of every tag drawn as a table.
 */
export function fieldsOf(
  text: string,
  tables: Readonly<Record<string, readonly string[]>>,
  typeOf: (name: string) => PropertyType
): { name: string; value: string }[] {
  const names = [...new Set(tagNames(text).flatMap((tag) => tables[tag] ?? []))]
  const given = new Map(
    blockProperties(text, typeOf)
      .filter((one) => one.valid && one.value)
      .map((one) => [one.name.toLowerCase(), one.value])
  )
  return names.flatMap((name) => {
    const value = given.get(name.toLowerCase())
    return value ? [{ name, value }] : []
  })
}

/** Each `number` field's total over a day's entries of a table-view tag — the day's
 *  sum, as a tag's table has one. */
export function totalsOf(
  entries: readonly TimelineEntry[],
  tables: Readonly<Record<string, readonly string[]>>,
  typeOf: (name: string) => PropertyType
): { tag: string; name: string; total: number }[] {
  return Object.entries(tables).flatMap(([tag, properties]) => {
    const carrying = entries.filter((one) => tagNames(one.text).includes(tag))
    return properties
      .filter((name) => typeOf(name) === 'number')
      .flatMap((name) => {
        const values = carrying.flatMap((one) => fieldsOf(one.text, { [tag]: [name] }, typeOf)).map((one) => Number(one.value))
        return values.length > 0 ? [{ tag, name, total: values.reduce((sum, one) => sum + one, 0) }] : []
      })
  })
}

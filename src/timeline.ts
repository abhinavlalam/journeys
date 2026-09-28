// The timeline: the daily notes as each day happened.
//
// A daily note is written by kind — a group is a line of tags alone (`#expense`,
// `#diet`) with that kind's entries nested under it — and read here by clock: every
// entry of the day, from every group, in the order it happened. Nothing here writes;
// an entry carries the line it came from, which is what an edit writes back.

import { leadingClock } from './clock'
import { dayOf, isDailyNote } from './daily'
import { blockProperties, readBlock, splitPageProperties, type PropertyType } from './properties'
import { proseLines } from './prose'
import { TAG, tagNames } from './tags'
import type { VaultFile } from './vaultModel'

export interface TimelineEntry {
  note: VaultFile
  /** 0-based line in the note: the one an edit writes back. */
  at: number
  /** The line as written, its indent off. */
  text: string
  /** The line's leading clock, or `''` for an entry with none. */
  clock: string
  /** Minutes into the day it starts — null with no clock — and, for a block of
   *  time rather than a moment, ends: past 24 hours for a block that crosses
   *  midnight. */
  start: number | null
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

const minutesOf = (clock: string) =>
  [...clock.matchAll(/(\d{1,2}):(\d{2})/g)].map((hit) => Number(hit[1]) * 60 + Number(hit[2]))

/**
 * A day's entries in the order it happened: those with no clock first, as written,
 * then by when they start — a tie keeps the order written.
 *
 * An entry is a line that is not a group's heading, and **what is nested under an
 * entry is its detail**, as a tag's page reads it. A heading's lines are its group's
 * however deep the headings nest; code is nobody's entry.
 */
export function dayEntries(note: VaultFile, raw: string): TimelineEntry[] {
  const lines = raw.split(/\r?\n/)
  const prose = proseLines(raw)
  const first = splitPageProperties(raw).prefix.split('\n').length - 1
  const entries: TimelineEntry[] = []
  const heads: { indent: number; name: string }[] = []
  let entry: { indent: number; below: string[] } | null = null
  for (let at = first; at < lines.length; at++) {
    const line = lines[at]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (entry && indent > entry.indent) {
      entry.below.push(line.slice(entry.indent).trimEnd())
      continue
    }
    entry = null
    if (prose[at].trim() === '') continue
    while (heads.length > 0 && heads[heads.length - 1].indent >= indent) heads.pop()
    if (isGroupHead(prose[at])) {
      heads.push({ indent, name: tagNames(prose[at])[0] })
      continue
    }
    const text = line.trim()
    const clock = leadingClock(text) ?? ''
    const [start = null, stop = null] = minutesOf(clock)
    const one: TimelineEntry = {
      note,
      at,
      text,
      clock,
      start,
      end: start === null || stop === null ? null : stop < start ? stop + DAY_MINUTES : stop,
      group: heads[heads.length - 1]?.name ?? null,
      below: [],
    }
    entries.push(one)
    entry = { indent, below: one.below }
  }
  const timed = entries.filter((one) => one.start !== null).sort((a, b) => a.start! - b.start!)
  return [...entries.filter((one) => one.start === null), ...timed]
}

/** `HH:MM` for minutes into a day, a block's end past midnight included. */
export const clockText = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** How long a block lasts: `50 min`, `1 h`, `1 h 30 min`. */
export function lengthOf(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
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

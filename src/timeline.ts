// The timeline: the daily notes as each day happened. A day is written by kind, a
// line of tags alone (`#timeline`, `#diet`) heading a group with its entries nested
// under it, and a record (`#expense`) one to a line. Here it is read by clock: every
// entry of the day, from every group, in order. An entry carries its line number,
// which an edit writes back to.

import { leadingClock, minutesOf } from './clock'
import { dayOf, isDailyNote } from './daily'
import { blockProperties, numberText, readBlock, splitPageProperties, type PropertyType } from './properties'
import { indentOf, proseLines } from './prose'
import { collectTagLines, COMBINE_NAMES, tagNames, tagsOnly, type Combine, type DayTotal, type TotalPlace } from './tags'
import type { VaultFile } from './vaultModel'

export interface TimelineEntry {
  note: VaultFile
  /** 0-based line in the note, which an edit writes back to. */
  at: number
  /** The line as written, without its indent. */
  text: string
  /** The line's leading clock. A line without one is not an entry. */
  clock: string
  /**
   * Minutes into the day it starts and, for a stretch of time,
   * ends. Past 24 hours for one that crosses midnight.
   */
  start: number
  end: number | null
  /** Its group: the first tag of the nearest heading above it. */
  group: string | null
  /** The lines nested under it, without its own indent. */
  below: string[]
}

export interface TimelineDay {
  day: string
  note: VaultFile
  entries: TimelineEntry[]
  /** The day's note as written, for its totals, which count untimed lines too. */
  text: string
}

const DAY_MINUTES = 24 * 60

/**
 * A group in a day's note: its heading's first tag, the
 * heading's line and indent, and the last line of its run.
 */
interface Group {
  name: string
  at: number
  indent: number
  end: number
}

/**
 * A day's note read: its entries as written, and its groups. An entry is a line
 * with a clock that is not a heading; what is nested under it is its detail. A
 * line without a clock is not an entry, and what is under it is read on its own.
 * A heading's lines belong to its group at any depth. Code is never an entry.
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
    if (tagsOnly(prose[at])) {
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

/** A day's entries by start time; a tie keeps the written order. */
export function dayEntries(note: VaultFile, raw: string): TimelineEntry[] {
  return readDay(note, raw).entries.sort((a, b) => a.start - b.start)
}

/**
 * A day's note with a new entry filed in it, and nothing else moved: under the
 * group headed by one of its tags; else beside the entries carrying one, in the
 * group holding them (`#food` under `#diet`) or after the last at the top level
 * (an `#expense`, as the vault writes a record); else, for a tag with a structure,
 * at the day's end at the top level; else under `group` (`settings.timelineGroup`),
 * added at the note's end if missing. In a group it goes after the group's last
 * line, indented like its lines (or `indent` in from the heading). Lines after the
 * first in `text` are its detail, nested `indent` under it.
 */
export function withNewEntry(
  note: VaultFile,
  raw: string,
  text: string,
  { indent, group: fallback, structured }: { indent: string; group: string; structured: (tag: string) => boolean }
): string {
  const [first, ...detail] = text.split('\n')
  const { entries, groups } = readDay(note, raw)
  const tags = tagNames(first)
  const carrying = entries.filter((one) => tagNames(one.text).some((tag) => tags.includes(tag))).at(-1)
  const group =
    groups.find((one) => tags.includes(one.name)) ??
    (carrying?.group ? groups.find((one) => one.name === carrying.group) : undefined) ??
    (carrying || tags.some(structured) ? undefined : groups.find((one) => one.name === fallback))
  const block = (pad: string) => [pad + first, ...detail.map((line) => pad + indent + line)]
  const lines = raw.split('\n')
  if (group) {
    const inside = lines.slice(group.at + 1, group.end + 1).find((line) => line.trim() !== '')
    const pad = inside ? inside.slice(0, indentOf(inside)) : ' '.repeat(group.indent) + indent
    lines.splice(group.end + 1, 0, ...block(pad))
    return lines.join('\n')
  }
  if (carrying) {
    const pad = lines[carrying.at].slice(0, indentOf(lines[carrying.at]))
    lines.splice(runEnd(lines, carrying.at) + 1, 0, ...block(pad))
    return lines.join('\n')
  }
  if (tags.some(structured)) return `${raw}${raw === '' || raw.endsWith('\n') ? '' : '\n'}${block('').join('\n')}\n`
  const gap = raw === '' || raw.endsWith('\n\n') ? '' : raw.endsWith('\n') ? '\n' : '\n\n'
  return `${raw}${gap}#${fallback}\n${block(indent).join('\n')}\n`
}

/** The last line of an entry and what is nested under it, blank lines inside included. */
function runEnd(lines: readonly string[], at: number): number {
  const indent = indentOf(lines[at])
  let end = at
  for (let next = at + 1; next < lines.length && (lines[next].trim() === '' || indentOf(lines[next]) > indent); next++) {
    if (lines[next].trim() !== '') end = next
  }
  return end
}

/**
 * The note with an entry's line changed to `text`, keeping its
 * indent and line ending. Null when that line is no longer the
 * entry, because the note changed since it was read.
 */
export function withEditedEntry(raw: string, entry: { at: number; text: string }, text: string): string | null {
  const lines = raw.split('\n')
  const line = lines[entry.at]
  if (line === undefined || line.trim() !== entry.text) return null
  const indent = line.slice(0, indentOf(line))
  lines[entry.at] = indent + text.replace(/\s+/g, ' ').trim() + (line.endsWith('\r') ? '\r' : '')
  return lines.join('\n')
}

/**
 * What an entry says after its clock. Properties read as the note shows them
 * (names and quotes out), or are left out when drawn as fields beside it.
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

/** Every daily note with anything in it, oldest first, down to today. */
export function timelineDays(notes: readonly { note: VaultFile; text: string }[], folder: string): TimelineDay[] {
  return notes
    .filter(({ note }) => isDailyNote(note.path, folder))
    .map(({ note, text }) => ({ day: dayOf(note.path), note, entries: dayEntries(note, text), text }))
    .filter((one) => one.entries.length > 0)
    .sort((a, b) => a.day.localeCompare(b.day))
}

/**
 * The fields a line shows for a table-view tag: each property of
 * those tags' structures the line has a value for, in the structure's
 * order. `tables` is the structure of every tag drawn as a table.
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

/** `values` combined `by` the owner's choice, or null with none to combine. */
function combine(values: readonly number[], by: Combine): number | null {
  if (values.length === 0) return null
  if (by === 'count') return values.length
  if (by === 'min') return Math.min(...values)
  if (by === 'max') return Math.max(...values)
  const sum = values.reduce((total, one) => total + one, 0)
  return by === 'average' ? sum / values.length : sum
}

/**
 * A day's totals for one place (its card in the timeline, or its note's end): each
 * of a tag's totals (`dayTotalsOf`) over every line of the day carrying the tag,
 * timed or not, combined as set. Over entries alone, an expense written without a
 * time was not counted.
 */
export function totalsOf(
  raw: string,
  totals: Readonly<Record<string, readonly DayTotal[]>>,
  typeOf: (name: string) => PropertyType,
  place: Exclude<TotalPlace, 'both'>
): { key: string; tag: string; value: string; label: string }[] {
  return Object.entries(totals).flatMap(([tag, chosen]) => {
    const lines = collectTagLines(raw, tag).map((one) => one.text)
    return chosen
      .filter((one) => one.show === 'both' || one.show === place)
      .flatMap((one) => {
        const values = lines.flatMap((line) => fieldsOf(line, { [tag]: [one.property] }, typeOf)).map((field) => Number(field.value))
        const value = combine(values, one.by)
        if (value === null) return []
        const named = one.by === 'sum' ? one.property : `${one.property}, ${COMBINE_NAMES[one.by].toLowerCase()}`
        return [{ key: `${tag} ${one.property} ${one.by}`, tag, value: numberText(value), label: one.label || `${named} · #${tag}` }]
      })
  })
}

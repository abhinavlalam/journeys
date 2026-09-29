// The calendar: every `#event` line in the journal. The sync writes a feed's
// events into daily notes as `#event` lines, and the calendar reads all `#event`
// lines back, typed or synced. So the notes are complete on their own, and the
// calendar keeps nothing. `source::` names the calendar a line came from.

import { clockStart, DAY_MS, dayDate, daysAfter, HOUR_MS, leadingClock, localDateStamp, localTimeStamp, MINUTE_MS } from './clock'
import { dayOf, isDailyNote } from './daily'
import { recurrences, WEEK_START, WEEKDAY_NAMES, type Frequency, type Occurrence, type Recurrence } from './ics'
import { blockProperties, textProperty, type PropertyType } from './properties'
import { TAG } from './tags'
import type { CollectedNote } from './useVaultTexts'
import type { VaultFile } from './vaultModel'

/** The tag. */
export const EVENT = 'event'

/**
 * The `#event` structure the app declares when the vault has none, and the
 * names the calendar reads: `with`, `at` and `source` are shown, `repeats`
 * puts the line on later days, and `reminder` puts it under Coming up early.
 * Once written, the structure is the vault's, and the sync follows its order.
 */
export const EVENT_PROPERTIES = ['with', 'at', 'source', 'repeats', 'reminder']

/** How the vault writes an event: its structure, and each property's type. */
export interface EventFormat {
  properties: readonly string[]
  typeOf: (name: string) => PropertyType
}

/**
 * A line as an event: its clock (`''` for all day), its title,
 * and its values by lower-case property name.
 */
export interface EventParts {
  clock: string
  what: string
  fields: Record<string, string>
}

export interface CalendarEvent extends EventParts {
  /** `YYYY-MM-DD`. */
  day: string
  note: VaultFile
  /** 0-based line in the note. */
  line: number
  /** The start as a time: the day at the clock, or midnight. */
  startsAt: number
  /** Put on this day by a `repeats::`, not written on it. */
  repeated: boolean
}

/**
 * A line read as an event. The title is the words before the first
 * property, minus the clock and the tag: `19:00 Dinner #event with:: "Mira
 * Vance"` is Dinner. Words after a property are the owner's, so adding
 * them keeps it the same event. A value not of its type is not read.
 */
export function readEvent(line: string, typeOf: (name: string) => PropertyType): EventParts {
  const clock = leadingClock(line) ?? ''
  const found = blockProperties(line, typeOf)
  return {
    clock,
    what: line
      .slice(clock.length, found[0]?.from)
      .replace(TAG, (hit, lead: string, name: string) => (name.toLowerCase() === EVENT ? lead : hit))
      .replace(/\s+/g, ' ')
      .trim(),
    fields: Object.fromEntries(found.filter((one) => one.valid && one.value).map((one) => [one.name.toLowerCase(), one.value])),
  }
}

/**
 * The line an event is written as, read back by `readEvent`: clock,
 * tag, title, then each property of the structure that has a value.
 */
export function eventText(properties: readonly string[], { clock, what, fields }: EventParts): string {
  const carried = properties.filter((name) => fields[name.toLowerCase()])
  return [clock, `#${EVENT}`, what, ...carried.map((name) => textProperty(name, fields[name.toLowerCase()]))]
    .filter(Boolean)
    .join(' ')
}

const startOf = (day: string, clock: string) => {
  const [h, m] = clockStart(clock).split(':').map(Number)
  return dayDate(day, h || 0, m || 0).getTime()
}

/**
 * The events from `from` on, sorted by start: every line on a
 * day from `from`, and the days a `repeats::` adds, up to `to`.
 *
 * A line's day is its note's. A written line has no far limit, since a
 * reminder is due by its own lead. A repeat is followed to `to` plus its
 * reminder lead. A repeat is dropped where a line already has the same
 * clock and title that day, so a synced line and a repeat do not double.
 */
export function readEvents(
  collected: readonly CollectedNote[],
  typeOf: (name: string) => PropertyType,
  dailyFolder: string,
  from: string,
  to: string
): CalendarEvent[] {
  const written: CalendarEvent[] = []
  const repeated: CalendarEvent[] = []
  for (const { note, lines } of collected) {
    if (!isDailyNote(note.path, dailyFolder)) continue
    const day = dayOf(note.path)
    for (const line of lines) {
      const base = { ...readEvent(line.text, typeOf), note, line: line.at }
      if (day >= from) written.push({ ...base, day, startsAt: startOf(day, base.clock), repeated: false })
      const rule = parseRepeats(base.fields.repeats ?? '')
      if (!rule) continue
      const lead = Math.ceil((leadOf(base.fields.reminder ?? '') ?? 0) / DAY_MS)
      for (const next of repeatDays(rule, day, from, daysAfter(to, lead))) {
        repeated.push({ ...base, day: next, startsAt: startOf(next, base.clock), repeated: true })
      }
    }
  }
  const seen = new Set(written.map(eventKey))
  const fresh = repeated.filter((one) => {
    const key = eventKey(one)
    return seen.has(key) ? false : (seen.add(key), true)
  })
  return [...written, ...fresh].sort((a, b) => a.startsAt - b.startsAt || a.what.localeCompare(b.what))
}

/** What makes two events one: the day, the clock and the title. */
const eventKey = (one: { day: string; clock: string; what: string }) =>
  `${one.day} ${one.clock} ${one.what.trim().toLowerCase()}`

const PLAIN: Record<string, Frequency> = {
  daily: 'DAILY',
  everyday: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
  annually: 'YEARLY',
}
const UNITS: Record<string, Frequency> = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }

/** The weekdays a phrase names (`Monday`, `Mon`, `Mondays`), as whole words. */
function weekdaysIn(text: string): number[] {
  return WEEKDAY_NAMES.map((name, day) =>
    new RegExp(`\\b(${name}s?|${name.slice(0, 3)})\\b`, 'i').test(text) ? day : -1
  ).filter((day) => day >= 0)
}

/**
 * A `repeats::` value as a rule: `daily`, `everyday`, `weekly`,
 * `monthly`, `yearly`, `every 2 weeks`, `weekly on Monday, Thursday`,
 * `every Tuesday`, `Mondays`. Anything else repeats nothing.
 */
export function parseRepeats(text: string): Recurrence | null {
  const value = text.trim().toLowerCase()
  if (!value) return null
  const rule = (freq: Frequency, interval: number, on: string): Recurrence => ({
    freq,
    interval,
    byDay: weekdaysIn(on),
    count: null,
    until: null,
  })
  const plain = /^(daily|everyday|weekly|monthly|yearly|annually)(?:\s+on\s+(.+))?$/.exec(value)
  if (plain) return rule(PLAIN[plain[1]], 1, plain[2] ?? '')
  const every = /^every\s+(?:(\d+)\s+)?(day|week|month|year)s?(?:\s+on\s+(.+))?$/.exec(value)
  if (every) return rule(UNITS[every[2]], Number(every[1] ?? 1), every[3] ?? '')
  const days = weekdaysIn(value.replace(/^every\s+/, ''))
  return days.length > 0 ? rule('WEEKLY', 1, value) : null
}

/** The days after `anchor` the rule lands on, within `from`…`to`. */
function repeatDays(rule: Recurrence, anchor: string, from: string, to: string): string[] {
  const out: string[] = []
  const end = dayDate(to, 23, 59)
  for (const at of recurrences(rule, dayDate(anchor))) {
    if (at > end) break
    const day = localDateStamp(at)
    if (day > anchor && day >= from) out.push(day)
  }
  return out
}

/** `7 days`, `2 weeks`, `3 hours`, `30 minutes` as milliseconds, or null. */
export function leadOf(reminder: string): number | null {
  const m = /^(\d+)\s*(minute|hour|day|week)s?$/i.exec(reminder.trim())
  if (!m) return null
  const unit = { minute: MINUTE_MS, hour: HOUR_MS, day: DAY_MS, week: 7 * DAY_MS }[m[2].toLowerCase()]!
  return Number(m[1]) * unit
}

/** The events whose reminder is due and whose start has not passed. */
export function dueReminders(events: readonly CalendarEvent[], now: number): CalendarEvent[] {
  return events.filter((one) => {
    const lead = leadOf(one.fields.reminder ?? '')
    return lead !== null && one.startsAt > now && one.startsAt - now <= lead
  })
}

// ---------------------------------------------------------------------------
// Writing an occurrence as a line
// ---------------------------------------------------------------------------

/**
 * An occurrence as the line the sync writes (`eventText`), in the vault's
 * structure. An event over several days is written once, on its first day.
 *
 * No `repeats::`: the feed already gives every occurrence, and the
 * sync writes each on its day. A `repeats::` would carry a series past
 * the day the feed ends it. `repeats::` is for lines typed by hand.
 */
export function eventLine(properties: readonly string[], { event, start, end }: Occurrence, source: string): string {
  const sameDay = end && end.getTime() > start.getTime() && localDateStamp(end) === localDateStamp(start)
  const clock = event.allDay ? '' : sameDay ? `${localTimeStamp(start)} to ${localTimeStamp(end)}` : localTimeStamp(start)
  const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim()
  return eventText(properties, {
    clock,
    what: oneLine(event.summary),
    fields: {
      with: event.attendees.map(oneLine).join(', '),
      at: oneLine(event.location),
      source: oneLine(source),
      reminder: event.reminder,
    },
  })
}

/**
 * Whether a line holds nothing but its values, as the sync wrote it. A
 * line with added words is the owner's, and the sync never removes it.
 */
export function untouched(format: EventFormat, line: string): boolean {
  return line.trim() === eventText(format.properties, readEvent(line, format.typeOf))
}

/** What makes two lines one event, as the calendar reads them. */
export function lineKey(typeOf: (name: string) => PropertyType, line: string): string {
  return eventKey({ day: '', ...readEvent(line, typeOf) })
}

// ---------------------------------------------------------------------------
// The month page
// ---------------------------------------------------------------------------

/** `YYYY-MM` of a day. */
export const monthOf = (day: string) => day.slice(0, 7)

/** `YYYY-MM`, `months` after `month` (negative for before). */
export function shiftMonth(month: string, months: number): string {
  const [y, m] = month.split('-').map(Number)
  return monthOf(localDateStamp(new Date(y, m - 1 + months, 1)))
}

/**
 * The locale's first weekday, 0 Sunday … 6 Saturday, from `Intl`:
 * Sunday in the US, Monday in most of Europe and India, Saturday in
 * parts of the Middle East. `WEEK_START` when the engine cannot say.
 */
export function firstWeekday(language = globalThis.navigator?.language): number {
  try {
    const locale = new Intl.Locale(language ?? Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
      weekInfo?: { firstDay: number }
      getWeekInfo?: () => { firstDay: number }
    }
    const first = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay
    // `Intl` counts Monday 1 … Sunday 7; `Date` counts Sunday 0 … Saturday 6.
    return first === undefined ? WEEK_START : first % 7
  } catch {
    return WEEK_START
  }
}

/**
 * Every day on a month's page: whole weeks from the one with the
 * 1st to the one with the last, so the page is always seven wide.
 */
export function monthGrid(month: string, firstDay: number): string[] {
  const first = dayDate(`${month}-01`)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
  const lead = (first.getDay() - firstDay + 7) % 7
  const trail = (firstDay + 6 - last.getDay() + 7) % 7
  return Array.from({ length: lead + last.getDate() + trail }, (_, at) => daysAfter(`${month}-01`, at - lead))
}

// The calendar: every `--event` line in the journal, wherever it came from.
//
// **One source of truth, and it is the `event` collection.** A meeting the Google
// feed knows about and a dinner typed into a daily note are both a line that says
// `--event`; the sync *writes* the first kind into the day's note, and the calendar
// reads both kinds back out of the notes. So the notes are complete on their own —
// an agent reading the vault sees the meetings — and the calendar has nothing of
// its own to keep. `source::` says which calendar a line came from, or nothing.

import { fillFields, readFields, templateFields, type TemplateField } from './actions'
import { clockStart, DAY_MS, dayDate, daysAfter, HOUR_MS, leadingClock, localDateStamp, localTimeStamp, MINUTE_MS } from './clock'
import { dayOf, isDailyNote } from './daily'
import { recurrences, WEEK_START, WEEKDAY_NAMES, type Frequency, type Occurrence, type Recurrence } from './ics'
import type { CollectedNote } from './useVaultTexts'
import type { VaultFile } from './vaultModel'

/** The collection's name. */
export const EVENT = 'event'

/**
 * What the app declares for `--event` when the vault has not declared one, and
 * **the field names the calendar reads by**: `what` is the title, `with`, `at` and
 * `source` are shown, `repeats` puts the line on later days and `reminder` puts it
 * under Coming up ahead of time. The structure is the vault's to edit once it is
 * written — reorder it, relabel the prose — as long as those names survive.
 */
export const EVENT_STRUCTURE = `--${EVENT} <<what>> | with:: <<>> | at:: <<>> | source:: <<>> | repeats:: <<>> | reminder:: <<>>`

export interface CalendarEvent {
  /** `YYYY-MM-DD`. */
  day: string
  /** The line's leading clock, or `''` for all day. */
  clock: string
  what: string
  /** Every field the line gives, by the declaration's names. */
  fields: Record<string, string>
  note: VaultFile
  /** 0-based line in the note. */
  line: number
  /** The start as an instant: the day at the clock, or midnight. */
  startsAt: number
  /** Put on this day by a `repeats::` rather than written on it. */
  repeated: boolean
}

const startOf = (day: string, clock: string) => {
  const [h, m] = clockStart(clock).split(':').map(Number)
  return dayDate(day, h || 0, m || 0).getTime()
}

/**
 * The events from `from` on, read out of the collected `--event` lines and sorted
 * by start: every line written on a day from `from`, and the days a `repeats::`
 * puts a line on, up to `to`.
 *
 * **A line's day is its note's**: an event lives in a daily note, which is how the
 * journal already says when something happened. A written line has no far bound —
 * a reminder is due by its own lead, however far off the day — and a repeating
 * one is followed to `to` **plus its own reminder lead**, so a weekly thing with a
 * fortnight's reminder is on the calendar's mind a fortnight before the page
 * reaches it. A repeat is dropped where a line already says the same thing — the
 * same clock and title on that day — so the sync writing next Monday's standup
 * does not double the one this Monday's repeats.
 */
export function readEvents(
  collected: readonly CollectedNote[],
  declaration: string,
  dailyFolder: string,
  from: string,
  to: string
): CalendarEvent[] {
  const fields = templateFields(declaration)
  const written: CalendarEvent[] = []
  const repeated: CalendarEvent[] = []
  for (const { note, lines } of collected) {
    if (!isDailyNote(note.path, dailyFolder)) continue
    const day = dayOf(note.path)
    for (const line of lines) {
      const values = readFields(line.text, fields)
      const clock = leadingClock(line.text) ?? ''
      const base = { clock, what: values.what ?? '', fields: values, note, line: line.at }
      if (day >= from) written.push({ ...base, day, startsAt: startOf(day, clock), repeated: false })
      const rule = parseRepeats(values.repeats ?? '')
      if (!rule) continue
      const lead = Math.ceil((leadOf(values.reminder ?? '') ?? 0) / DAY_MS)
      for (const next of repeatDays(rule, day, from, daysAfter(to, lead))) {
        repeated.push({ ...base, day: next, startsAt: startOf(next, clock), repeated: true })
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

/** The weekdays a phrase names — `Monday`, `Mon`, `Mondays` — as whole words. */
function weekdaysIn(text: string): number[] {
  return WEEKDAY_NAMES.map((name, day) =>
    new RegExp(`\\b(${name}s?|${name.slice(0, 3)})\\b`, 'i').test(text) ? day : -1
  ).filter((day) => day >= 0)
}

/**
 * A `repeats::` value as a rule: `daily`, `everyday`, `weekly`, `monthly`,
 * `yearly`, `every 2 weeks`, `weekly on Monday, Thursday`, `every Tuesday`,
 * `Mondays`. Anything else is a note to the reader and repeats nothing.
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

/** The events whose reminder has come due and whose start has not passed. */
export function dueReminders(events: readonly CalendarEvent[], now: number): CalendarEvent[] {
  return events.filter((one) => {
    const lead = leadOf(one.fields.reminder ?? '')
    return lead !== null && one.startsAt > now && one.startsAt - now <= lead
  })
}

// ---------------------------------------------------------------------------
// Writing an occurrence as a line

/**
 * An occurrence as the line the sync writes: the clock, then the declaration
 * filled by field name — so a vault that has reworded its `--event` structure gets
 * lines in its own wording. A part the occurrence has nothing for is left out
 * (`fillFields`). A multi-day event is written once, on the day it starts.
 *
 * **No `repeats::`, on purpose.** The feed already says when each occurrence is,
 * with its count, its end and the instances that were moved or dropped, and the
 * sync writes each on its day; a `repeats:: <<daily>>` on those lines would have
 * the calendar carry a series on past the day the feed ends it. `repeats::` is
 * how a line *typed* into a note says it recurs, where there is no feed to ask.
 */
export function eventLine(declaration: string, { event, start, end }: Occurrence, source: string): string {
  const sameDay = end && end.getTime() > start.getTime() && localDateStamp(end) === localDateStamp(start)
  const clock = event.allDay ? '' : sameDay ? `${localTimeStamp(start)} to ${localTimeStamp(end)}` : localTimeStamp(start)
  const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim()
  const line = fillFields(declaration, {
    what: oneLine(event.summary),
    with: event.attendees.map(oneLine).join(', '),
    at: oneLine(event.location),
    source: oneLine(source),
    reminder: event.reminder,
  })
  return clock ? `${clock} ${line}` : line
}

/**
 * Whether a line says nothing but what its fields hold — the line the sync wrote,
 * as it wrote it. A line someone has added words to is theirs, and the sync never
 * takes it out: rewritten from its own fields, it would come out different.
 */
export function untouched(declaration: string, line: string): boolean {
  const clock = leadingClock(line)
  const body = fillFields(declaration, readFields(line, templateFields(declaration)))
  return line.trim() === (clock ? `${clock} ${body}` : body)
}

/** What makes two *lines* one event, read the way the calendar reads them. */
export function lineKey(fields: readonly TemplateField[], line: string): string {
  return eventKey({ day: '', clock: leadingClock(line) ?? '', what: readFields(line, fields).what ?? '' })
}

// ---------------------------------------------------------------------------
// The month page

/** `YYYY-MM` of a day. */
export const monthOf = (day: string) => day.slice(0, 7)

/** `YYYY-MM`, `months` on from `month` (negative for back). */
export function shiftMonth(month: string, months: number): string {
  const [y, m] = month.split('-').map(Number)
  return monthOf(localDateStamp(new Date(y, m - 1 + months, 1)))
}

/**
 * The locale's first day of the week, 0 Sunday … 6 Saturday, asked of `Intl`
 * rather than assumed: Sunday in the US, Monday in most of Europe and India,
 * Saturday in parts of the Middle East. `WEEK_START` where the engine cannot say,
 * which is also the week `recurrences` steps.
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

/** Every day on a month's page: whole weeks, from the one holding the 1st to the
 *  one holding the last, so the page is always seven wide. */
export function monthGrid(month: string, firstDay: number): string[] {
  const first = dayDate(`${month}-01`)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
  const lead = (first.getDay() - firstDay + 7) % 7
  const trail = (firstDay + 6 - last.getDay() + 7) % 7
  return Array.from({ length: lead + last.getDate() + trail }, (_, at) => daysAfter(`${month}-01`, at - lead))
}

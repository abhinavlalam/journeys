// An iCalendar feed, read for the days ahead.
//
// Google gives every calendar a private address whose body is this format, and
// that address is the whole of the integration: no OAuth, no API, no token to keep.
// The feed is read the way `csvPreview` reads a CSV — **a scan, not a library** —
// because what the calendar wants of it is small: each event's name, when, where,
// with whom, how it repeats and how long before it a reminder is wanted.
//
// What is deliberately not read: `BYMONTHDAY`, `BYSETPOS`, an ordinal `BYDAY`
// ("the second Tuesday") and `WKST`. A rule the scan cannot follow falls back to
// the event's own date and its interval, which puts the event on the calendar on
// the wrong day rather than nowhere — and the source calendar is one click away.

/** One `VEVENT`, as much of it as the calendar reads. */
export interface IcsEvent {
  uid: string
  summary: string
  location: string
  attendees: string[]
  /** A local instant; for an all-day event, local midnight of its date. */
  start: Date
  /** Null when the feed gives none — an all-day event with no `DTEND` is one day. */
  end: Date | null
  allDay: boolean
  /** The zone its times are written in, `UTC` for one ending in `Z` — the clock its
   *  rule repeats on. Null for a date or a floating time, which repeat on this
   *  machine's. */
  zone: string | null
  /** The `RRULE` line's value, or `''`. */
  rrule: string
  /** Starts the rule skips, as instants. */
  exdates: number[]
  /** For an edited instance of a repeating event: the start it stands in for. */
  recurrenceId: number | null
  /** The first alarm's lead, as `reminderOf` spells it, or `''`. */
  reminder: string
  cancelled: boolean
}

export interface IcsFeed {
  /** `X-WR-CALNAME`, which is what the calendar is called where it came from. */
  name: string
  events: IcsEvent[]
}

/** A long line is continued on the next by a leading space or tab. */
const unfold = (text: string) => text.replace(/\r?\n[ \t]/g, '')
const unescape = (text: string) =>
  text.replace(/\\([\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

interface ContentLine {
  name: string
  params: Record<string, string>
  value: string
}

/** `NAME;PARAM=one;OTHER="quoted:value":the value` — the first unquoted colon
 *  ends the head. */
function contentLine(line: string): ContentLine | null {
  let at = 0
  let quoted = false
  for (; at < line.length; at++) {
    if (line[at] === '"') quoted = !quoted
    else if (line[at] === ':' && !quoted) break
  }
  if (at >= line.length) return null
  const [name, ...rest] = line.slice(0, at).split(';')
  const params: Record<string, string> = {}
  for (const param of rest) {
    const eq = param.indexOf('=')
    if (eq > 0) params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: name.toUpperCase(), params, value: line.slice(at + 1) }
}

const DATE = /^(\d{4})(\d{2})(\d{2})$/
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/

/**
 * An instant the feed names, as a local `Date`.
 *
 * Three spellings: a bare date (all day, and kept as a date — a birthday is the
 * same day everywhere), a time ending in `Z` (UTC), and a floating time that a
 * `TZID` parameter may place in a zone. Google writes the third.
 */
export function icsTime(value: string, params: Record<string, string>): { at: Date; allDay: boolean } | null {
  const date = DATE.exec(value)
  if (date) return { at: new Date(+date[1], +date[2] - 1, +date[3]), allDay: true }
  const m = DATE_TIME.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi, s] = [+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)]
  if (m[7]) return { at: new Date(Date.UTC(y, mo, d, h, mi, s)), allDay: false }
  const tz = params.TZID
  return { at: tz ? zoned(y, mo, d, h, mi, s, tz) : new Date(y, mo, d, h, mi, s), allDay: false }
}

/** A zone's wall clock, both ways: `wall` reads an instant there, `instant` names
 *  the one a wall time there is. Wall times are written as UTC milliseconds. */
interface ZoneClock {
  wall: (instant: number) => number
  instant: (wall: number) => number
}

const clocks = new Map<string, ZoneClock | null>()

/**
 * A named zone's clock, with no zone table of our own — or null for a zone `Intl`
 * does not know, which then reads as local time, as a floating time would. `Intl`
 * can print an instant in a zone, so the wall time read as UTC is the first guess
 * at the instant, and a second pass corrects a guess that fell across a DST edge.
 * Kept per zone: a rule steps once per occurrence, and each formatter is costly.
 */
function clockIn(tz: string): ZoneClock | null {
  if (clocks.has(tz)) return clocks.get(tz)!
  let clock: ZoneClock | null = null
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const wall = (instant: number) => {
      const p: Record<string, number> = {}
      for (const part of format.formatToParts(new Date(instant))) {
        if (part.type !== 'literal') p[part.type] = Number(part.value)
      }
      return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
    }
    const instant = (at: number) => {
      const guess = at - (wall(at) - at)
      return at - (wall(guess) - guess)
    }
    clock = { wall, instant }
  } catch {
    // Not a zone `Intl` knows.
  }
  clocks.set(tz, clock)
  return clock
}

function zoned(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const clock = clockIn(tz)
  return clock ? new Date(clock.instant(Date.UTC(y, mo, d, h, mi, s))) : new Date(y, mo, d, h, mi, s)
}

/** `-P7D` → `7 days`, `-PT15M` → `15 minutes`, `-P1DT2H` → `1 day 2 hours`. A
 *  lead of nothing, or one the scan cannot read, is `''`. */
const DURATION = /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
export function reminderOf(trigger: string): string {
  const m = DURATION.exec(trigger.trim())
  if (!m) return ''
  const units = [
    ['week', m[1]],
    ['day', m[2]],
    ['hour', m[3]],
    ['minute', m[4]],
  ] as const
  return units
    .filter(([, n]) => Number(n) > 0)
    .map(([unit, n]) => `${Number(n)} ${unit}${Number(n) === 1 ? '' : 's'}`)
    .join(' ')
}

/** A room or a projector is invited like a person, and is not one. */
const isResource = (params: Record<string, string>) => /^(RESOURCE|ROOM)$/i.test(params.CUTYPE ?? '')

export function parseIcs(text: string): IcsFeed {
  const feed: IcsFeed = { name: '', events: [] }
  let event: IcsEvent | null = null
  /** Inside a `VALARM` (or anything else nested in the event). */
  let nested = 0
  const fresh = (): IcsEvent => ({
    uid: '',
    summary: '',
    location: '',
    attendees: [],
    start: new Date(NaN),
    end: null,
    allDay: false,
    zone: null,
    rrule: '',
    exdates: [],
    recurrenceId: null,
    reminder: '',
    cancelled: false,
  })

  for (const raw of unfold(text).split(/\r?\n/)) {
    const line = contentLine(raw)
    if (!line) continue
    const { name, params, value } = line
    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT') event = fresh()
      else if (event) nested++
      continue
    }
    if (name === 'END') {
      if (value.toUpperCase() === 'VEVENT') {
        if (event && !Number.isNaN(event.start.getTime())) feed.events.push(event)
        event = null
      } else if (event && nested > 0) nested--
      continue
    }
    if (!event) {
      if (name === 'X-WR-CALNAME') feed.name = unescape(value)
      continue
    }
    if (nested > 0) {
      // The first alarm's lead; an alarm at an absolute time is not a lead.
      if (name === 'TRIGGER' && !params.VALUE && !event.reminder) event.reminder = reminderOf(value)
      continue
    }
    switch (name) {
      case 'UID':
        event.uid = value
        break
      case 'SUMMARY':
        event.summary = unescape(value)
        break
      case 'LOCATION':
        event.location = unescape(value)
        break
      case 'ATTENDEE':
        if (!isResource(params)) {
          event.attendees.push(params.CN ? unescape(params.CN) : value.replace(/^mailto:/i, ''))
        }
        break
      case 'DTSTART': {
        const t = icsTime(value, params)
        if (t) {
          event.start = t.at
          event.allDay = t.allDay
          event.zone = t.allDay ? null : value.endsWith('Z') ? 'UTC' : (params.TZID ?? null)
        }
        break
      }
      case 'DTEND':
        event.end = icsTime(value, params)?.at ?? null
        break
      case 'RRULE':
        event.rrule = value
        break
      case 'EXDATE':
        for (const one of value.split(',')) {
          const t = icsTime(one, params)
          if (t) event.exdates.push(t.at.getTime())
        }
        break
      case 'RECURRENCE-ID':
        event.recurrenceId = icsTime(value, params)?.at.getTime() ?? null
        break
      case 'STATUS':
        event.cancelled = value.toUpperCase() === 'CANCELLED'
        break
    }
  }
  return feed
}

// ---------------------------------------------------------------------------
// Repeating

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

/** How something repeats — an `RRULE`'s, or a `repeats::` a note wrote. */
export interface Recurrence {
  freq: Frequency
  interval: number
  /** Weekdays (0 Sunday … 6 Saturday), for a weekly rule; empty means the start's. */
  byDay: number[]
  count: number | null
  /** An instant, inclusive. */
  until: number | null
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const FREQUENCIES: readonly Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
/** The day a week is stepped from, as `Date` counts them: Monday, iCalendar's own
 *  `WKST` default — and the calendar's fallback where the locale cannot say. */
export const WEEK_START = 1
/** A rule that never lands — the 31st of a month that has none, every month —
 *  would step forever; this is where the generator gives up instead. */
const MOST_STEPS = 100_000

export function parseRule(rrule: string): Recurrence | null {
  const parts: Record<string, string> = {}
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) parts[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1)
  }
  const freq = FREQUENCIES.find((one) => one === parts.FREQ?.toUpperCase())
  if (!freq) return null
  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL) || 1),
    // `2TU` (the second Tuesday) is read as Tuesday — see the header.
    byDay: (parts.BYDAY ?? '')
      .split(',')
      .map((code) => WEEKDAY_CODES.indexOf(code.replace(/^[-+]?\d+/, '').toUpperCase()))
      .filter((day) => day >= 0),
    count: parts.COUNT ? Number(parts.COUNT) : null,
    until: parts.UNTIL ? (icsTime(parts.UNTIL, {})?.at.getTime() ?? null) : null,
  }
}

/** Every start the rule names from `first` on, in order, at `first`'s own time of
 *  day — stepped on the calendar of `zone`, the event's own, or this machine's when
 *  it has none, so a 09:00 there stays 09:00 there across a DST change.
 *  Unbounded: the caller stops it. */
export function* recurrences(rule: Recurrence, first: Date, zone: string | null = null): Generator<Date> {
  const clock = zone ? clockIn(zone) : null
  // The start as its clock reads it, written as UTC so the calendar arithmetic
  // below is on dates no DST can move.
  const start = new Date(
    clock
      ? clock.wall(first.getTime())
      : Date.UTC(first.getFullYear(), first.getMonth(), first.getDate(), first.getHours(), first.getMinutes(), first.getSeconds())
  )
  const [y, mo, d] = [start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()]
  const date = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd))
  /** The instant a day's wall date names at the start's time of day. */
  const at = (day: Date) => {
    const [yy, mm, dd] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()]
    const [h, mi, s] = [start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()]
    return clock ? new Date(clock.instant(Date.UTC(yy, mm, dd, h, mi, s))) : new Date(yy, mm, dd, h, mi, s)
  }
  // Weeks are stepped whole from `WEEK_START`, whichever day the rule was read on.
  const intoWeek = (day: number) => (day - WEEK_START + 7) % 7
  const days = rule.byDay.length ? [...rule.byDay].sort((a, b) => intoWeek(a) - intoWeek(b)) : [start.getUTCDay()]
  const weekStart = d - intoWeek(start.getUTCDay())
  for (let i = 0; i < MOST_STEPS; i++) {
    switch (rule.freq) {
      case 'DAILY':
        yield at(date(y, mo, d + i * rule.interval))
        break
      case 'WEEKLY':
        for (const day of days) {
          const one = at(date(y, mo, weekStart + i * 7 * rule.interval + intoWeek(day)))
          if (one >= first) yield one
        }
        break
      case 'MONTHLY': {
        // The 31st of a month that has thirty days is skipped, not rolled over.
        const day = date(y, mo + i * rule.interval, d)
        if (day.getUTCDate() === d) yield at(day)
        break
      }
      case 'YEARLY': {
        const day = date(y + i * rule.interval, mo, d)
        if (day.getUTCMonth() === mo) yield at(day)
        break
      }
    }
  }
}

/** One time an event happens. */
export interface Occurrence {
  event: IcsEvent
  start: Date
  end: Date | null
}

/**
 * Every occurrence in `[from, to)`, by start — a single event once, a repeating
 * one at each start its rule names less its `EXDATE`s, and an edited instance in
 * place of the start it overrides. A cancelled event is not one.
 */
export function occurrences(feed: IcsFeed, from: Date, to: Date): Occurrence[] {
  const overridden = new Set(
    feed.events.filter((one) => one.recurrenceId !== null).map((one) => `${one.uid}@${one.recurrenceId}`)
  )
  const within = (start: Date) => start >= from && start < to
  const out: Occurrence[] = []
  for (const event of feed.events) {
    if (event.cancelled) continue
    const rule = event.recurrenceId === null && event.rrule ? parseRule(event.rrule) : null
    if (!rule) {
      if (within(event.start)) out.push({ event, start: event.start, end: event.end })
      continue
    }
    const length = event.end ? event.end.getTime() - event.start.getTime() : 0
    let count = 0
    for (const start of recurrences(rule, event.start, event.zone)) {
      if (start >= to || (rule.until !== null && start.getTime() > rule.until)) break
      if (rule.count !== null && ++count > rule.count) break
      const t = start.getTime()
      if (within(start) && !event.exdates.includes(t) && !overridden.has(`${event.uid}@${t}`)) {
        out.push({ event, start, end: event.end ? new Date(t + length) : null })
      }
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime())
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
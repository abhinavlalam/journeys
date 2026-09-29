// The app's idea of time: the stamps the shortcuts write, and
// the clock a line opens with.
//
// Stamps use the local calendar. Never `toISOString().slice(0, 10)`: that is UTC, so
// early morning east of UTC and late evening west of it file under the wrong day.

const pad = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD` for the local day. */
export function localDateStamp(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** `HH:MM` for minutes into a day, wrapping past midnight. */
export const clockText = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`

/** `HH:MM`, 24-hour, local. */
export const localTimeStamp = (now = new Date()) => clockText(now.getHours() * 60 + now.getMinutes())

/**
 * Minutes into the day for each `HH:MM` of a clock: one for a moment, two for a range.
 */
export const minutesOf = (clock: string) =>
  [...clock.matchAll(/(\d{1,2}):(\d{2})/g)].map((hit) => Number(hit[1]) * 60 + Number(hit[2]))

/** How long a span lasts, in words: `50 min`, `1 h`, `1 h 30 min`. */
export function lengthOf(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/**
 * A `HH:MM` clock at the start of a line. Anchored, so `9:05` mid-sentence is left
 * alone; a stamp alone on a line counts. One or two hour digits, since a typed stamp
 * may not be padded. A range (`12:00 to 12:30`, with `to`, a hyphen or a dash) is one
 * clock. The editor's mark, a table's `when` column and the timeline all read it.
 */
export const LEADING_CLOCK = /^(\d{1,2}:\d{2}(?:\s*(?:to|-|–|—)\s*\d{1,2}:\d{2})?)(?=\s|$)/

/** The clock a line opens with, or null. */
export function leadingClock(line: string): string | null {
  return LEADING_CLOCK.exec(line)?.[1] ?? null
}

/** The `HH:MM` a clock opens with: a range's start, or the time itself. */
export const clockStart = (clock: string) => /^\d{1,2}:\d{2}/.exec(clock)?.[0] ?? ''

// ---------------------------------------------------------------------------
// Days as `YYYY-MM-DD`, and the words for a time
// ---------------------------------------------------------------------------

export const SECOND_MS = 1000
export const MINUTE_MS = 60 * SECOND_MS
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

/** A `YYYY-MM-DD` as a local `Date`, at midnight or at `h:m`. */
export function dayDate(day: string, h = 0, m = 0): Date {
  const [y, mo, d] = day.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m)
}

/**
 * `YYYY-MM-DD` for `days` after `day`, stepped on the calendar
 * so a DST change is not a 23-hour day.
 */
export function daysAfter(day: string, days: number): string {
  const at = dayDate(day)
  return localDateStamp(new Date(at.getFullYear(), at.getMonth(), at.getDate() + days))
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayDate(to).getTime() - dayDate(from).getTime()) / DAY_MS)
}

/** One formatter for every relative time, in the locale's words. */
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** `today`, `tomorrow`, `in 3 days`. */
export function relativeDay(day: string, today: string): string {
  return relative.format(daysBetween(today, day), 'day')
}

/** `just now`, `2 minutes ago`, `3 hours ago`. Under a minute is just now. */
export function agoWord(then: number, now = Date.now()): string {
  const ms = then - now
  if (ms > -MINUTE_MS) return 'just now'
  if (ms > -HOUR_MS) return relative.format(Math.round(ms / MINUTE_MS), 'minute')
  if (ms > -DAY_MS) return relative.format(Math.round(ms / HOUR_MS), 'hour')
  return relative.format(Math.round(ms / DAY_MS), 'day')
}

/** A day as a heading: `Wednesday 24 Sept`. */
export const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short' })

/**
 * `Today · Wednesday 24 Sept` within a day of today either way, else
 * the date alone. For the agenda's and the timeline's headings.
 */
export function dayTitle(day: string, today: string): string {
  const date = longDay.format(dayDate(day))
  if (Math.abs(daysBetween(today, day)) > 1) return date
  const word = relativeDay(day, today)
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} · ${date}`
}

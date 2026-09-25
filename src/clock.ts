// The stamps the shortcuts write and the clock a line opens with — one module for
// the app's idea of time.
//
// The two stamps are read off the **local** calendar.
//
// Never `toISOString().slice(0, 10)`: that is UTC, so 02:00 in Darwin files under
// yesterday and 23:00 in Los Angeles files under tomorrow — the one day of the year
// a daily note must get right is today's.

const pad = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD` for the local day. */
export function localDateStamp(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** `HH:MM`, 24-hour, local. */
export function localTimeStamp(now = new Date()): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * A `HH:MM` clock at the very start of a line — how a journal line opens.
 *
 * Anchored, so `9:05` inside a sentence is left alone, and a lone stamp on an empty
 * line still counts. One or two digits for the hour, because a stamp typed by hand
 * is not always padded even though ⌘⇧T pads it. A range counts as one clock —
 * `12:00 to 12:30`, with `to`, a hyphen or a dash — because that is one span of
 * time and not two times.
 *
 * **One rule, three readers**: the mark the editor draws over it, the `when` column
 * a collection's table opens with, and anything later that wants to know when a
 * line happened. It was private to `editorPreview.ts`, where only the mark could
 * see it.
 */
export const LEADING_CLOCK = /^(\d{1,2}:\d{2}(?:\s*(?:to|-|–|—)\s*\d{1,2}:\d{2})?)(?=\s|$)/

/** The clock a line opens with, or null. */
export function leadingClock(line: string): string | null {
  return LEADING_CLOCK.exec(line)?.[1] ?? null
}

/** The `HH:MM` a clock opens with — the start of a range, or the time itself. */
export const clockStart = (clock: string) => /^\d{1,2}:\d{2}/.exec(clock)?.[0] ?? ''

// ---------------------------------------------------------------------------
// Days as `YYYY-MM-DD`, and the words for a time

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

/** A `YYYY-MM-DD` as a local `Date`, at midnight or at `h:m`. */
export function dayDate(day: string, h = 0, m = 0): Date {
  const [y, mo, d] = day.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m)
}

/** `YYYY-MM-DD` for `days` after `day` — stepped on the calendar, so a DST change
 *  is not a day of 23 hours. */
export function daysAfter(day: string, days: number): string {
  const at = dayDate(day)
  return localDateStamp(new Date(at.getFullYear(), at.getMonth(), at.getDate() + days))
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayDate(to).getTime() - dayDate(from).getTime()) / DAY_MS)
}

/** One formatter for every relative time the app says, in the locale's words. */
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** `today`, `tomorrow`, `in 3 days`. */
export function relativeDay(day: string, today: string): string {
  return relative.format(daysBetween(today, day), 'day')
}

/** `just now`, `2 minutes ago`, `3 hours ago` — under a minute is "just now". */
export function agoWord(then: number, now = Date.now()): string {
  const ms = then - now
  if (ms > -MINUTE_MS) return 'just now'
  if (ms > -HOUR_MS) return relative.format(Math.round(ms / MINUTE_MS), 'minute')
  if (ms > -DAY_MS) return relative.format(Math.round(ms / HOUR_MS), 'hour')
  return relative.format(Math.round(ms / DAY_MS), 'day')
}

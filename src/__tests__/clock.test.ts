import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agoWord, clockStart, daysAfter, daysBetween, leadingClock, localDateStamp, localTimeStamp, relativeDay } from '../clock'

/**
 * The stamps are local-calendar, and the only way to prove it is from a zone that
 * is not UTC — on a UTC machine every wrong implementation passes. Node reads
 * `process.env.TZ` on each `Date` operation, so this file picks a zone (+09:30, no
 * DST) rather than trusting the one it runs in. Vitest isolates a test file in its
 * own worker, and it is restored anyway.
 */
const realTZ = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Australia/Darwin'
})
afterAll(() => {
  process.env.TZ = realTZ
})

describe('localDateStamp', () => {
  it('names the local day, both sides of UTC midnight', () => {
    // 02:00 local is 16:30 the *previous* day in UTC, which is what an
    // `toISOString().slice(0, 10)` files a small-hours daily note under.
    expect(localDateStamp(new Date(2026, 7, 12, 2, 0))).toBe('2026-08-12')
    expect(localDateStamp(new Date(2026, 7, 12, 23, 0))).toBe('2026-08-12')
  })

  it('pads a single-digit month and day', () => {
    expect(localDateStamp(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05')
  })
})

describe('localTimeStamp', () => {
  it('is 24-hour and padded', () => {
    expect(localTimeStamp(new Date(2026, 7, 12, 9, 5))).toBe('09:05')
    expect(localTimeStamp(new Date(2026, 7, 12, 21, 30))).toBe('21:30')
    expect(localTimeStamp(new Date(2026, 7, 12, 0, 0))).toBe('00:00')
  })
})

/**
 * **The clock a line opens with**, which is one rule with three readers now: the
 * mark the editor draws, the `when` column a collection's table opens with, and
 * whatever next wants to know when a line happened. It was private to
 * `editorPreview.ts`, where only the mark could see it.
 */
describe('leadingClock', () => {
  it('reads a clock at the start of a line', () => {
    expect(leadingClock('09:42 --expense on [[Bistro]]')).toBe('09:42')
    // Unpadded, because a stamp typed by hand is not always padded.
    expect(leadingClock('9:05 woke up')).toBe('9:05')
    expect(leadingClock('12:00')).toBe('12:00')
  })

  /** A range is one clock: that is one span of time, not two times. */
  it('reads a range as one clock', () => {
    expect(leadingClock('12:00 to 12:30 --research-activity for [[Rhea]]')).toBe('12:00 to 12:30')
    expect(leadingClock('12:00-12:30 x')).toBe('12:00-12:30')
    expect(leadingClock('12:00 – 12:30 x')).toBe('12:00 – 12:30')
  })

  it('answers null for a time that is not a line’s own opening', () => {
    expect(leadingClock('met at 09:42 today')).toBeNull()
    expect(leadingClock('  09:42 indented')).toBeNull()
    expect(leadingClock('09:42x')).toBeNull()
    expect(leadingClock('')).toBeNull()
  })
})

describe('days as YYYY-MM-DD', () => {
  it('steps across a month and a year', () => {
    expect(daysAfter('2026-09-28', 6)).toBe('2026-10-04')
    expect(daysAfter('2026-12-31', 1)).toBe('2027-01-01')
    expect(daysBetween('2026-09-28', '2026-10-04')).toBe(6)
    expect(daysBetween('2026-10-04', '2026-09-28')).toBe(-6)
  })

  it('says a day and a time the way the locale says them', () => {
    expect(relativeDay('2026-09-26', '2026-09-25')).toBe(new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(1, 'day'))
    const now = Date.UTC(2026, 8, 25, 12)
    expect(agoWord(now - 30_000, now)).toBe('just now')
    expect(agoWord(now - 2 * 60_000, now)).toBe('2 minutes ago')
    expect(agoWord(now - 3 * 3_600_000, now)).toBe('3 hours ago')
  })

  it('reads the start of a clock', () => {
    expect(clockStart('09:30 to 10:00')).toBe('09:30')
    expect(clockStart('9:05')).toBe('9:05')
    expect(clockStart('')).toBe('')
  })
})

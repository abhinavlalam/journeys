import { describe, expect, it } from 'vitest'
import { icsTime, occurrences, parseIcs, parseRule, reminderOf } from '../ics'

/**
 * The feed scan. Every fixture is the shape Google writes — folded lines, `TZID`
 * times, `BYDAY` weeks, an `EXDATE`, an edited instance with a `RECURRENCE-ID` —
 * with fictional names.
 */
const feed = (body: string) =>
  ['BEGIN:VCALENDAR', 'X-WR-CALNAME:Fable Weekly', ...body.trim().split('\n'), 'END:VCALENDAR'].join('\r\n')

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)

describe('parseIcs', () => {
  it('reads the calendar name and an event, unfolding and unescaping', () => {
    const { name, events } = parseIcs(
      feed(`
BEGIN:VEVENT
UID:a1@example
DTSTART;TZID=Australia/Darwin:20260924T093000
DTEND;TZID=Australia/Darwin:20260924T100000
SUMMARY:Standup\\, the long
  one
LOCATION:Room 4
ATTENDEE;CN=Mira Vance;CUTYPE=INDIVIDUAL:mailto:mira@example
ATTENDEE;CUTYPE=RESOURCE;CN=Projector:mailto:proj@example
ATTENDEE:mailto:ravi@example
BEGIN:VALARM
TRIGGER:-P7D
END:VALARM
END:VEVENT`)
    )
    expect(name).toBe('Fable Weekly')
    expect(events).toHaveLength(1)
    const [one] = events
    expect(one.summary).toBe('Standup, the long one')
    expect(one.location).toBe('Room 4')
    // A room is invited like a person and is not one; a bare mailto is its address.
    expect(one.attendees).toEqual(['Mira Vance', 'ravi@example'])
    expect(one.reminder).toBe('7 days')
    expect(one.allDay).toBe(false)
    // 09:30 in Darwin is 00:00 UTC.
    expect(one.start.getTime()).toBe(Date.UTC(2026, 8, 24, 0, 0))
  })

  it('skips an event with no start, and marks a cancelled one', () => {
    const { events } = parseIcs(
      feed(`
BEGIN:VEVENT
UID:none
SUMMARY:No when
END:VEVENT
BEGIN:VEVENT
UID:gone
DTSTART:20260925T100000Z
STATUS:CANCELLED
END:VEVENT`)
    )
    expect(events.map((one) => one.uid)).toEqual(['gone'])
    expect(events[0].cancelled).toBe(true)
  })
})

describe('icsTime', () => {
  it('reads a date as all day, local', () => {
    expect(icsTime('20260924', {})).toEqual({ at: local(2026, 9, 24), allDay: true })
  })
  it('reads Z as UTC and a floating time as local', () => {
    expect(icsTime('20260924T120000Z', {})!.at.getTime()).toBe(Date.UTC(2026, 8, 24, 12))
    expect(icsTime('2026-09-24', {})).toBeNull()
    expect(icsTime('20260924T120000', {})!.at).toEqual(local(2026, 9, 24, 12))
  })
  it('places a zoned time, across the zone`s DST', () => {
    // New York is UTC-4 in July and UTC-5 in January.
    expect(icsTime('20260715T090000', { TZID: 'America/New_York' })!.at.getTime()).toBe(Date.UTC(2026, 6, 15, 13))
    expect(icsTime('20260115T090000', { TZID: 'America/New_York' })!.at.getTime()).toBe(Date.UTC(2026, 0, 15, 14))
  })
  it('reads a zone it does not know as local time', () => {
    expect(icsTime('20260924T090000', { TZID: 'Mars/Olympus' })!.at).toEqual(local(2026, 9, 24, 9))
  })
})

describe('reminderOf', () => {
  it('says a lead in words', () => {
    expect(reminderOf('-P7D')).toBe('7 days')
    expect(reminderOf('-PT15M')).toBe('15 minutes')
    expect(reminderOf('-P1DT2H')).toBe('1 day 2 hours')
    expect(reminderOf('-PT0S')).toBe('')
    expect(reminderOf('20260924T090000Z')).toBe('')
  })
})

describe('occurrences', () => {
  const window = [local(2026, 9, 21), local(2026, 10, 5)] as const

  it('lists a single event once, inside the window only', () => {
    const one = parseIcs(feed('BEGIN:VEVENT\nUID:x\nDTSTART:20260923T090000\nEND:VEVENT'))
    expect(occurrences(one, ...window)).toHaveLength(1)
    expect(occurrences(one, local(2026, 9, 24), window[1])).toHaveLength(0)
  })

  it('expands a daily rule with a count, and keeps the length of each', () => {
    const daily = parseIcs(
      feed('BEGIN:VEVENT\nUID:d\nDTSTART:20260922T090000\nDTEND:20260922T093000\nRRULE:FREQ=DAILY;COUNT=3\nEND:VEVENT')
    )
    const starts = occurrences(daily, ...window)
    expect(starts.map((one) => one.start)).toEqual([local(2026, 9, 22, 9), local(2026, 9, 23, 9), local(2026, 9, 24, 9)])
    expect(starts[2].end).toEqual(local(2026, 9, 24, 9, 30))
  })

  it('expands a weekly rule on named days, less an EXDATE, up to UNTIL', () => {
    const weekly = parseIcs(
      feed(`
BEGIN:VEVENT
UID:w
DTSTART:20260921T100000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260930T235959
EXDATE:20260923T100000
END:VEVENT`)
    )
    expect(occurrences(weekly, ...window).map((one) => one.start)).toEqual([
      local(2026, 9, 21, 10),
      local(2026, 9, 28, 10),
      local(2026, 9, 30, 10),
    ])
  })

  it('puts an edited instance in place of the one it overrides', () => {
    const moved = parseIcs(
      feed(`
BEGIN:VEVENT
UID:m
DTSTART:20260922T090000
RRULE:FREQ=DAILY;COUNT=2
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:m
RECURRENCE-ID:20260923T090000
DTSTART:20260923T140000
SUMMARY:Standup (moved)
END:VEVENT`)
    )
    expect(occurrences(moved, ...window).map((one) => [one.event.summary, one.start])).toEqual([
      ['Standup', local(2026, 9, 22, 9)],
      ['Standup (moved)', local(2026, 9, 23, 14)],
    ])
  })

  it('skips a month that has no such day, and a cancelled event', () => {
    const monthly = parseIcs(
      feed('BEGIN:VEVENT\nUID:m31\nDTSTART:20260831T120000\nRRULE:FREQ=MONTHLY\nEND:VEVENT')
    )
    expect(occurrences(monthly, local(2026, 9, 1), local(2026, 11, 1)).map((one) => one.start)).toEqual([
      local(2026, 10, 31, 12),
    ])
    const cancelled = parseIcs(feed('BEGIN:VEVENT\nUID:c\nDTSTART:20260923T090000\nSTATUS:CANCELLED\nEND:VEVENT'))
    expect(occurrences(cancelled, ...window)).toEqual([])
  })

  it('steps an all-day yearly event by the date', () => {
    const birthday = parseIcs(
      feed('BEGIN:VEVENT\nUID:b\nDTSTART;VALUE=DATE:19900924\nRRULE:FREQ=YEARLY\nEND:VEVENT')
    )
    const [one] = occurrences(birthday, ...window)
    expect(one.start).toEqual(local(2026, 9, 24))
    expect(one.event.allDay).toBe(true)
  })
})

describe('parseRule', () => {
  it('reads an ordinal weekday as the weekday, and refuses a frequency it cannot step', () => {
    expect(parseRule('FREQ=MONTHLY;BYDAY=2TU')!.byDay).toEqual([2])
    expect(parseRule('FREQ=HOURLY')).toBeNull()
  })
})

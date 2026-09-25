import { describe, expect, it } from 'vitest'
import { collectLines, fillFields, readFields, templateFields } from '../actions'
import {
  dueReminders,
  EVENT,
  EVENT_STRUCTURE,
  eventLine,
  firstWeekday,
  leadOf,
  monthGrid,
  parseRepeats,
  readEvents,
  shiftMonth,
} from '../calendar'
import { parseIcs, occurrences } from '../ics'
import type { CollectedNote } from '../useVaultTexts'

const note = (path: string, text: string): CollectedNote => ({
  note: { path, absolutePath: `/v/${path}`, name: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '') },
  lines: collectLines(text, EVENT),
})

/**
 * `fillFields` is `readFields` the other way round, and the test is that round
 * trip: what is written is read back as the same values.
 */
describe('fillFields', () => {
  it('fills every slot by name and reads back what it wrote', () => {
    const values = { what: 'Dentist', with: 'Mira Vance', at: 'Clinic', source: 'Fable Weekly', repeats: '', reminder: '1 day' }
    const line = fillFields(EVENT_STRUCTURE, values)
    expect(line).toBe('--event <<Dentist>> | with:: <<Mira Vance>> | at:: <<Clinic>> | source:: <<Fable Weekly>> | reminder:: <<1 day>>')
    expect(readFields(line, templateFields(EVENT_STRUCTURE))).toEqual({
      what: 'Dentist',
      with: 'Mira Vance',
      at: 'Clinic',
      source: 'Fable Weekly',
      reminder: '1 day',
    })
  })

  it('leaves out a part with nothing in it, and keeps the first part', () => {
    expect(fillFields(EVENT_STRUCTURE, { what: 'Walk' })).toBe('--event <<Walk>>')
    expect(fillFields(EVENT_STRUCTURE, {})).toBe('--event <<>>')
  })

  it('keeps a labelled slot`s default and a value`s own pipe', () => {
    const expense = '--expense spent currency::<<EUR>> amount::<<>> | for:: <<>>'
    expect(fillFields(expense, { amount: '480' })).toBe('--expense spent currency::<<EUR>> amount::<<480>>')
    expect(fillFields(EVENT_STRUCTURE, { what: 'A | B', at: 'C' })).toBe('--event <<A | B>> | at:: <<C>>')
  })
})

describe('eventLine', () => {
  const ics = (body: string) => parseIcs(`BEGIN:VCALENDAR\n${body}\nEND:VCALENDAR`)
  const first = (body: string) => occurrences(ics(body), new Date(2026, 0, 1), new Date(2027, 0, 1))[0]

  it('opens with the clock as a range on one day', () => {
    const one = first('BEGIN:VEVENT\nUID:a\nDTSTART:20260924T093000\nDTEND:20260924T100000\nSUMMARY:Standup\nEND:VEVENT')
    expect(eventLine(EVENT_STRUCTURE, one, 'Work')).toBe('09:30 to 10:00 --event <<Standup>> | source:: <<Work>>')
  })

  it('has no clock for an all-day event, and only a start for one that runs past midnight', () => {
    const day = first('BEGIN:VEVENT\nUID:b\nDTSTART;VALUE=DATE:20260924\nSUMMARY:Offsite\nLOCATION:Goa\nEND:VEVENT')
    expect(eventLine(EVENT_STRUCTURE, day, '')).toBe('--event <<Offsite>> | at:: <<Goa>>')
    const late = first('BEGIN:VEVENT\nUID:c\nDTSTART:20260924T230000\nDTEND:20260925T010000\nSUMMARY:Flight\nEND:VEVENT')
    expect(eventLine(EVENT_STRUCTURE, late, '')).toBe('23:00 --event <<Flight>>')
  })

  it('carries the people and the reminder, and not the rule', () => {
    const one = first(
      [
        'BEGIN:VEVENT',
        'UID:d',
        'DTSTART:20260921T100000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,TH',
        'SUMMARY:Sync',
        'ATTENDEE;CN=Mira Vance:mailto:m@example',
        'ATTENDEE;CN=Ravi Iyer:mailto:r@example',
        'BEGIN:VALARM',
        'TRIGGER:-PT30M',
        'END:VALARM',
        'END:VEVENT',
      ].join('\n')
    )
    expect(eventLine(EVENT_STRUCTURE, one, 'Work')).toBe(
      '10:00 --event <<Sync>> | with:: <<Mira Vance, Ravi Iyer>> | source:: <<Work>> | reminder:: <<30 minutes>>'
    )
  })
})

describe('parseRepeats', () => {
  it('reads the words a person or the sync writes', () => {
    expect(parseRepeats('everyday')).toMatchObject({ freq: 'DAILY', interval: 1 })
    expect(parseRepeats('Daily')).toMatchObject({ freq: 'DAILY' })
    expect(parseRepeats('weekly')).toMatchObject({ freq: 'WEEKLY', byDay: [] })
    expect(parseRepeats('every 2 weeks')).toMatchObject({ freq: 'WEEKLY', interval: 2 })
    expect(parseRepeats('weekly on Monday, Thursday')).toMatchObject({ freq: 'WEEKLY', byDay: [1, 4] })
    expect(parseRepeats('every tuesday')).toMatchObject({ freq: 'WEEKLY', byDay: [2] })
    expect(parseRepeats('Mondays')).toMatchObject({ freq: 'WEEKLY', byDay: [1] })
    expect(parseRepeats('monthly')).toMatchObject({ freq: 'MONTHLY' })
    expect(parseRepeats('annually')).toMatchObject({ freq: 'YEARLY' })
  })
  it('is null for a note to the reader', () => {
    expect(parseRepeats('')).toBeNull()
    expect(parseRepeats('when the monsoon ends')).toBeNull()
    expect(parseRepeats('sometimes')).toBeNull()
  })
})

describe('readEvents', () => {
  const journal = [
    note('Daily/2026-09-24.md', ['# Thursday', '09:30 to 10:00 --event <<Standup>> | source:: <<Work>> | repeats:: <<daily>>', '--event <<Offsite>> | at:: <<Goa>>'].join('\n')),
    note('Daily/2026-09-25.md', ['09:30 to 10:00 --event <<Standup>> | source:: <<Work>>', '19:00 --event <<Dinner>> | with:: <<Mira Vance>> | reminder:: <<2 days>>'].join('\n')),
    note('Daily/2026-09-20.md', '08:00 --event <<Run>> | repeats:: <<every 2 days>>'),
    note('Areas/Plans.md', '--event <<Not on a day>>'),
  ]

  it('puts a line on its note`s day, all-day first, and only from daily notes', () => {
    const events = readEvents(journal, EVENT_STRUCTURE, 'Daily', '2026-09-24', '2026-09-24')
    expect(events.filter((one) => one.day === '2026-09-24').map((one) => [one.what, one.clock, one.repeated])).toEqual([
      ['Offsite', '', false],
      ['Run', '08:00', true],
      ['Standup', '09:30 to 10:00', false],
    ])
    expect(events[0].fields.at).toBe('Goa')
    // A written line past `to` is still read — a reminder is due by its own lead —
    // where a repeat stops at `to`; a line on no day is not an event.
    expect(events.map((one) => one.day).sort()).toEqual(['2026-09-24', '2026-09-24', '2026-09-24', '2026-09-25', '2026-09-25'])
  })

  it('repeats a line onto later days, but not over a line that says the same', () => {
    const events = readEvents(journal, EVENT_STRUCTURE, 'Daily', '2026-09-25', '2026-09-26')
    expect(events.map((one) => `${one.day} ${one.clock} ${one.what}${one.repeated ? ' *' : ''}`)).toEqual([
      // The 25th's own Standup line, not the 24th's repeat of it.
      '2026-09-25 09:30 to 10:00 Standup',
      '2026-09-25 19:00 Dinner',
      '2026-09-26 08:00 Run *',
      '2026-09-26 09:30 to 10:00 Standup *',
    ])
    expect(events[0].note.path).toBe('Daily/2026-09-25.md')
  })

  it('reads a case-different folder as the daily folder', () => {
    expect(readEvents(journal, EVENT_STRUCTURE, 'daily', '2026-09-25', '2026-09-25')).toHaveLength(2)
  })
})

describe('reminders', () => {
  it('reads a lead', () => {
    expect(leadOf('7 days')).toBe(7 * 86_400_000)
    expect(leadOf('30 minutes')).toBe(30 * 60_000)
    expect(leadOf('2 weeks')).toBe(14 * 86_400_000)
    expect(leadOf('soon')).toBeNull()
  })

  it('is due inside the lead and before the start', () => {
    const events = readEvents(
      [note('Daily/2026-09-25.md', '19:00 --event <<Dinner>> | reminder:: <<2 days>>')],
      EVENT_STRUCTURE,
      'Daily',
      '2026-09-01',
      '2026-09-30'
    )
    const at = (d: number, h: number) => new Date(2026, 8, d, h).getTime()
    expect(dueReminders(events, at(22, 12))).toEqual([])
    expect(dueReminders(events, at(24, 12))).toHaveLength(1)
    expect(dueReminders(events, at(25, 20))).toEqual([])
  })
})

describe('the month page', () => {
  it('covers whole weeks from the locale`s first day', () => {
    const mondays = monthGrid('2026-09', 1)
    expect(mondays[0]).toBe('2026-08-31')
    expect(mondays[mondays.length - 1]).toBe('2026-10-04')
    expect(mondays).toHaveLength(35)
    const sundays = monthGrid('2026-09', 0)
    expect(sundays[0]).toBe('2026-08-30')
    expect(sundays[sundays.length - 1]).toBe('2026-10-03')
    // A month that starts on the first day of the week leads with nothing.
    expect(monthGrid('2026-06', 1)[0]).toBe('2026-06-01')
  })

  it('steps months across a year', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })

  it('asks the locale which day a week starts on', () => {
    expect(firstWeekday('en-US')).toBe(0)
    expect(firstWeekday('en-GB')).toBe(1)
    expect(firstWeekday('not a locale')).toBe(1)
  })
})

describe('a repeat with a reminder', () => {
  it('is followed past the page by its own lead, so the reminder can come due', () => {
    const weekly = [note('Daily/2026-09-21.md', '10:00 --event <<Sync>> | repeats:: <<weekly>> | reminder:: <<2 weeks>>')]
    const days = (to: string) => readEvents(weekly, EVENT_STRUCTURE, 'Daily', '2026-09-21', to).map((one) => one.day)
    expect(days('2026-09-27')).toEqual(['2026-09-21', '2026-09-28', '2026-10-05'])
    const plain = [note('Daily/2026-09-21.md', '10:00 --event <<Sync>> | repeats:: <<weekly>>')]
    expect(readEvents(plain, EVENT_STRUCTURE, 'Daily', '2026-09-21', '2026-09-27').map((one) => one.day)).toEqual(['2026-09-21'])
  })
})

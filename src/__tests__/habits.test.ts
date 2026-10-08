import { describe, expect, it } from 'vitest'
import { doneDays, habitDays, habitsOf, streakOf, withoutHabit } from '../habits'
import { collectTagLines } from '../tags'
import { vaultFile as note } from './fakeVault'

/** A habit is a tag a day's note carries; the page reads days, streaks and weeks from that. */

describe('habits', () => {
  it('are the tags whose entry says so', () => {
    expect(habitsOf({ Water: { habit: true }, stretch: { habit: true }, expense: { properties: ['amount'] }, sail: { habit: false } })).toEqual([
      'stretch',
      'water',
    ])
  })

  it('are done on each day whose note carries the tag, and only daily notes count', () => {
    const day = (path: string, raw: string) => ({ note: note(path), lines: collectTagLines(raw, 'water') })
    const done = doneDays(
      [
        day('Daily/2026-10-05.md', '#water'),
        day('Daily/2026-10-06.md', '07:30 #water the ferns, then the palm'),
        day('Daily/2026-10-07.md', 'a dry day'),
        day('Plants/Ferns.md', '#water weekly'),
      ],
      'Daily'
    )
    expect([...done].sort()).toEqual(['2026-10-05', '2026-10-06'])
  })

  it('show whole weeks from the locale’s first day, this one last', () => {
    // 2026-10-07 is a Wednesday; with weeks from Monday, two weeks run 28 Sep to 11 Oct.
    const days = habitDays('2026-10-07', 1, 2)
    expect([days[0], days.at(-1), days.length]).toEqual(['2026-09-28', '2026-10-11', 14])
  })

  it('keep a streak until a day is over without the habit', () => {
    const done = new Set(['2026-10-04', '2026-10-05', '2026-10-06'])
    // Today not done yet: the streak still stands, up to yesterday.
    expect(streakOf(done, '2026-10-07')).toBe(3)
    expect(streakOf(new Set([...done, '2026-10-07']), '2026-10-07')).toBe(4)
    expect(streakOf(done, '2026-10-08')).toBe(0)
  })

  it('are taken back only where the line is the tag alone, as a press writes it', () => {
    const raw = ['#timeline', '  09:00 standup', '  #water', '#Water', '  07:30 #water the ferns'].join('\n')
    // The bare line under `#timeline` goes; `#Water` heads a line and is the owner's.
    expect(withoutHabit(raw, 'water')).toBe(['#timeline', '  09:00 standup', '#Water', '  07:30 #water the ferns'].join('\n'))
    expect(withoutHabit('07:30 #water the ferns', 'water')).toBeNull()
  })
})

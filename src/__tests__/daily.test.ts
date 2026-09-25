import { describe, expect, it } from 'vitest'
import { dailyNeighbours, dayOf, isDailyNote } from '../daily'
import type { VaultFile } from '../vaultModel'

const file = (path: string): VaultFile => ({
  path,
  absolutePath: `/v/${path}`,
  name: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
})

/** A journal with a gap in it: the 16th, the 17th, then the 20th. Plus the
 *  folder's own note, and a note that lives there without naming a day. */
const NOTES = [
  file('Daily/2026-09-17.md'),
  file('Daily/2026-09-20.md'),
  file('Daily/Daily.md'),
  file('Daily/2026-09-16.md'),
  file('Daily/groceries.md'),
  file('roadmap.md'),
]

describe('a daily note', () => {
  it('is one in the folder whose name is a day', () => {
    expect(isDailyNote('Daily/2026-09-17.md', 'Daily')).toBe(true)
    // The folder's own note lives there and is not a day.
    expect(isDailyNote('Daily/Daily.md', 'Daily')).toBe(false)
    expect(isDailyNote('Daily/groceries.md', 'Daily')).toBe(false)
    // A day's name somewhere else is somebody else's note.
    expect(isDailyNote('2026-09-17.md', 'Daily')).toBe(false)
    expect(isDailyNote('Areas/2026-09-17.md', 'Daily')).toBe(false)
    // The folder is a setting somebody typed, so it is compared case-blind.
    expect(isDailyNote('daily/2026-09-17.md', 'Daily')).toBe(true)
    // A subfolder of the daily folder is not the daily folder.
    expect(isDailyNote('Daily/2026/2026-09-17.md', 'Daily')).toBe(false)
    expect(dayOf('Daily/2026-09-17.md')).toBe('2026-09-17')
    expect(dayOf('Daily/Daily.md')).toBe('')
  })
})

describe('the days either side', () => {
  const steps = (path: string) => {
    const { previous, next } = dailyNeighbours(NOTES, 'Daily', path)
    return [previous?.name ?? null, next?.name ?? null]
  }

  /** **What exists, not what the calendar says**: the 17th's next is the 20th. */
  it('steps over the gaps', () => {
    expect(steps('Daily/2026-09-17.md')).toEqual(['2026-09-16', '2026-09-20'])
  })

  it('has nothing before the first day, or after the last', () => {
    expect(steps('Daily/2026-09-16.md')).toEqual([null, '2026-09-17'])
    expect(steps('Daily/2026-09-20.md')).toEqual(['2026-09-17', null])
  })

  it('is nothing at all for a note that is not a day', () => {
    expect(steps('roadmap.md')).toEqual([null, null])
    expect(steps('Daily/Daily.md')).toEqual([null, null])
    // A day the read does not know about: the note is open, the vault has not
    // caught up, and a neighbour guessed from half a list would be wrong.
    expect(steps('Daily/2026-09-19.md')).toEqual([null, null])
  })

  it('answers for one day on its own', () => {
    expect(dailyNeighbours([file('Daily/2026-09-17.md')], 'Daily', 'Daily/2026-09-17.md')).toEqual({
      previous: null,
      next: null,
    })
  })
})

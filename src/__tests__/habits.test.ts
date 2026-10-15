import { describe, expect, it } from 'vitest'
import { habitDays, readHabits, streakOf, withHabit, withTick } from '../habits'

/** Habits are a table: a row per day, a column per habit, a day's cell marked when it was done. */

const table = ['Day,water,stretch', '2026-10-05,1,', '2026-10-06,yes,0', '2026-10-07,,1', 'soon,1,1', ''].join('\n')

describe('the habits table', () => {
  it('reads every column but the day as a habit, done where its cell is marked', () => {
    const { names, done } = readHabits(table)
    expect(names).toEqual(['water', 'stretch'])
    expect([...done.get('water')!]).toEqual(['2026-10-05', '2026-10-06'])
    // `0` and empty are not done; a row with no day is not read.
    expect([...done.get('stretch')!]).toEqual(['2026-10-07'])
    expect(readHabits('')).toEqual({ names: [], done: new Map() })
  })

  /** A tick is the one value written: the rest of the file stays as it was. */
  it('ticks a day in its row, or adds the row, and takes a tick back', () => {
    expect(withTick(table, '2026-10-07', 'Water', true)).toBe(table.replace('2026-10-07,,1', '2026-10-07,1,1'))
    expect(withTick(table, '2026-10-05', 'water', false)).toBe(table.replace('2026-10-05,1,', '2026-10-05,,'))
    expect(withTick(table, '2026-10-08', 'stretch', true)).toBe(`${table}2026-10-08,,1\n`)
    // Nothing to take back on a day with no row, and no habit of that name.
    expect([withTick(table, '2026-10-09', 'water', false), withTick(table, '2026-10-07', 'sail', true)]).toEqual([table, table])
  })

  it('adds a habit as a column, and begins an empty table with the day', () => {
    expect(withHabit(table, 'read').split('\n')[0]).toBe('Day,water,stretch,read')
    expect(withHabit(table, 'WATER')).toBe(table)
    expect(withHabit('', 'water')).toBe('day,water\n')
  })
})

describe('the days', () => {
  it('show whole weeks from the locale’s first day, this one last', () => {
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
})

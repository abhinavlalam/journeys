import { describe, expect, it } from 'vitest'
import { keptDays, readPlan, withPlanned, withThing } from '../plan'

/** The day's plan, kept in one table: a row per thing per day, and whether it was done. */

const TABLE = ['day,thing,done', '2026-10-16,call the ferry,1', '2026-10-16,"row the boat, twice",', '2026-10-17,water the fern,', ''].join('\n')

describe('the plan’s table', () => {
  it('is read by its columns’ names, each row knowing its place; one lacking them says which', () => {
    expect(readPlan(TABLE).rows).toEqual([
      { day: '2026-10-16', thing: 'call the ferry', done: true, row: 1 },
      { day: '2026-10-16', thing: 'row the boat, twice', done: false, row: 2 },
      { day: '2026-10-17', thing: 'water the fern', done: false, row: 3 },
    ])
    expect(readPlan('day,thing\n').missing).toEqual(['done'])
  })

  it('takes a thing for a day at its end, and an empty file its columns first', () => {
    expect(withThing(TABLE, '2026-10-17', 'pot the basil')).toBe(`${TABLE}2026-10-17,pot the basil,\n`)
    expect(withThing('', '2026-10-17', 'pot the basil')).toBe('day,thing,done\n2026-10-17,pot the basil,\n')
  })

  it('marks a thing done or not, and changes its words, in its row alone', () => {
    const [called, rowed, fern] = readPlan(TABLE).rows
    expect(withPlanned(TABLE, fern, { done: true })).toBe(TABLE.replace('2026-10-17,water the fern,', '2026-10-17,water the fern,1'))
    expect(withPlanned(TABLE, called, { done: false })).toBe(TABLE.replace('call the ferry,1', 'call the ferry,'))
    expect(withPlanned(TABLE, rowed, { thing: 'row the boat' })).toBe(TABLE.replace('"row the boat, twice"', 'row the boat'))
  })

  it('keeps a day when as many things were done as the plan has', () => {
    const { rows } = readPlan(TABLE)
    expect(keptDays(rows, 1)).toEqual(new Set(['2026-10-16']))
    expect(keptDays(rows, 2)).toEqual(new Set())
    expect(keptDays(rows, 0)).toEqual(new Set())
  })
})

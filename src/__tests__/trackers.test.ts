import { describe, expect, it } from 'vitest'
import { daysBack, perDay, perWeek, trackedRows, weeksBack, withRecord } from '../trackers'
import { readCalories, usualItems } from '../calories'

/** What the trackers share: rows read by their columns' names, a row added by them, and days and weeks to add up over. */

const COLUMNS = { day: 'day', time: 'time', item: 'item', calories: 'calories' } as const
const meals = ['Item,Day,Calories,Time', 'oats,2026-10-07,320,08:30', 'soup,2026-10-06,250,', 'tea,soon,40,', 'fern salad,2026-10-07,,13:00', ''].join('\n')

describe('a tracker’s rows', () => {
  it('reads each by its columns’ names, by day and time, and counts what it could not', () => {
    const { rows, missing, unread } = trackedRows(meals, COLUMNS, 'calories')
    expect(rows).toEqual([
      { day: '2026-10-06', time: '', item: 'soup', calories: '250', n: 250 },
      { day: '2026-10-07', time: '08:30', item: 'oats', calories: '320', n: 320 },
    ])
    expect([missing, unread]).toEqual([[], 2])
    expect(trackedRows('when,kcal\n', COLUMNS, 'calories').missing).toEqual(['day', 'calories'])
  })

  /** A row added from a page lands in the table's own order, whatever order the page names them in. */
  it('adds a row in the table’s own column order, and begins an empty table', () => {
    expect(withRecord(meals, COLUMNS, { day: '2026-10-08', item: 'rice, dal', calories: '540' })).toBe(`${meals}"rice, dal",2026-10-08,540,\n`)
    expect(withRecord('', COLUMNS, { day: '2026-10-08', calories: '90' })).toBe('day,time,item,calories\n2026-10-08,,,90\n')
  })

  it('adds up over the last days and weeks, the latest last', () => {
    expect(daysBack('2026-10-07', 3)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07'])
    // Weeks from Monday: 2026-10-07 is a Wednesday.
    expect(weeksBack('2026-10-07', 1, 2)).toEqual(['2026-09-28', '2026-10-05'])
    const rows = [
      { day: '2026-09-30', n: 5 },
      { day: '2026-10-06', n: 2 },
      { day: '2026-10-07', n: 3 },
      { day: '2026-10-07', n: 1 },
    ]
    expect(perDay(rows, ['2026-10-06', '2026-10-07', '2026-10-08'])).toEqual([2, 4, 0])
    expect(perWeek(rows, ['2026-09-28', '2026-10-05'])).toEqual([5, 6])
  })
})

describe('the calories table', () => {
  it('reads each thing eaten, and the usual ones most often first', () => {
    const { meals: read } = readCalories(meals)
    expect(read.map((one) => `${one.item} ${one.calories}`)).toEqual(['soup 250', 'oats 320'])
    const usual = usualItems(
      [...read, { day: '2026-10-08', time: '', item: 'Oats', calories: 300 }, { day: '2026-10-08', time: '', item: '', calories: 10 }],
      2
    )
    expect(usual).toEqual([
      { item: 'oats', times: 2, calories: 620 },
      { item: 'soup', times: 1, calories: 250 },
    ])
  })
})

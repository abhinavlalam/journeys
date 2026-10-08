import { describe, expect, it } from 'vitest'
import { dayGrid, HOUR_EM, QUIET_EM } from '../dayGrid'
import { dayEntries } from '../timeline'

/** A day as a calendar draws one: height is time, clashes side by side, quiet folded. */

const day = { path: 'Daily/2026-09-21.md', absolutePath: '/v/Daily/2026-09-21.md', name: '2026-09-21' }
const grid = (...lines: string[]) => dayGrid(dayEntries(day, lines.join('\n')))
/** Rounded, since an hour's share of `em` is not exact in floating point. */
const round = (n: number) => Math.round(n * 1000) / 1000
const boxes = (...lines: string[]) =>
  grid(...lines).placed.map(({ entry, top, height, column, columns }) => [entry.text.split(' ').slice(-1)[0], round(top), round(height), column, columns])

describe('a day as a grid', () => {
  it('draws a range as tall as it lasted, and a moment one line tall', () => {
    expect(boxes('09:00 to 10:30 deck', '11:00 coffee')).toEqual([
      ['deck', 0, round(HOUR_EM * 1.5), 0, 1],
      ['coffee', round(HOUR_EM * 2), round(HOUR_EM / 3), 0, 1],
    ])
  })

  /** Work on and off through the day: what happened in the middle of it sits beside it. */
  it('lays entries that clash side by side, and gives the rest the whole width', () => {
    expect(boxes('09:00 to 11:00 deck', '09:30 coffee', '09:55 call', '12:00 lunch')).toEqual([
      ['deck', 0, round(HOUR_EM * 2), 0, 2],
      ['coffee', round(HOUR_EM / 2), round(HOUR_EM / 3), 1, 2],
      // Coffee's slot has ended, so the call takes its column again.
      ['call', round(HOUR_EM * (55 / 60)), round(HOUR_EM / 3), 1, 2],
      ['lunch', round(HOUR_EM * 3), round(HOUR_EM / 3), 0, 1],
    ])
    // Held open for its slot, a moment clashes with one just after it.
    expect(boxes('09:00 to 11:00 deck', '09:30 coffee', '09:40 call').map((one) => one[4])).toEqual([3, 3, 3])
  })

  it('folds a stretch of more than an hour with nothing in it', () => {
    const drawn = grid('08:00 walk', '14:00 lunch')
    expect(drawn.quiet).toEqual([{ top: HOUR_EM, minutes: 300 }])
    expect(drawn.placed.map((one) => one.top)).toEqual([0, HOUR_EM + QUIET_EM])
    expect(drawn.height).toBe(HOUR_EM * 2 + QUIET_EM)
    expect(drawn.hours.map((one) => one.minutes)).toEqual([480, 540, 840, 900])
  })

  it('keeps a gap of an hour or less to scale', () => {
    expect(grid('08:00 walk', '10:00 tea').quiet).toEqual([])
  })

  /**
   * What runs into or out of the day is drawn behind the rest, the moments over it at
   * their full width. Only its own start or end is on the axis: drawn to scale, a trip
   * from 08:00 made the day's grid sixteen hours tall.
   */
  it('draws an entry running out of the day behind the rest, to the grid’s end', () => {
    const drawn = grid('08:00 #trip Lakeside ends:: 2026-09-23', '08:30 coffee')
    expect(drawn.across.map(({ entry, top, height }) => [entry.text.split(' ')[1], round(top), round(height)])).toEqual([['#trip', 0, round(drawn.height)]])
    expect(boxes('08:00 #trip Lakeside ends:: 2026-09-23', '08:30 coffee')).toEqual([['coffee', round(HOUR_EM / 2), round(HOUR_EM / 3), 0, 1]])
    expect(drawn.height).toBe(HOUR_EM)
  })

  it('draws an entry come from the day before from the top, to where it ends', () => {
    const [flight] = dayEntries(day, '23:30 to 07:00 flight')
    const carried = { ...flight, start: flight.start - 24 * 60, end: flight.end! - 24 * 60 }
    const drawn = dayGrid([carried])
    expect(drawn.across.map(({ top, height }) => [round(top), round(height)])).toEqual([[0, round(HOUR_EM)]])
  })

  it('draws nothing for a day with no entries', () => {
    expect(grid()).toEqual({ placed: [], across: [], hours: [], quiet: [], height: 0 })
  })
})

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

  it('draws nothing for a day with no entries', () => {
    expect(grid()).toEqual({ placed: [], hours: [], quiet: [], height: 0 })
  })
})

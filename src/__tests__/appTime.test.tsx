/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { localDateStamp } from '../clock'

/**
 * The time in each app: the Mac says every few seconds which app is in front and how
 * long since a key or a press, and whole minutes are written into a table, a row per
 * app per day.
 */

const bus = vi.hoisted(() => {
  const handlers = new Map<string, ((event: { payload: unknown }) => void)[]>()
  return {
    handlers,
    listen: async (event: string, handle: (event: { payload: unknown }) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handle])
      return () => {}
    },
    fire: (event: string, payload: unknown) => handlers.get(event)?.forEach((handle) => handle({ payload })),
  }
})
vi.mock('@tauri-apps/api/event', () => ({ listen: bus.listen }))

const { hoursText, minutesByApp, readAppTime, useAppTime, withAppMinutes, withMinutes } = await import('../appTime')

const TABLE = ['day,app,minutes', '2026-10-16,Mail,12', '2026-10-17,Mail,5', '2026-10-17,"Maps, Harbour",30', ''].join('\n')

describe('the apps table', () => {
  it('is read by its columns’ names; one lacking them says which', () => {
    expect(readAppTime(TABLE).rows).toEqual([
      { day: '2026-10-16', app: 'Mail', minutes: 12 },
      { day: '2026-10-17', app: 'Mail', minutes: 5 },
      { day: '2026-10-17', app: 'Maps, Harbour', minutes: 30 },
    ])
    expect(readAppTime('day,app\n').missing).toEqual(['minutes'])
  })

  it('adds minutes to an app’s row for the day, the value alone, or a row of its own', () => {
    expect(withMinutes(TABLE, '2026-10-17', 'Mail', 3)).toBe(TABLE.replace('2026-10-17,Mail,5', '2026-10-17,Mail,8'))
    expect(withMinutes(TABLE, '2026-10-17', 'Notes, Northwind', 2)).toBe(`${TABLE}2026-10-17,"Notes, Northwind",2\n`)
    // An empty file is given its columns first.
    expect(withMinutes('', '2026-10-17', 'Mail', 1)).toBe('day,app,minutes\n2026-10-17,Mail,1\n')
  })

  it('takes a day’s minutes for several apps at once, and refuses a table without its columns', () => {
    const minutes = new Map([
      ['Mail', 1],
      ['Terminal', 4],
    ])
    expect(withAppMinutes(TABLE, '2026-10-17', minutes)).toBe(`${TABLE.replace('2026-10-17,Mail,5', '2026-10-17,Mail,6')}2026-10-17,Terminal,4\n`)
    expect(() => withAppMinutes('day,app\n', '2026-10-17', minutes)).toThrow(/no minutes column/)
  })

  it('adds up each app over some days, the most first, as hours and minutes', () => {
    const { rows } = readAppTime(TABLE)
    expect(minutesByApp(rows, new Set(['2026-10-16', '2026-10-17']))).toEqual([
      { app: 'Maps, Harbour', minutes: 30 },
      { app: 'Mail', minutes: 17 },
    ])
    expect(hoursText(65)).toBe('1:05')
  })
})

describe('the count', () => {
  afterEach(() => vi.useRealTimers())

  it('counts the time in the app in front while a key or a press is made, and writes whole minutes every five', async () => {
    vi.useFakeTimers()
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    const write = vi.fn(async () => true)
    renderHook(() => useAppTime({ on: true, write }))
    await vi.waitFor(() => expect(bus.handlers.has('front-app')).toBe(true))
    // Two and a half minutes in one app, a minute away from the keys, a minute in another.
    for (let n = 0; n < 30; n++) {
      vi.advanceTimersByTime(5000)
      bus.fire('front-app', { app: 'Mail', idle: 1 })
    }
    for (let n = 0; n < 12; n++) {
      vi.advanceTimersByTime(5000)
      bus.fire('front-app', { app: 'Mail', idle: 200 })
    }
    for (let n = 0; n < 12; n++) {
      vi.advanceTimersByTime(5000)
      bus.fire('front-app', { app: 'Terminal', idle: 3 })
    }
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5 * 60000 - 54 * 5000)
    expect(write).toHaveBeenCalledWith(
      localDateStamp(),
      new Map([
        ['Mail', 2],
        ['Terminal', 1],
      ])
    )
  })
})

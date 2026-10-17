// Time spent in each app, from the Mac saying which is in front (`front` in `lib.rs`):
// a table of one row per app per day and its minutes, kept as the other trackers are.
// Only an app's name is read; time away from the keys is not counted.

import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { DAY_STAMP, localDateStamp } from './clock'
import { onAndroid } from './platform'
import { numberOf, readTable, withCell, withRow } from './table'

export const APP_COLUMNS = ['day', 'app', 'minutes'] as const

export interface AppTime {
  day: string
  app: string
  minutes: number
}

/** The table's rows by its columns' names, any case; a table lacking one says which. */
export function readAppTime(text: string): { rows: AppTime[]; missing: string[] } {
  const [header, ...body] = readTable(text).rows
  const names = header?.cells.map((one) => one.trim().toLowerCase()) ?? []
  const missing = APP_COLUMNS.filter((name) => !names.includes(name))
  if (missing.length > 0) return { rows: [], missing }
  const [day, app, minutes] = APP_COLUMNS.map((name) => names.indexOf(name))
  const rows = body.flatMap((row) => {
    const read = { day: (row.cells[day] ?? '').trim(), app: (row.cells[app] ?? '').trim(), minutes: numberOf(row.cells[minutes] ?? '') }
    return DAY_STAMP.test(read.day) && read.app && read.minutes !== null ? [{ ...read, minutes: read.minutes }] : []
  })
  return { rows, missing: [] }
}

/**
 * The file with `minutes` more for an app on a day: added to its row's minutes, the
 * value alone, or a row of its own at the end. A file with no columns yet is given them.
 */
export function withMinutes(text: string, day: string, app: string, minutes: number): string {
  const headed = readTable(text).rows.length === 0 ? withRow(text, readTable(text), APP_COLUMNS) : text
  const table = readTable(headed)
  const names = table.rows[0].cells.map((one) => one.trim().toLowerCase())
  const [dayAt, appAt, minutesAt] = APP_COLUMNS.map((name) => names.indexOf(name))
  const at = table.rows.findIndex((row, n) => n > 0 && row.cells[dayAt]?.trim() === day && row.cells[appAt]?.trim() === app)
  if (at !== -1) return withCell(headed, table, at, minutesAt, String((numberOf(table.rows[at].cells[minutesAt] ?? '') ?? 0) + minutes))
  const cells = names.map((_, n) => (n === dayAt ? day : n === appAt ? app : n === minutesAt ? String(minutes) : ''))
  return withRow(headed, table, cells)
}

/** The file with each app's minutes added for a day. A table without the columns throws, and is not written into. */
export function withAppMinutes(text: string, day: string, minutes: ReadonlyMap<string, number>): string {
  const { missing } = readAppTime(text || APP_COLUMNS.join(','))
  if (missing.length > 0) throw new Error(`The apps table has no ${missing.join(' or ')} column, so the time in each app is not written into it.`)
  return [...minutes].reduce((written, [app, n]) => withMinutes(written, day, app, n), text)
}

/** Each app's minutes over these days, the most first. */
export function minutesByApp(rows: readonly AppTime[], days: ReadonlySet<string>): { app: string; minutes: number }[] {
  const by = new Map<string, number>()
  for (const row of rows) if (days.has(row.day)) by.set(row.app, (by.get(row.app) ?? 0) + row.minutes)
  return [...by].map(([app, minutes]) => ({ app, minutes })).sort((a, b) => b.minutes - a.minutes)
}

/** `1:05`, as a stretch of minutes reads. */
export const hoursText = (minutes: number) => `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, '0')}`

/** Away after this long without a key or a press: the app in front is not being used. */
const IDLE_SECONDS = 120
/** The longest one report counts for: after a sleep, the gap is not time in an app. */
const STEP_SECONDS = 10
/** Written this often, whole minutes at a time: each minute was a commit in the vault's history. */
const WRITE_MS = 5 * 60000

/**
 * The main window counting the time in each app from the Mac's reports, and writing
 * whole minutes into the table now and then (`write`, which says whether it went
 * through); the seconds left over wait for the next. Nothing when `on` is off.
 */
export function useAppTime({ on, write }: { on: boolean; write: (day: string, minutes: ReadonlyMap<string, number>) => Promise<boolean> }) {
  const seconds = useRef(new Map<string, Map<string, number>>())
  const latest = useRef({ on, write })
  latest.current = { on, write }

  useEffect(() => {
    if (onAndroid || !('__TAURI_INTERNALS__' in window)) return
    let last = Date.now()
    const heard = listen<{ app: string; idle: number }>('front-app', ({ payload }) => {
      const now = Date.now()
      const step = Math.min((now - last) / 1000, STEP_SECONDS)
      last = now
      if (!latest.current.on || payload.idle > IDLE_SECONDS) return
      const day = localDateStamp()
      const apps = seconds.current.get(day) ?? new Map<string, number>()
      apps.set(payload.app, (apps.get(payload.app) ?? 0) + step)
      seconds.current.set(day, apps)
    })
    const every = setInterval(() => {
      for (const [day, apps] of seconds.current) {
        const whole = new Map([...apps].flatMap(([app, s]) => (s >= 60 ? [[app, Math.floor(s / 60)] as const] : [])))
        // A day gone by with less than a minute left over has nothing more to write.
        if (whole.size === 0 && day !== localDateStamp()) seconds.current.delete(day)
        if (whole.size === 0) continue
        void latest.current.write(day, whole).then((went) => {
          if (went) for (const [app, minutes] of whole) apps.set(app, apps.get(app)! - minutes * 60)
        })
      }
    }, WRITE_MS)
    return () => {
      clearInterval(every)
      void heard.then((unlisten) => unlisten())
    }
  }, [])
}

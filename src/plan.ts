// The day's plan, the owner's `Today's 8`: the things to work on each day, kept in one
// table (a row per thing per day: its day, the thing, and whether it was done) and only
// shown in each daily note. A day whose things are all done, as many as the plan has,
// keeps a habit.

import { DAY_STAMP } from './clock'
import { TICK } from './habits'
import { readTable, withCell, withRow } from './table'

/** The plan as set (`dayPlan`): its name and how many things a day; a count of 0 is none. */
export interface DayPlan {
  name: string
  count: number
}

export const PLAN_COLUMNS = ['day', 'thing', 'done'] as const

export interface Planned {
  day: string
  thing: string
  done: boolean
  /** The row's place in the table, where a tick or an edit is written. */
  row: number
}

/** The table's rows by its columns' names, any case, in the table's order; a table lacking one says which. */
export function readPlan(text: string): { rows: Planned[]; missing: string[] } {
  const [header, ...body] = readTable(text).rows
  const names = header?.cells.map((one) => one.trim().toLowerCase()) ?? []
  const missing = PLAN_COLUMNS.filter((name) => !names.includes(name))
  if (missing.length > 0) return { rows: [], missing }
  const [day, thing, done] = PLAN_COLUMNS.map((name) => names.indexOf(name))
  const rows = body.flatMap((one, at) => {
    const read = { day: (one.cells[day] ?? '').trim(), thing: (one.cells[thing] ?? '').trim() }
    const mark = (one.cells[done] ?? '').trim()
    return DAY_STAMP.test(read.day) && read.thing ? [{ ...read, done: mark !== '' && mark !== '0', row: at + 1 }] : []
  })
  return { rows, missing: [] }
}

/** The file with a thing added for a day, at the end; a file with no columns yet is given them. */
export function withThing(text: string, day: string, thing: string): string {
  const headed = readTable(text).rows.length === 0 ? withRow(text, readTable(text), PLAN_COLUMNS) : text
  const table = readTable(headed)
  const names = table.rows[0].cells.map((one) => one.trim().toLowerCase())
  return withRow(headed, table, names.map((name) => (name === 'day' ? day : name === 'thing' ? thing : '')))
}

/** The file with a thing marked done or not, or its words changed, in its row (`Planned.row`). */
export function withPlanned(text: string, planned: Planned, change: { done?: boolean; thing?: string }): string {
  const table = readTable(text)
  const names = table.rows[0]?.cells.map((one) => one.trim().toLowerCase()) ?? []
  let next = text
  if (change.done !== undefined) next = withCell(next, table, planned.row, names.indexOf('done'), change.done ? TICK : '')
  if (change.thing !== undefined) next = withCell(next, readTable(next), planned.row, names.indexOf('thing'), change.thing)
  return next
}

/** The days whose plan was kept: as many things done as the plan has. */
export function keptDays(rows: readonly Planned[], count: number): Set<string> {
  const done = new Map<string, number>()
  for (const row of rows) if (row.done) done.set(row.day, (done.get(row.day) ?? 0) + 1)
  return new Set([...done].flatMap(([day, n]) => (count > 0 && n >= count ? [day] : [])))
}

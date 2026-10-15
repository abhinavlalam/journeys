// Habits: a table with a row per day and a column per habit, a day's cell marked when
// the habit was done. Ticked on the Trackers page; a spreadsheet reads it as it is, and
// adds a column up to the days done.

import { DAY_STAMP, daysAfter, intoWeek } from './clock'
import { readTable, withCell, withRow } from './table'

/** What a tick writes: a number, so a spreadsheet adds the days up. */
export const TICK = '1'

export interface Habits {
  /** The habits, in the table's order. */
  names: string[]
  /** Each habit's days done, by name. */
  done: Map<string, Set<string>>
}

const DAY = 'day'

/** The table's habits: every column but `day`, and the days a cell is marked (anything but empty or `0`). */
export function readHabits(text: string): Habits {
  const [header, ...rows] = readTable(text).rows
  const names = header?.cells.map((one) => one.trim()) ?? []
  const dayAt = names.findIndex((name) => name.toLowerCase() === DAY)
  const habits = names.flatMap((name, at) => (at === dayAt || name === '' ? [] : [{ name, at }]))
  const done = new Map(habits.map(({ name }) => [name, new Set<string>()]))
  for (const row of rows) {
    const day = (row.cells[dayAt] ?? '').trim()
    if (!DAY_STAMP.test(day)) continue
    for (const { name, at } of habits) {
      const value = (row.cells[at] ?? '').trim()
      if (value !== '' && value !== '0') done.get(name)!.add(day)
    }
  }
  return { names: habits.map(({ name }) => name), done }
}

/**
 * The file with a habit marked done, or not, on a day: written into the day's row,
 * the value alone, or a row added for a day not there yet. Unmarking a day with no row
 * changes nothing.
 */
export function withTick(text: string, day: string, habit: string, done: boolean): string {
  const table = readTable(text)
  const names = table.rows[0]?.cells.map((one) => one.trim().toLowerCase()) ?? []
  const [dayAt, habitAt] = [names.indexOf(DAY), names.indexOf(habit.toLowerCase())]
  if (dayAt === -1 || habitAt === -1) return text
  const row = table.rows.findIndex((one, at) => at > 0 && (one.cells[dayAt] ?? '').trim() === day)
  if (row !== -1) return withCell(text, table, row, habitAt, done ? TICK : '')
  if (!done) return text
  return withRow(text, table, names.map((_, at) => (at === dayAt ? day : at === habitAt ? TICK : '')))
}

/** The file with a habit added as a column, or with its columns begun (`day` first). A name it has is left alone. */
export function withHabit(text: string, name: string): string {
  const table = readTable(text)
  const names = table.rows[0]?.cells.map((one) => one.trim()) ?? []
  if (names.some((one) => one.toLowerCase() === name.toLowerCase())) return text
  if (names.filter(Boolean).length === 0) return withRow(text, table, [DAY, name])
  return withCell(text, table, 0, names.length, name)
}

/** The days the page shows: `weeks` whole weeks from the locale's first day, this one last. */
export function habitDays(today: string, firstDay: number, weeks: number): string[] {
  const from = daysAfter(today, -intoWeek(today, firstDay) - 7 * (weeks - 1))
  return Array.from({ length: 7 * weeks }, (_, at) => daysAfter(from, at))
}

/** Days in a row done, up to today, or up to yesterday while today is not done yet: a day not over breaks nothing. */
export function streakOf(done: ReadonlySet<string>, today: string): number {
  let count = 0
  for (let day = done.has(today) ? today : daysAfter(today, -1); done.has(day); day = daysAfter(day, -1)) count++
  return count
}

// The trackers: tables of what is counted day by day (expenses, calories, habits), each
// read by the names of its columns. What they share is here; each one's own sums are in
// its module (`expenses.ts`, `calories.ts`, `habits.ts`).

import { DAY_STAMP, daysAfter, intoWeek } from './clock'
import { numberOf, readTable, withRow } from './table'

export const TRACKERS = ['expenses', 'calories', 'habits'] as const
export type Tracker = (typeof TRACKERS)[number]

/** A tracker's columns: the field each is read into, by the column's name. Every one has a day and a time. */
type Columns = { readonly day: string; readonly time: string } & Readonly<Record<string, string>>

/**
 * A tracker's rows by day and time: each a record of its columns' values, found by name
 * in the first line in any case, and `n`, the row's number. A table without the day or
 * the number's column says which (`missing`), and a row without either is counted
 * (`unread`), so nothing goes unread without being said.
 */
export function trackedRows<C extends Columns>(
  text: string,
  columns: C,
  number: keyof C & string
): { rows: (Record<keyof C, string> & { n: number })[]; missing: string[]; unread: number } {
  const [header, ...body] = readTable(text).rows
  const names = header?.cells.map((one) => one.trim().toLowerCase()) ?? []
  const missing = [columns.day, columns[number]].filter((name) => !names.includes(name))
  if (missing.length > 0) return { rows: [], missing, unread: 0 }
  let unread = 0
  const rows = body
    .filter((row) => row.to > row.from)
    .flatMap((row) => {
      const record = Object.fromEntries(
        Object.entries(columns).map(([field, name]) => [field, (row.cells[names.indexOf(name)] ?? '').trim()])
      ) as Record<keyof C, string>
      const n = numberOf(record[number])
      if (!DAY_STAMP.test(record.day) || n === null) {
        unread++
        return []
      }
      return [{ ...record, n }]
    })
    .sort((a, b) => `${a.day} ${a.time}`.localeCompare(`${b.day} ${b.time}`))
  return { rows, missing, unread }
}

/**
 * The file with a row added from a record: each value in its column's place, found by
 * name, the table's other columns left empty. A file with no columns yet is given the
 * record's, in its order.
 */
export function withRecord<C extends Readonly<Record<string, string>>>(text: string, columns: C, record: Partial<Record<keyof C, string>>): string {
  const table = readTable(text)
  const names = table.rows[0]?.cells.map((one) => one.trim().toLowerCase()).filter(Boolean) ?? []
  if (names.length === 0) {
    const all = Object.keys(columns) as (keyof C)[]
    const headed = withRow(text, table, all.map((field) => columns[field]))
    return withRow(headed, readTable(headed), all.map((field) => record[field] ?? ''))
  }
  const fieldOf = new Map(Object.entries(columns).map(([field, name]) => [name.toLowerCase(), field as keyof C]))
  return withRow(text, table, names.map((name) => record[fieldOf.get(name)!] ?? ''))
}

/** The last `count` days, today last. */
export const daysBack = (today: string, count: number) => Array.from({ length: count }, (_, at) => daysAfter(today, at - count + 1))

/** The first days of the last `count` weeks, from the locale's first day, this week last. */
export function weeksBack(today: string, firstDay: number, count: number): string[] {
  const start = daysAfter(today, -intoWeek(today, firstDay))
  return Array.from({ length: count }, (_, at) => daysAfter(start, 7 * (at - count + 1)))
}

/** `rows`' numbers added up for each of `days`. */
export function perDay(rows: readonly { day: string; n: number }[], days: readonly string[]): number[] {
  const sums = new Map<string, number>()
  for (const row of rows) sums.set(row.day, (sums.get(row.day) ?? 0) + row.n)
  return days.map((day) => sums.get(day) ?? 0)
}

/** `rows`' numbers added up for each week starting on one of `weeks`. */
export function perWeek(rows: readonly { day: string; n: number }[], weeks: readonly string[]): number[] {
  return weeks.map((from) => {
    const to = daysAfter(from, 7)
    return rows.reduce((sum, row) => (row.day >= from && row.day < to ? sum + row.n : sum), 0)
  })
}

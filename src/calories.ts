// The calories table as the Trackers page reads it: a row a thing eaten, each column
// found by its name, as the vault's guide gives them.

import { trackedRows } from './trackers'

/** The columns read, by their names in the table's first line, in any case. */
export const CALORIE_COLUMNS = { day: 'day', time: 'time', item: 'item', calories: 'calories', notes: 'notes' } as const

export interface Meal {
  day: string
  time: string
  item: string
  calories: number
}

/** The table's meals by day and time, and what was not read, as `trackedRows` says it. */
export function readCalories(text: string): { meals: Meal[]; missing: string[]; unread: number } {
  const { rows, missing, unread } = trackedRows(text, CALORIE_COLUMNS, 'calories')
  return { meals: rows.map(({ day, time, item, n }) => ({ day, time, item, calories: n })), missing, unread }
}

/** The things eaten most often, with how often and what they came to, most first. */
export function usualItems(meals: readonly Meal[], count: number): { item: string; times: number; calories: number }[] {
  const seen = new Map<string, { item: string; times: number; calories: number }>()
  for (const { item, calories } of meals) {
    if (!item) continue
    const key = item.toLowerCase()
    const was = seen.get(key) ?? { item, times: 0, calories: 0 }
    seen.set(key, { item: was.item, times: was.times + 1, calories: was.calories + calories })
  }
  return [...seen.values()].sort((a, b) => b.times - a.times || b.calories - a.calories).slice(0, count)
}

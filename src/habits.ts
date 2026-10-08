// Habits: tags tracked day by day. A tag is a habit when its `tags.json` entry says so
// (`habit: true`, set on its page or by the Habits page's +), and a day is done when its
// daily note has a line carrying the tag: any line, as the owner writes it, or the tag
// alone, which a press on the Habits page writes. Nothing else is kept.

import { daysAfter, intoWeek } from './clock'
import type { Entries } from './configEntries'
import { dayOf, isDailyNote } from './daily'
import { collectTagLines } from './tags'
import type { CollectedNote } from './useVaultTexts'

/** The tags tracked as habits, folded, by name. */
export function habitsOf(entries: Entries): string[] {
  return Object.keys(entries)
    .filter((tag) => entries[tag]?.habit === true)
    .map((tag) => tag.toLowerCase())
    .sort()
}

/** The days a habit was done: each daily note with a line carrying its tag. */
export function doneDays(collected: readonly CollectedNote[], dailyFolder: string): Set<string> {
  return new Set(
    collected.filter(({ note, lines }) => lines.length > 0 && isDailyNote(note.path, dailyFolder)).map(({ note }) => dayOf(note.path))
  )
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

/** The line a press writes in a day: the habit's tag alone, filed as an entry is (`withNewEntry`). */
export const habitLine = (tag: string) => `#${tag}`

/**
 * A day's note with a habit taken back: each line that is its tag alone with nothing
 * nested under it, as a press writes it. Null when there is none: the day is done in
 * the owner's own words, and only the owner takes those back.
 */
export function withoutHabit(raw: string, tag: string): string | null {
  const bare = collectTagLines(raw, tag).filter((one) => one.text.toLowerCase() === habitLine(tag) && one.below.length === 0)
  if (bare.length === 0) return null
  const gone = new Set(bare.map((one) => one.at))
  return raw
    .split('\n')
    .filter((_, at) => !gone.has(at))
    .join('\n')
}

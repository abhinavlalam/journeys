// The daily notes, as a sequence.
//
// A journal is one note per day in one folder, named for the day — which is what
// `ensureDailyNote` writes and ⌘⇧O opens. That makes the folder an ordered run, and
// a note in it has a note before it and a note after it: this is the only module
// that knows so.

import { baseName, isSamePath } from './vaultModel'
import type { VaultFile } from './vaultModel'

/** `YYYY-MM-DD` — the name `ensureDailyNote` gives a day, and the only shape read
 *  as one here. A note in the folder called anything else (`Daily.md`, the folder's
 *  own note) is a note that happens to live there. */
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The day a path names, or `''` for a path that names none. */
export function dayOf(path: string): string {
  const name = baseName(path).replace(/\.md$/i, '')
  return DAY.test(name) ? name : ''
}

/** In the daily folder, and named for a day. The folder is compared case-blind,
 *  because it is a setting somebody typed. */
export function isDailyNote(path: string, folder: string): boolean {
  if (!folder) return false
  const at = path.lastIndexOf('/')
  if (at === -1) return false
  return path.slice(0, at).toLowerCase() === folder.toLowerCase() && dayOf(path) !== ''
}

/**
 * The daily notes either side of this one.
 *
 * **Neighbours among the days that exist**, not yesterday and tomorrow: a journal
 * has gaps — a weekend, a week away — and a step that lands on a day nobody wrote
 * would either create a note nobody asked for or go nowhere. Stepping through what
 * is there is what reading back through a journal means.
 *
 * Sorted by name, which for `YYYY-MM-DD` is chronological, so no date is parsed.
 */
export function dailyNeighbours(
  notes: readonly VaultFile[],
  folder: string,
  path: string
): { previous: VaultFile | null; next: VaultFile | null } {
  const none = { previous: null, next: null }
  if (!isDailyNote(path, folder)) return none
  const days = notes
    .filter((note) => isDailyNote(note.path, folder))
    .sort((a, b) => dayOf(a.path).localeCompare(dayOf(b.path)))
  const at = days.findIndex((note) => isSamePath(note.path, path))
  if (at === -1) return none
  return { previous: days[at - 1] ?? null, next: days[at + 1] ?? null }
}

// The daily notes as a sequence. One note per day in one folder,
// named for the day (what `ensureDailyNote` writes and ⌘⇧O opens), so
// each has a note before and after it. Only this module knows that.

import { baseName, folderOf, isSamePath } from './vaultModel'
import type { VaultFile } from './vaultModel'

/**
 * `YYYY-MM-DD`: the name `ensureDailyNote` gives a day. A note in the folder
 * named anything else (like the folder's own note) is just a note there.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The day a path names, or `''`. */
export function dayOf(path: string): string {
  const name = baseName(path).replace(/\.md$/i, '')
  return DAY.test(name) ? name : ''
}

/**
 * In the daily folder and named for a day. The folder is
 * compared ignoring case, since it is a typed setting.
 */
export function isDailyNote(path: string, folder: string): boolean {
  return folder !== '' && isSamePath(folderOf(path), folder) && dayOf(path) !== ''
}

/**
 * The daily notes either side of this one, among the days that exist: a journal
 * has gaps, and stepping onto a day nobody wrote would make an unwanted note or
 * go nowhere. Sorted by name, which for `YYYY-MM-DD` is by date.
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

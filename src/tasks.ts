// Tasks: every `#task` line in the vault, by when it is due. A task is a line of the
// owner's in a note, with the tag's properties: `due::` a date, `status::`, `project::`.
// Done is `status:: done` on the line, which the Tasks page writes and takes back.

import { dayDate, daysBetween } from './clock'
import { blockProperties, type PropertyType } from './properties'
import type { CollectedNote } from './useVaultTexts'
import type { VaultFile } from './vaultModel'

/** The tag a task carries. */
export const TASK = 'task'
const STATUS = 'status'
const DONE = 'done'

export interface Task {
  note: VaultFile
  /** Its line in the note, 0-based, and the line as written: an edit writes back to both. */
  at: number
  text: string
  /** `due::` as a day stamp, or null. */
  due: string | null
  /** `project::` as written, a `[[link]]` to the project's note, or null. */
  project: string | null
  done: boolean
}

/** The groups the page draws, in order. */
export const WHEN = ['Overdue', 'Today', 'This week', 'Later', 'No date', 'Done'] as const
export type When = (typeof WHEN)[number]

/** Every `#task` line gathered from the notes (`collectTag`), with its due day and whether it is done. */
export function readTasks(collected: readonly CollectedNote[], typeOf: (name: string) => PropertyType): Task[] {
  return collected.flatMap(({ note, lines }) =>
    lines.map((line) => {
      const value = (name: string) => blockProperties(line.text, typeOf).find((one) => one.name.toLowerCase() === name)?.value || null
      return { note, at: line.at, text: line.text, due: value('due'), project: value('project'), done: value(STATUS)?.toLowerCase() === DONE }
    })
  )
}

/**
 * Which group a task is in on `today`. This week runs to the last day of the locale's
 * week (`firstWeekday`), so on that day it is empty and tomorrow is Later.
 */
export function whenOf(task: Task, today: string, firstDay: number): When {
  if (task.done) return 'Done'
  if (!task.due) return 'No date'
  const days = daysBetween(today, task.due)
  if (days < 0) return 'Overdue'
  if (days === 0) return 'Today'
  const toWeekEnd = (firstDay + 6 - dayDate(today).getDay() + 7) % 7
  return days <= toWeekEnd ? 'This week' : 'Later'
}

/** The tasks of each group, soonest due first, then as written. */
export function tasksByWhen(tasks: readonly Task[], today: string, firstDay: number): Map<When, Task[]> {
  const sorted = [...tasks].sort(
    (a, b) => (a.due ?? '￿').localeCompare(b.due ?? '￿') || a.note.path.localeCompare(b.note.path) || a.at - b.at
  )
  const groups = new Map<When, Task[]>(WHEN.map((when) => [when, []]))
  for (const task of sorted) groups.get(whenOf(task, today, firstDay))!.push(task)
  return groups
}

/**
 * A task's line marked done or not. Done sets `status:: done`, over any other status;
 * not done takes the status off, so the line reads as it did before it was marked.
 */
export function withDone(text: string, done: boolean, typeOf: (name: string) => PropertyType): string {
  const status = blockProperties(text, typeOf).find((one) => one.name.toLowerCase() === STATUS)
  if (done) return status ? text.slice(0, status.valueFrom) + DONE + text.slice(status.valueTo) : `${text} ${STATUS}:: ${DONE}`
  return status ? (text.slice(0, status.from) + text.slice(status.to)).replace(/\s+/g, ' ').trim() : text
}

// Tasks: every `#task` line in the vault, by when it is due. A task is a line of the
// owner's in a note, with the tag's properties: `due::` a date, `status::`, `project::`.
// Done is `status:: done` on the line, which the Tasks page writes and takes back.

import { dayDate, daysBetween } from './clock'
import { blockProperties, readBlock, type PropertyType } from './properties'
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
  /** The lines nested under it, as written less its own indent: its detail. */
  below: string[]
}

/** The groups the page draws, in order. */
export const WHEN = ['Overdue', 'Today', 'This week', 'Later', 'No date', 'Done'] as const
export type When = (typeof WHEN)[number]

/** Every `#task` line gathered from the notes (`collectTag`), with its due day and whether it is done. */
export function readTasks(collected: readonly CollectedNote[], typeOf: (name: string) => PropertyType): Task[] {
  return collected.flatMap(({ note, lines }) =>
    lines.map((line) => {
      const value = (name: string) => blockProperties(line.text, typeOf).find((one) => one.name.toLowerCase() === name)?.value || null
      return {
        note,
        at: line.at,
        text: line.text,
        due: value('due'),
        project: value('project'),
        done: value(STATUS)?.toLowerCase() === DONE,
        below: line.below,
      }
    })
  )
}

/** What the row says beside a task's words, so the words leave it out. */
const SHOWN = new Set(['due', STATUS, 'project'])

/**
 * A task's line as the note shows it (links, other tags, emphasis, other properties by
 * value), less what its row shows itself: the list mark, `#task`, its box's status, and
 * its due day and project, said after it.
 */
export function taskWords(text: string, typeOf: (name: string) => PropertyType): string {
  let out = ''
  let at = 0
  for (const one of blockProperties(text, typeOf)) {
    if (!SHOWN.has(one.name.toLowerCase())) continue
    out += text.slice(at, one.from)
    at = one.to
  }
  return readBlock(out + text.slice(at), typeOf)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(new RegExp(`(^|\\s)#${TASK}(?![\\w/-])`, 'gi'), '$1')
    .replace(/\s+/g, ' ')
    .trim()
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

/** The tasks of each note, notes by name and each note's tasks as they are written in it. */
export function tasksByNote(tasks: readonly Task[]): { note: VaultFile; tasks: Task[] }[] {
  const byPath = new Map<string, { note: VaultFile; tasks: Task[] }>()
  for (const task of tasks) {
    const group = byPath.get(task.note.path) ?? { note: task.note, tasks: [] }
    group.tasks.push(task)
    byPath.set(task.note.path, group)
  }
  return [...byPath.values()]
    .sort((a, b) => a.note.name.localeCompare(b.note.name))
    .map((group) => ({ ...group, tasks: group.tasks.sort((a, b) => a.at - b.at) }))
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

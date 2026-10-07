import { useState } from 'react'
import { firstWeekday } from './calendar'
import { dayDate, localDateStamp, relativeDay } from './clock'
import { CheckIcon } from './icons'
import { LineEditor, type Typing } from './LineEditor'
import { onAndroid } from './platform'
import type { PropertyType } from './properties'
import { countOf, NoteRow, READING, readable, RowIcon, Section, stepIn } from './rows'
import { lineWords } from './tags'
import { TASK, tasksByWhen, WHEN, type Task, type When } from './tasks'
import { ViewerHeader } from './ViewerHeader'
import type { VaultFile } from './vaultModel'

interface Opens {
  onOpenLink: (target: string, wiki: boolean) => void
  onOpenTag: (tag: string) => void
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const shortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

/** When a task is due, where its group does not already say it. */
function dueWords(task: Task, when: When, today: string): string {
  if (!task.due || when === 'Today' || when === 'No date') return ''
  if (when === 'Overdue') return relativeDay(task.due, today)
  if (when === 'This week') return weekday.format(dayDate(task.due))
  return shortDate.format(dayDate(task.due))
}

/**
 * Tasks: every `#task` line in the vault, by when it is due: overdue, today, the rest
 * of this week, later, with no date, and done, folded. A box marks a task done in its
 * own line (`status:: done`) and takes it back; the row opens the note it is in. A task
 * typed at the top is filed in today's note, as a timeline entry is.
 */
export function TasksView({
  tasks,
  typeOf,
  typing,
  onDone,
  onAdd,
  onOpen,
  ...opens
}: {
  /** Null while the vault is still being read. */
  tasks: Task[] | null
  typeOf: (name: string) => PropertyType
  typing: Typing
  onDone: (task: Task, done: boolean) => void
  /** A new task's line, `#task` and all, for today's note. */
  onAdd: (text: string) => void
  onOpen: (file: VaultFile) => void
} & Opens) {
  const today = localDateStamp()
  const groups = tasks && tasksByWhen(tasks, today, firstWeekday())
  const open = tasks?.filter((one) => !one.done).length ?? 0
  return (
    <>
      <ViewerHeader name="Tasks" status={open > 0 ? countOf(open, 'open task') : ''} />
      <ul className="file-list">
        <NewTask typing={typing} onAdd={onAdd} {...opens} />
      </ul>
      {!groups ? (
        <Section title="Tasks" count={0} startOpen>
          <li style={{ paddingLeft: stepIn(1) }}>
            <NoteRow icon={<RowIcon />} name={READING} disabled />
          </li>
        </Section>
      ) : (
        WHEN.filter((when) => groups.get(when)!.length > 0).map((when) => (
          <Section key={when} title={when} count={groups.get(when)!.length} startOpen={when !== 'Done'}>
            {groups.get(when)!.map((task) => {
              const words = lineWords(task.text, typeOf) || readable(task.text)
              const meta = [dueWords(task, when, today), task.project && readable(task.project)].filter(Boolean).join(' · ')
              return (
                <li key={`${task.note.path}\n${task.at}`} className={task.done ? 'task-row done' : 'task-row'} style={{ paddingLeft: stepIn(1) }}>
                  <button
                    className="task-box"
                    role="checkbox"
                    aria-checked={task.done}
                    aria-label={`${words}: done`}
                    onClick={() => onDone(task, !task.done)}
                  >
                    {task.done && <CheckIcon />}
                  </button>
                  <NoteRow
                    icon={null}
                    name={words}
                    title={`${task.note.name}: ${task.text}`}
                    trailing={meta && <span className="row-count">{meta}</span>}
                    onClick={() => onOpen(task.note)}
                  />
                </li>
              )
            })}
          </Section>
        ))
      )}
    </>
  )
}

/** The line for a new task, `#task` typed, so its properties are offered as on any of its lines. */
function NewTask({ typing, onAdd, ...opens }: { typing: Typing; onAdd: (text: string) => void } & Opens) {
  // A new line each time: the editor reads its text at mount only.
  const [round, setRound] = useState(0)
  const next = () => setRound((was) => was + 1)
  const tagged = new RegExp(`(^|\\s)#${TASK}(?![\\w/-])`, 'i')
  return (
    <li className="task-row task-new" style={{ paddingLeft: stepIn(1) }}>
      <span className="task-box" aria-hidden />
      <LineEditor
        key={round}
        className="task-what line-edit"
        text={`#${TASK} `}
        typing={typing}
        // Not on a phone: the page is opened to read, and the keyboard would cover it.
        autoFocus={!onAndroid}
        onEnter={(text) => {
          // Only words make a task; the tag, if taken out, is put back.
          if (text.replace(tagged, ' ').trim()) onAdd(tagged.test(text) ? text.trim() : `#${TASK} ${text.trim()}`)
          next()
        }}
        onEscape={next}
        {...opens}
      />
    </li>
  )
}

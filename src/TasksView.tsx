import { useState } from 'react'
import { firstWeekday } from './calendar'
import { dayDate, localDateStamp, relativeDay } from './clock'
import { CheckIcon } from './icons'
import { LineEditor, type Typing } from './LineEditor'
import { onAndroid } from './platform'
import type { PropertyType } from './properties'
import { countOf, NoteRow, READING, readable, RowIcon, Section, stepIn } from './rows'
import { lineWords } from './tags'
import { TASK, tasksByNote, tasksByWhen, whenOf, type Task } from './tasks'
import { ViewerHeader } from './ViewerHeader'
import type { VaultFile } from './vaultModel'

interface Opens {
  onOpenLink: (target: string, wiki: boolean) => void
  onOpenTag: (tag: string) => void
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const shortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

/** When a task is due, in words; by due date, Today's group already says so. */
function dueWords(task: Task, today: string, firstDay: number, byDue: boolean): string {
  const when = whenOf(task, today, firstDay)
  if (!task.due || when === 'Done') return ''
  if (when === 'Today') return byDue ? '' : 'today'
  if (when === 'Overdue') return relativeDay(task.due, today)
  if (when === 'This week') return weekday.format(dayDate(task.due))
  return shortDate.format(dayDate(task.due))
}

/**
 * Tasks: every `#task` line in the vault, by when it is due (overdue, today, the rest of
 * this week, later, with no date, and done, folded) or by the page it is on, in the
 * order it is written there, as the header's switch says. A box marks a task done in
 * its own line (`status:: done`) and takes it back. A press on a task edits its line, as
 * a timeline entry's does; its note's name opens the note. A task typed at the top is
 * filed in today's note, as a timeline entry is.
 */
export function TasksView({
  tasks,
  view,
  onView,
  typeOf,
  typing,
  onDone,
  onEdit,
  onAdd,
  onOpen,
  ...opens
}: {
  /** Null while the vault is still being read. */
  tasks: Task[] | null
  /** By due date or by page; kept in the vault's settings. */
  view: 'due' | 'page'
  onView: (next: 'due' | 'page') => void
  typeOf: (name: string) => PropertyType
  typing: Typing
  onDone: (task: Task, done: boolean) => void
  /** A task's line changed to `text`. */
  onEdit: (task: Task, text: string) => void
  /** A new task's line, `#task` and all, for today's note. */
  onAdd: (text: string) => void
  onOpen: (file: VaultFile) => void
} & Opens) {
  const today = localDateStamp()
  const firstDay = firstWeekday()
  /** The task being edited, by its note and line. One at a time. */
  const [editing, setEditing] = useState<string | null>(null)
  const open = tasks?.filter((one) => !one.done).length ?? 0
  const row = (task: Task) => {
    const key = `${task.note.path}\n${task.at}`
    return (
      <TaskRow
        key={key}
        task={task}
        words={lineWords(task.text, typeOf) || readable(task.text)}
        meta={[dueWords(task, today, firstDay, view === 'due'), task.project && readable(task.project)].filter(Boolean).join(' · ')}
        editing={editing === key}
        onEditing={(on) => setEditing(on ? key : null)}
        // By page, the section is the note.
        onOpen={view === 'due' ? onOpen : undefined}
        typing={typing}
        onDone={onDone}
        onEdit={onEdit}
        {...opens}
      />
    )
  }
  return (
    <>
      <ViewerHeader name="Tasks" status={open > 0 ? countOf(open, 'open task') : ''}>
        <span className="view-switch" role="group" aria-label="Order">
          {(['due', 'page'] as const).map((one) => (
            <button key={one} className="header-action" aria-pressed={view === one} onClick={() => onView(one)}>
              {one === 'due' ? 'Due' : 'Page'}
            </button>
          ))}
        </span>
      </ViewerHeader>
      <ul className="file-list">
        <NewTask typing={typing} onAdd={onAdd} {...opens} />
      </ul>
      {!tasks ? (
        <Section title="Tasks" count={0} startOpen>
          <li style={{ paddingLeft: stepIn(1) }}>
            <NoteRow icon={<RowIcon />} name={READING} disabled />
          </li>
        </Section>
      ) : view === 'due' ? (
        [...tasksByWhen(tasks, today, firstDay)]
          .filter(([, inIt]) => inIt.length > 0)
          .map(([when, inIt]) => (
            <Section key={when} title={when} count={inIt.length} startOpen={when !== 'Done'}>
              {inIt.map(row)}
            </Section>
          ))
      ) : (
        tasksByNote(tasks).map(({ note, tasks: onIt }) => (
          <Section key={note.path} title={note.name} count={onIt.filter((one) => !one.done).length} startOpen onOpen={() => onOpen(note)}>
            {onIt.map(row)}
          </Section>
        ))
      )}
    </>
  )
}

/**
 * One task: its box, then its words and when it is due, which a press edits in place,
 * then the note it is in, when its section is not that note.
 */
function TaskRow({
  task,
  words,
  meta,
  editing,
  onEditing,
  onOpen,
  typing,
  onDone,
  onEdit,
  ...opens
}: {
  task: Task
  words: string
  meta: string
  editing: boolean
  onEditing: (on: boolean) => void
  onOpen?: (file: VaultFile) => void
  typing: Typing
  onDone: (task: Task, done: boolean) => void
  onEdit: (task: Task, text: string) => void
} & Opens) {
  const done = (text: string) => {
    onEditing(false)
    // Emptied is not deleted: a line's removal is the note's to make.
    if (text.trim() !== '' && text.trim() !== task.text) onEdit(task, text)
  }
  return (
    <li className={task.done ? 'task-row done' : 'task-row'} style={{ paddingLeft: stepIn(1) }}>
      <button className="task-box" role="checkbox" aria-checked={task.done} aria-label={`${words}: done`} onClick={() => onDone(task, !task.done)}>
        {task.done && <CheckIcon />}
      </button>
      {editing ? (
        <LineEditor className="task-what line-edit" text={task.text} typing={typing} onEnter={done} onLeave={done} onEscape={() => onEditing(false)} {...opens} />
      ) : (
        <NoteRow icon={null} name={words} title={task.text} trailing={meta && <span className="row-count">{meta}</span>} onClick={() => onEditing(true)} />
      )}
      {onOpen && (
        <button className="task-note" onClick={() => onOpen(task.note)}>
          {task.note.name}
        </button>
      )}
    </li>
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

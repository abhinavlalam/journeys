import { useState } from 'react'
import { firstWeekday } from './calendar'
import { dayDate, localDateStamp, relativeDay } from './clock'
import { CheckIcon, ChevronIcon } from './icons'
import { LineEditor, type Typing } from './LineEditor'
import { Live } from './Live'
import { onAndroid } from './platform'
import type { PropertyType } from './properties'
import { countOf, NoteRow, READING, readable, RowIcon, Section, stepIn } from './rows'
import { TASK, tasksByNote, tasksByWhen, taskWords, whenOf, type Task } from './tasks'
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
  colours,
  ...opens
}: {
  /** Null while the vault is still being read. */
  tasks: Task[] | null
  /** Each tag's colour (`coloursOf`), for its chips in a task's words. */
  colours: Readonly<Record<string, string>>
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
        words={taskWords(task.text, typeOf)}
        meta={[dueWords(task, today, firstDay, view === 'due'), task.project && readable(task.project)].filter(Boolean).join(' · ')}
        editing={editing === key}
        onEditing={(on) => setEditing(on ? key : null)}
        // By page, the section is the note.
        onOpen={view === 'due' ? onOpen : undefined}
        typing={typing}
        onDone={onDone}
        onEdit={onEdit}
        colours={colours}
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
 * One task: the fold of what is under it, when anything is; its box; its words, read as
 * the note shows them and wrapped, and when it is due, which a press edits in place;
 * then the note it is in, when its section is not that note. A link or a tag in the
 * words opens what it names instead. Its parts sit in a `div`: as a list item's own
 * buttons, `.file-list li > button` made each a full-width row.
 */
function TaskRow({
  task,
  words,
  meta,
  editing,
  onEditing,
  onOpen,
  colours,
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
  colours: Readonly<Record<string, string>>
  typing: Typing
  onDone: (task: Task, done: boolean) => void
  onEdit: (task: Task, text: string) => void
} & Opens) {
  const [open, setOpen] = useState(false)
  const label = readable(words)
  const done = (text: string) => {
    onEditing(false)
    // Emptied is not deleted: a line's removal is the note's to make.
    if (text.trim() !== '' && text.trim() !== task.text) onEdit(task, text)
  }
  return (
    <li style={{ paddingLeft: stepIn(1) }}>
      <div className={task.done ? 'task-row done' : 'task-row'}>
        {task.below.some((line) => line.trim() !== '') ? (
          <button className="task-fold" aria-expanded={open} aria-label={`What is under ${label}`} onClick={() => setOpen((was) => !was)}>
            <ChevronIcon open={open} />
          </button>
        ) : (
          <span className="task-fold" aria-hidden />
        )}
        <button className="task-box" role="checkbox" aria-checked={task.done} aria-label={`${label}: done`} onClick={() => onDone(task, !task.done)}>
          {task.done && <CheckIcon />}
        </button>
        <span className="task-body">
          <span className="task-line">
            {editing ? (
              <LineEditor className="task-what line-edit" text={task.text} typing={typing} onEnter={done} onLeave={done} onEscape={() => onEditing(false)} {...opens} />
            ) : (
              <span
                className="task-what"
                role="button"
                tabIndex={0}
                title={task.text}
                onClick={() => onEditing(true)}
                onKeyDown={(event) => event.key === 'Enter' && (event.preventDefault(), onEditing(true))}
              >
                <span className="task-words">
                  <Live text={words} colours={colours} {...opens} />
                </span>
                {meta && <span className="row-count">{meta}</span>}
              </span>
            )}
            {onOpen && (
              <button className="task-note" onClick={() => onOpen(task.note)}>
                {task.note.name}
              </button>
            )}
          </span>
          {open && (
            <span className="task-below">
              {task.below.map((line, at) => (
                <span key={at} className="task-below-line">
                  <Live text={line} colours={colours} {...opens} />
                </span>
              ))}
            </span>
          )}
        </span>
      </div>
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
    <li style={{ paddingLeft: stepIn(1) }}>
      <div className="task-row task-new">
        <span className="task-fold" aria-hidden />
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
      </div>
    </li>
  )
}

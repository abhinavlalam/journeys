import { useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { EditorView } from '@codemirror/view'
import { LEADING_CLOCK, localDateStamp, localTimeStamp } from './clock'
import { EVENT_PROPERTIES, eventText, SOURCE } from './calendar'
import { PlusIcon } from './icons'
import type { Typing } from './LineEditor'
import { MarkdownEditor } from './MarkdownEditor'
import { EmptyRow, NoteRow, RowIcon, stepIn } from './rows'
import { AddForm, now, type FormField } from './trackerParts'

/** What the phone's + is adding, or its menu. */
export type Adding = 'menu' | 'note' | 'expense' | 'food' | 'habit' | 'file' | 'event' | 'page'

/** What the + offers, in its menu's order. */
const CHOICES = [
  { step: 'note', icon: 'pen', name: 'Note', hint: 'a line in today, in its section' },
  { step: 'expense', icon: 'money', name: 'Expense', hint: 'a row in the expenses table' },
  { step: 'food', icon: 'food', name: 'Something eaten', hint: 'a row in the calories table' },
  { step: 'habit', icon: 'target', name: 'Habit', hint: 'ticked for today' },
  { step: 'file', icon: 'image', name: 'Photo or file', hint: 'kept in the vault, linked from today' },
  { step: 'event', icon: 'calendar', name: 'Event', hint: 'on its day, in the calendar' },
  { step: 'page', icon: 'page', name: 'New note', hint: 'a page of its own' },
] as const

interface CaptureProps {
  adding: Adding | null
  onAdding: (next: Adding | null) => void
  typing: Typing
  /** Every folder, for where a new note goes. */
  folders: string[]
  /** What is typed in the note's line, kept while the sheet is closed. */
  draft: MutableRefObject<string>
  /** Files a line in a day's note (today's when `day` is absent); says whether it went through. */
  onLine: (day: string | undefined, text: string) => Promise<boolean>
  /** The trackers' forms: an expense's and a thing eaten's fields, null where the tracker has no table yet. */
  forms: { expense: readonly FormField[] | null; food: readonly FormField[] | null }
  /** Adds a row to a tracker's table; says whether it went through. */
  onRow: (tracker: 'expenses' | 'calories', record: Record<string, string>) => Promise<boolean>
  /** Today's habits, null with no habits table; and a habit ticked or not. */
  habits: readonly { name: string; done: boolean }[] | null
  onTick: (habit: string, done: boolean) => Promise<boolean>
  /** Keeps files in the vault and files a line linking them in today. */
  onFiles: (files: File[], caption: string, clock: string) => Promise<boolean>
  /** Makes a note and opens it. */
  onPage: (folder: string, name: string) => Promise<boolean>
  onOpenLink: (target: string, wiki: boolean) => void
  onOpenTag: (tag: string) => void
}

/**
 * The phone's capture: a + at the bottom right of every page, and a sheet of what it
 * adds. A note's line goes in today, in the section its kind says; an expense or a
 * thing eaten is a row of its tracker's table, as the Trackers page adds one; a habit
 * is ticked for today; an event is written as the calendar writes one. Nothing typed on
 * the phone reads differently from what the laptop writes. You stay on the page you
 * were on; the sheet closes once it is written.
 */
export function Capture(props: CaptureProps) {
  const { adding, onAdding } = props
  const done = (went: boolean) => went && onAdding(null)
  const title = adding === 'menu' ? 'Add' : CHOICES.find((one) => one.step === adding)?.name
  return (
    <>
      {adding === null && (
        <button className="capture-plus" aria-label="Add" onClick={() => onAdding('menu')}>
          <PlusIcon />
        </button>
      )}
      {adding !== null && (
        <div className="capture-scrim" onClick={(event) => event.target === event.currentTarget && onAdding(null)}>
          <div className="capture-sheet" role="dialog" aria-label={title}>
            <header className="capture-header">
              <span>{title}</span>
              <button aria-label="Close" onClick={() => onAdding(null)}>
                ×
              </button>
            </header>
            {adding === 'menu' && (
              <ul className="file-list capture-list">
                {CHOICES.map((one) => (
                  <li key={one.step} className="note-row" style={{ paddingLeft: stepIn(1) }}>
                    <NoteRow
                      icon={<RowIcon icon={one.icon} />}
                      name={one.name}
                      trailing={<span className="row-count">{one.hint}</span>}
                      onClick={() => onAdding(one.step)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {adding === 'note' && <NoteForm {...props} onLine={(text) => props.onLine(undefined, text).then(done)} />}
            {adding === 'expense' && (
              <TrackerForm
                label="An expense"
                fields={props.forms.expense}
                table="expenses"
                onAdd={(record) => props.onRow('expenses', now(record)).then(done)}
              />
            )}
            {adding === 'food' && (
              <TrackerForm
                label="Something eaten"
                fields={props.forms.food}
                table="calories"
                onAdd={(record) => props.onRow('calories', now(record)).then(done)}
              />
            )}
            {adding === 'habit' && <HabitTicks habits={props.habits} onTick={props.onTick} />}
            {adding === 'event' && <EventForm onLine={(day, text) => props.onLine(day, text).then(done)} />}
            {adding === 'file' && <FileForm onFiles={(files, caption, clock) => props.onFiles(files, caption, clock).then(done)} />}
            {adding === 'page' && <PageForm folders={props.folders} onPage={(folder, name) => props.onPage(folder, name).then(done)} />}
          </div>
        </div>
      )}
    </>
  )
}

/** A form's row: its name above its control, as the settings are laid out on a phone. */
function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <label className="capture-field">
      <span>{name}</span>
      {children}
    </label>
  )
}

function Submit({ disabled, children }: { disabled?: boolean; children: string }) {
  return (
    <div className="capture-actions">
      <button className="capture-add" disabled={disabled}>
        {children}
      </button>
    </div>
  )
}

/** A time, empty unless set: a line is filed as typed, and Now fills it. */
function When({ value, onChange }: { value: string; onChange: (clock: string) => void }) {
  return (
    <Field name="When">
      <span className="capture-when">
        <input type="time" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
        <button type="button" onClick={() => onChange(localTimeStamp())}>
          Now
        </button>
      </span>
    </Field>
  )
}

/**
 * A line in today, typed as a note's line is ([[ and tag popups). Now starts it with
 * the time and leaves the caret where it was; the button keeps the keyboard.
 */
function NoteForm({ draft, typing, onOpenLink, onOpenTag, onLine }: Omit<CaptureProps, 'onLine'> & { onLine: (text: string) => Promise<unknown> }) {
  const box = useRef<HTMLDivElement>(null)
  const view = () => {
    const dom = box.current?.querySelector<HTMLElement>('.cm-editor')
    return dom ? EditorView.findFromDOM(dom) : null
  }
  const file = (text: string) => {
    if (!text.trim()) return
    draft.current = ''
    void onLine(text.trim())
  }
  const now = () => {
    const editor = view()
    if (!editor) return
    const line = editor.state.doc.toString()
    const clock = LEADING_CLOCK.exec(line)?.[0] ?? ''
    const changes = editor.state.changes({ from: 0, to: clock.length + (line[clock.length] === ' ' ? 1 : 0), insert: `${localTimeStamp()} ` })
    editor.dispatch({ changes, selection: editor.state.selection.map(changes, 1), userEvent: 'input' })
    editor.focus()
  }
  return (
    <div className="capture-form" ref={box}>
      <div className="capture-line">
        <MarkdownEditor
          initialMarkdown={draft.current}
          caretAtEnd
          {...typing}
          onOpenLink={onOpenLink}
          onOpenTag={onOpenTag}
          onChange={(text) => (draft.current = text)}
          line={{ onEnter: file, onEscape: () => {} }}
        />
      </div>
      <div className="capture-actions">
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={now}>
          Now
        </button>
        <button type="button" className="capture-add" onMouseDown={(event) => event.preventDefault()} onClick={() => file(view()?.state.doc.toString() ?? '')}>
          Add
        </button>
      </div>
    </div>
  )
}

/** A tracker's row, the Trackers page's own form; a tracker with no table says where to make one. */
function TrackerForm({
  label,
  fields,
  table,
  onAdd,
}: {
  label: string
  fields: readonly FormField[] | null
  table: string
  onAdd: (record: Record<string, string>) => unknown
}) {
  if (!fields)
    return (
      <ul className="file-list capture-list">
        <EmptyRow text={`No ${table} table yet: Trackers asks for one.`} />
      </ul>
    )
  return <AddForm label={label} fields={fields} onAdd={onAdd} />
}

/** Today's habits, each pressed to tick it or take the tick back; the sheet stays, for the next. */
function HabitTicks({ habits, onTick }: { habits: readonly { name: string; done: boolean }[] | null; onTick: (habit: string, done: boolean) => unknown }) {
  if (!habits?.length)
    return (
      <ul className="file-list capture-list">
        <EmptyRow text={habits ? 'No habits yet: Trackers → Habits adds one.' : 'No habits table yet: Trackers asks for one.'} />
      </ul>
    )
  return (
    <div className="tracker-ticks capture-ticks">
      {habits.map((one) => (
        <button key={one.name} className="tracker-tick" aria-pressed={one.done} onClick={() => onTick(one.name, !one.done)}>
          {one.name}
        </button>
      ))}
    </div>
  )
}

/** An event, written into its day's note as the calendar writes one, so the calendar shows it. */
function EventForm({ onLine }: { onLine: (day: string, text: string) => Promise<unknown> }) {
  const properties = EVENT_PROPERTIES.filter((name) => name.toLowerCase() !== SOURCE)
  const [what, setWhat] = useState('')
  const [day, setDay] = useState(localDateStamp())
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const clock = from && to ? `${from} to ${to}` : from
  const line = () =>
    eventText(properties, {
      clock,
      what: what.trim(),
      fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name.toLowerCase(), value.trim()])),
    })
  return (
    <form className="capture-form" onSubmit={(event) => (event.preventDefault(), what.trim() && void onLine(day, line()))}>
      <Field name="What">
        <input type="text" value={what} onChange={(event) => setWhat(event.currentTarget.value)} autoFocus />
      </Field>
      <Field name="Day">
        <input type="date" value={day} onChange={(event) => setDay(event.currentTarget.value || localDateStamp())} />
      </Field>
      <Field name="From">
        <input type="time" value={from} onChange={(event) => setFrom(event.currentTarget.value)} />
      </Field>
      <Field name="To">
        <input type="time" value={to} onChange={(event) => setTo(event.currentTarget.value)} />
      </Field>
      {properties.map((name) => (
        <Field key={name} name={name}>
          <input
            type="text"
            autoCapitalize="off"
            value={fields[name] ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value
              setFields((was) => ({ ...was, [name]: value }))
            }}
          />
        </Field>
      ))}
      <Submit>Add</Submit>
    </form>
  )
}

/** Photos or files from the phone, kept in the vault and linked from a line in today. */
function FileForm({ onFiles }: { onFiles: (files: File[], caption: string, clock: string) => Promise<unknown> }) {
  const [files, setFiles] = useState<File[]>([])
  const [caption, setCaption] = useState('')
  const [clock, setClock] = useState('')
  return (
    <form className="capture-form" onSubmit={(event) => (event.preventDefault(), files.length > 0 && void onFiles(files, caption.trim(), clock))}>
      <Field name="Files">
        <input type="file" multiple onChange={(event) => setFiles([...(event.currentTarget.files ?? [])])} />
      </Field>
      <When value={clock} onChange={setClock} />
      <Field name="Caption">
        <input type="text" value={caption} onChange={(event) => setCaption(event.currentTarget.value)} />
      </Field>
      <Submit disabled={files.length === 0}>Add</Submit>
    </form>
  )
}

/** A new note: its name and the folder it goes in. It opens once made. */
function PageForm({ folders, onPage }: { folders: string[]; onPage: (folder: string, name: string) => Promise<unknown> }) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  return (
    <form className="capture-form" onSubmit={(event) => (event.preventDefault(), name.trim() && void onPage(folder, name.trim()))}>
      <Field name="Name">
        <input type="text" value={name} onChange={(event) => setName(event.currentTarget.value)} autoFocus autoCapitalize="off" />
      </Field>
      <Field name="In">
        <select value={folder} onChange={(event) => setFolder(event.currentTarget.value)}>
          <option value="">The top of the vault</option>
          {folders.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
      </Field>
      <Submit>Make it</Submit>
    </form>
  )
}

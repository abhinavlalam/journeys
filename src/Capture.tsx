import { useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { EditorView } from '@codemirror/view'
import { LEADING_CLOCK, localDateStamp, localTimeStamp } from './clock'
import { EVENT, EVENT_PROPERTIES, eventText } from './calendar'
import type { Entries } from './configEntries'
import { PlusIcon } from './icons'
import { MarkdownEditor } from './MarkdownEditor'
import type { PropertyType } from './properties'
import { NoteRow, RowIcon, stepIn } from './rows'
import { propertiesOf, tagLine } from './tags'
import type { VaultFile } from './vaultModel'

/** What the phone's + is adding, or its menu. */
export type Adding = 'menu' | 'note' | 'tags' | { tag: string } | 'file' | 'event' | 'page'

/** What the + offers, in its menu's order. */
const CHOICES = [
  { step: 'note', icon: 'pen', name: 'Note', hint: 'a line in today' },
  { step: 'tags', icon: 'tag', name: 'Tag', hint: 'a line of one of your tags' },
  { step: 'file', icon: 'image', name: 'Photo or file', hint: 'kept in Files, linked from today' },
  { step: 'event', icon: 'calendar', name: 'Event', hint: 'on its day, in the calendar' },
  { step: 'page', icon: 'page', name: 'New note', hint: 'a page of its own' },
] as const

/** The calendar's own property, which the sync writes and a typed event leaves out. */
const SOURCE = 'source'

interface CaptureProps {
  adding: Adding | null
  onAdding: (next: Adding | null) => void
  notes: VaultFile[]
  /** Every folder, for where a new note goes. */
  folders: string[]
  propertyTypes: Entries
  tagStructures: Entries
  typeOf: (name: string) => PropertyType
  /** What is typed in the note's line, kept while the sheet is closed. */
  draft: MutableRefObject<string>
  /** Files a line in a day's note (today's when `day` is absent); says whether it went through. */
  onLine: (day: string | undefined, text: string) => Promise<boolean>
  /** Keeps files in the vault and files a line linking them in today. */
  onFiles: (files: File[], caption: string, clock: string) => Promise<boolean>
  /** Makes a note and opens it. */
  onPage: (folder: string, name: string) => Promise<boolean>
  onOpenLink: (target: string, wiki: boolean) => void
  onOpenTag: (tag: string) => void
}

/**
 * The phone's capture: a + at the bottom right of every page, and a sheet of what it
 * adds. Each choice is a small form that writes one line in the vault's own form
 * (a tag's line in its structure's order, an event as the calendar writes one), so
 * nothing typed on the phone reads differently from what the laptop writes. You stay
 * on the page you were on; the sheet closes once the line is written.
 */
export function Capture(props: CaptureProps) {
  const { adding, onAdding } = props
  const done = (went: boolean) => went && onAdding(null)
  const title =
    adding === 'menu' ? 'Add' : adding === 'tags' ? 'Tag' : typeof adding === 'object' && adding ? `#${adding.tag}` : CHOICES.find((one) => one.step === adding)?.name
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
            {adding === 'tags' && (
              <ul className="file-list capture-list">
                {Object.keys(props.tagStructures)
                  .filter((tag) => tag !== EVENT)
                  .sort()
                  .map((tag) => (
                    <li key={tag} className="note-row" style={{ paddingLeft: stepIn(1) }}>
                      <NoteRow
                        icon={<RowIcon icon="tag" />}
                        name={`#${tag}`}
                        trailing={<span className="row-count">{propertiesOf(props.tagStructures, tag).join(', ')}</span>}
                        onClick={() => onAdding({ tag })}
                      />
                    </li>
                  ))}
              </ul>
            )}
            {adding === 'note' && <NoteForm {...props} onLine={(text) => props.onLine(undefined, text).then(done)} />}
            {typeof adding === 'object' && adding && (
              <TagForm {...props} tag={adding.tag} onLine={(text) => props.onLine(undefined, text).then(done)} />
            )}
            {adding === 'event' && <EventForm {...props} onLine={(day, text) => props.onLine(day, text).then(done)} />}
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
function NoteForm({ draft, notes, propertyTypes, tagStructures, onOpenLink, onOpenTag, onLine }: Omit<CaptureProps, 'onLine'> & { onLine: (text: string) => Promise<unknown> }) {
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
          notes={notes}
          propertyTypes={propertyTypes}
          tagStructures={tagStructures}
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

/** A control for a property's value, by its type: a number keypad, a date picker, a note's name. */
function ValueInput({ type, value, onChange, notes }: { type: PropertyType; value: string; onChange: (value: string) => void; notes: string }) {
  const common = { value, onChange: (event: { currentTarget: HTMLInputElement }) => onChange(event.currentTarget.value) }
  if (type === 'number') return <input {...common} type="text" inputMode="decimal" />
  if (type === 'date') return <input {...common} type="date" />
  if (type === 'url') return <input {...common} type="url" />
  return <input {...common} type="text" list={type === 'backlink' ? notes : undefined} autoCapitalize="off" />
}

/** The notes' names, for a backlink's suggestions. */
function NoteNames({ id, notes }: { id: string; notes: VaultFile[] }) {
  return (
    <datalist id={id}>
      {notes.map((one) => (
        <option key={one.path} value={one.name} />
      ))}
    </datalist>
  )
}

/** One of the vault's tags as a form: its words and each property of its structure. */
function TagForm({ tag, tagStructures, typeOf, notes, onLine }: Omit<CaptureProps, 'onLine'> & { tag: string; onLine: (text: string) => Promise<unknown> }) {
  const properties = propertiesOf(tagStructures, tag)
  const [clock, setClock] = useState('')
  const [what, setWhat] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  return (
    <form className="capture-form" onSubmit={(event) => (event.preventDefault(), void onLine(tagLine(tag, properties, { clock, what, fields }, typeOf)))}>
      <NoteNames id="capture-notes" notes={notes} />
      <When value={clock} onChange={setClock} />
      <Field name="What">
        <input type="text" value={what} onChange={(event) => setWhat(event.currentTarget.value)} autoFocus />
      </Field>
      {properties.map((name) => (
        <Field key={name} name={name}>
          <ValueInput type={typeOf(name)} value={fields[name] ?? ''} onChange={(value) => setFields((was) => ({ ...was, [name]: value }))} notes="capture-notes" />
        </Field>
      ))}
      <div className="capture-actions">
        <button className="capture-add">Add</button>
      </div>
    </form>
  )
}

/** An event, written into its day's note as the calendar writes one, so the calendar shows it. */
function EventForm({ tagStructures, onLine }: Omit<CaptureProps, 'onLine'> & { onLine: (day: string, text: string) => Promise<unknown> }) {
  const declared = propertiesOf(tagStructures, EVENT)
  const properties = (declared.length > 0 ? declared : EVENT_PROPERTIES).filter((name) => name.toLowerCase() !== SOURCE)
  const [what, setWhat] = useState('')
  const [day, setDay] = useState(localDateStamp())
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const clock = from && to ? `${from} to ${to}` : from
  const line = () => eventText(properties, { clock, what: what.trim(), fields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name.toLowerCase(), value.trim()])) })
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
          <ValueInput type="text" value={fields[name] ?? ''} onChange={(value) => setFields((was) => ({ ...was, [name]: value }))} notes="" />
        </Field>
      ))}
      <div className="capture-actions">
        <button className="capture-add">Add</button>
      </div>
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
      <div className="capture-actions">
        <button className="capture-add" disabled={files.length === 0}>
          Add
        </button>
      </div>
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
      <div className="capture-actions">
        <button className="capture-add">Make it</button>
      </div>
    </form>
  )
}

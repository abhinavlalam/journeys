import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { clockText, dayTitle, lengthOf, localDateStamp } from './clock'
import type { Entries } from './configEntries'
import { MarkdownEditor } from './MarkdownEditor'
import type { PropertyType } from './properties'
import { countOf, NoteRow, READING, readable, RowIcon, Section, stepIn } from './rows'
import { TAG_NAME, tagNames } from './tags'
import { fieldsOf, totalsOf, wordsOf, type TimelineDay, type TimelineEntry } from './timeline'
import { ViewerHeader } from './ViewerHeader'
import { linkLabelSpan, type VaultFile } from './vaultModel'

/** Places a total is rounded to, as a tag's table rounds its sums. */
const TOTAL_DECIMALS = 2

interface Opens {
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string) => void
  onOpenTag: (tag: string) => void
}

/** What an entry's editor is typed with, as a note's is: the `[[` picker's notes,
 *  the property popup's structures and types, and the key that writes the time. */
interface Typing {
  notes: VaultFile[]
  propertyTypes: Entries
  tagStructures: Entries
  insertTimeCombo: string | null
}

/**
 * The timeline: every daily note as the day happened, **oldest at the top and today
 * at the bottom**, the way a log reads — the page opens at its end. Each day is its
 * entries by clock, whichever group of the note each is written in; a moment is a
 * point on the day's rail and a block of time a bar, with how long it lasted. A tag
 * drawn as a table shows its entries' fields, and the day's totals close the day.
 *
 * **A press on an entry edits it**, its one line under the note's own editor; a
 * day's name opens its note; and a new entry is typed at the bottom of today.
 */
export function TimelineView({
  days,
  tables,
  typeOf,
  typing,
  onEdit,
  onAdd,
  ...opens
}: {
  /** Null while the vault is still being read. */
  days: TimelineDay[] | null
  /** Every tag drawn as a table, with its structure (`tablesOf`). */
  tables: Record<string, string[]>
  typeOf: (name: string) => PropertyType
  typing: Typing
  /** An entry's line was edited to read `text`. */
  onEdit: (entry: TimelineEntry, text: string) => void
  /** A new entry was typed at the bottom of today. */
  onAdd: (text: string) => void
} & Opens) {
  const today = localDateStamp()
  /** The entry being edited, by its note and line: one at a time. */
  const [editing, setEditing] = useState<string | null>(null)
  const keyOf = (entry: TimelineEntry) => `${entry.note.path}\n${entry.at}`
  const end = useRef<HTMLLIElement>(null)
  const read = days !== null
  // Today at the bottom, like a log: the page opens there, once there is a page.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [read])
  const total = days?.reduce((sum, one) => sum + one.entries.length, 0) ?? 0
  // **Today is one section, in its place**, for the line a new entry is typed on —
  // with nothing written yet, and before the days ahead a calendar has written.
  const shown: { day: string; note: VaultFile | null; entries: TimelineEntry[] }[] =
    !days || days.some((one) => one.day === today)
      ? (days ?? [])
      : [...days, { day: today, note: null, entries: [] }].sort((a, b) => a.day.localeCompare(b.day))
  const editorFor = (entry: TimelineEntry) => {
    const done = (text: string) => {
      setEditing(null)
      // Emptied is not deleted: what is nested under it would lose its line.
      if (text.trim() !== '' && text.trim() !== entry.text) onEdit(entry, text)
    }
    return <EntryEditor text={entry.text} typing={typing} onEnter={done} onLeave={done} onEscape={() => setEditing(null)} {...opens} />
  }
  const newEntry = <NewEntry typing={typing} onAdd={onAdd} rowRef={end} {...opens} />

  return (
    <>
      <ViewerHeader name="Timeline" status={total > 0 ? countOf(total, 'entry', 'entries') : ''} />
      {!read && (
        <Section title="Days" count={0} startOpen>
          <li style={{ paddingLeft: stepIn(1) }}>
            <NoteRow icon={<RowIcon />} name={READING} disabled />
          </li>
        </Section>
      )}
      {shown.map(({ note, ...day }) => (
        <Section
          key={day.day}
          title={dayTitle(day.day, today)}
          count={day.entries.length}
          startOpen
          onOpen={note ? () => opens.onOpen(note) : undefined}
        >
          <li className="timeline-box">
            <ol className="timeline-entries">
              {day.entries.map((entry) => (
                <Entry
                  key={entry.at}
                  entry={entry}
                  tables={tables}
                  typeOf={typeOf}
                  editor={editing === keyOf(entry) && editorFor(entry)}
                  onPress={() => setEditing(keyOf(entry))}
                  {...opens}
                />
              ))}
              {day.day === today && newEntry}
            </ol>
            <Totals entries={day.entries} tables={tables} typeOf={typeOf} />
          </li>
        </Section>
      ))}
    </>
  )
}

/** One entry: its clock, its mark on the rail, what it says — or, while it is being
 *  edited, its `editor` — and its group. */
function Entry({
  entry,
  tables,
  typeOf,
  editor,
  onPress,
  ...opens
}: {
  entry: TimelineEntry
  tables: Record<string, string[]>
  typeOf: (name: string) => PropertyType
  editor: ReactNode
  onPress: () => void
} & Opens) {
  const fields = fieldsOf(entry.text, tables, typeOf)
  const block = entry.end !== null
  // The group says what the entry's own tags do not: `#food` under `#diet`.
  const group = entry.group && !tagNames(entry.text).includes(entry.group) ? entry.group : null
  return (
    <li className={block ? 'timeline-entry block' : 'timeline-entry'} onClick={onPress}>
      <span className="timeline-when">
        {clockText(entry.start)}
        {block && `–${clockText(entry.end!)}`}
        {block && <span className="timeline-length">{lengthOf(entry.end! - entry.start)}</span>}
      </span>
      <span className="timeline-rail" aria-hidden />
      {editor || (
        <span className="timeline-what">
          <Live text={wordsOf(entry, typeOf, fields.length > 0)} {...opens} />
          {fields.length > 0 && (
            <span className="timeline-fields">
              {fields.map((one) => (
                <span key={one.name} className="timeline-field">
                  <span className="timeline-field-name">{one.name}</span> <Live text={one.value} {...opens} />
                </span>
              ))}
            </span>
          )}
          {entry.below.map((line, at) => (
            <span key={at} className="timeline-below">
              {readable(line)}
            </span>
          ))}
        </span>
      )}
      {group && <span className="timeline-group">{group}</span>}
    </li>
  )
}

/**
 * A line under the note's own editor — its syntax, its popups, Tab — and ended
 * **once**, whichever of Enter, Escape and leaving it comes first: the press that
 * ends it can blur it too, and a second write would find its line already changed.
 */
function EntryEditor({
  text,
  typing,
  onEnter,
  onEscape,
  onLeave,
  onOpenLink,
  onOpenTag,
}: {
  text: string
  typing: Typing
  onEnter: (text: string) => void
  onEscape: () => void
  onLeave?: (text: string) => void
} & Opens) {
  const finished = useRef(false)
  const once = (then: () => void) => {
    if (finished.current) return
    finished.current = true
    then()
  }
  return (
    <span className="timeline-what timeline-edit">
      <MarkdownEditor
        initialMarkdown={text}
        caretAtEnd
        notes={typing.notes}
        propertyTypes={typing.propertyTypes}
        tagStructures={typing.tagStructures}
        insertTimeCombo={typing.insertTimeCombo}
        onOpenLink={onOpenLink}
        onOpenTag={onOpenTag}
        onChange={() => {}}
        line={{
          onEnter: (line) => once(() => onEnter(line)),
          onEscape: () => once(onEscape),
          onLeave: onLeave && ((line) => once(() => onLeave(line))),
        }}
      />
    </span>
  )
}

/**
 * The line a new entry is typed on, at the bottom of today: Enter files it and
 * starts the next, Escape starts over, and leaving it keeps what is typed — a draft,
 * until it is filed.
 */
function NewEntry({
  typing,
  onAdd,
  rowRef,
  ...opens
}: { typing: Typing; onAdd: (text: string) => void; rowRef: RefObject<HTMLLIElement | null> } & Opens) {
  // A fresh line each round: the editor's text is read at mount only.
  const [round, setRound] = useState(0)
  const next = () => setRound((was) => was + 1)
  return (
    <li className="timeline-entry timeline-new" ref={rowRef}>
      <span className="timeline-when" />
      <span className="timeline-rail" aria-hidden />
      <EntryEditor
        key={round}
        text=""
        typing={typing}
        onEnter={(text) => {
          if (text.trim() !== '') onAdd(text.trim())
          next()
        }}
        onEscape={next}
        {...opens}
      />
    </li>
  )
}

/** The day's totals for each table tag's `number` fields, closing the day. */
function Totals({
  entries,
  tables,
  typeOf,
}: {
  entries: readonly TimelineEntry[]
  tables: Record<string, string[]>
  typeOf: (name: string) => PropertyType
}) {
  const totals = totalsOf(entries, tables, typeOf)
  if (totals.length === 0) return null
  return (
    <p className="timeline-totals">
      {totals.map((one) => (
        <span key={`${one.tag} ${one.name}`} className="timeline-field">
          <span className="timeline-field-name">
            #{one.tag} {one.name}
          </span>{' '}
          {Number(one.total.toFixed(TOTAL_DECIMALS))}
        </span>
      ))}
    </p>
  )
}

const LIVE = new RegExp(String.raw`\[\[([^\]\n]+)\]\]|(^|\s)#(${TAG_NAME})`, 'g')

/** Words with their links and tags live: a link opens its note, a tag its page —
 *  and neither opens the entry's note as well. */
function Live({ text, onOpenLink, onOpenTag }: { text: string } & Opens) {
  const parts: ReactNode[] = []
  let at = 0
  for (const hit of text.matchAll(LIVE)) {
    const start = hit.index ?? 0
    const lead = hit[2] ?? ''
    parts.push(text.slice(at, start) + lead)
    if (hit[1]) {
      const inner = hit[1]
      const shown = linkLabelSpan(inner)
      parts.push(
        <button key={start} className="line-link" onClick={(event) => (event.stopPropagation(), onOpenLink(inner.split('|')[0].trim()))}>
          {inner.slice(shown.from, shown.to).trim()}
        </button>
      )
    } else {
      parts.push(
        <button key={start} className="timeline-tag" onClick={(event) => (event.stopPropagation(), onOpenTag(hit[3].toLowerCase()))}>
          #{hit[3]}
        </button>
      )
    }
    at = start + hit[0].length
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}

import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { clockText, dayDate, daysBetween, lengthOf, localDateStamp, relativeDay } from './clock'
import type { Entries } from './configEntries'
import { MarkdownEditor } from './MarkdownEditor'
import { onAndroid } from './platform'
import type { PropertyType } from './properties'
import { countOf, NoteRow, READING, RowIcon, Section, stepIn } from './rows'
import { ChevronIcon } from './icons'
import { DayTotals } from './DayTotals'
import { tagNames, type DayTotal } from './tags'
import { fieldsOf, wordsOf, type TimelineDay, type TimelineEntry } from './timeline'
import { ViewerHeader } from './ViewerHeader'
import { Live } from './Live'
import type { VaultFile } from './vaultModel'


interface Opens {
  onOpen: (file: VaultFile) => void
  /** A link's target, and whether it was a `[[wikilink]]` rather than a markdown link or an address. */
  onOpenLink: (target: string, wiki: boolean) => void
  onOpenTag: (tag: string) => void
}

/**
 * What an entry's editor types with, as a note's does: the `[[` popup's
 * notes, the property popup's structures and types, and the time key.
 */
interface Typing {
  notes: VaultFile[]
  propertyTypes: Entries
  tagStructures: Entries
  insertTimeCombo: string | null
}

/**
 * The timeline: every daily note as the day happened, oldest at the top
 * and today at the bottom. The page opens at its end. Each day is a page
 * of a journal, headed by its date, its entries by clock whatever group
 * they are written in. A moment is a dot on the rail; a stretch of time is
 * a bar with its length. What is nested under an entry is folded to a
 * count, and opens on a press. A tag drawn as a table shows its fields,
 * and the day ends with its totals.
 *
 * A press on an entry edits it, with the note's own editor on one line. A
 * day's date opens its note. A new entry is typed at the bottom of today.
 */
export function TimelineView({
  days,
  tables,
  totals,
  colours,
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
  /** Each tag's daily totals (`dayTotalsOf`). */
  totals: Record<string, DayTotal[]>
  /** Each tag's colour (`coloursOf`): an entry takes its first tag's. */
  colours: Record<string, string>
  typeOf: (name: string) => PropertyType
  typing: Typing
  /** An entry's line was changed to `text`. */
  onEdit: (entry: TimelineEntry, text: string) => void
  /** A new entry was typed at the bottom of today. */
  onAdd: (text: string) => void
} & Opens) {
  const today = localDateStamp()
  /** The entry being edited, by its note and line. One at a time. */
  const [editing, setEditing] = useState<string | null>(null)
  const keyOf = (entry: TimelineEntry) => `${entry.note.path}\n${entry.at}`
  const end = useRef<HTMLLIElement>(null)
  const read = days !== null
  // Today is at the bottom: the page opens there once it has content.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [read])
  const total = days?.reduce((sum, one) => sum + one.entries.length, 0) ?? 0
  // Today is always one section, in date order, for the new-entry line, even
  // with nothing written and before days a calendar sync has written ahead.
  const shown: { day: string; note: VaultFile | null; entries: TimelineEntry[]; text: string }[] =
    !days || days.some((one) => one.day === today)
      ? (days ?? [])
      : [...days, { day: today, note: null, entries: [], text: '' }].sort((a, b) => a.day.localeCompare(b.day))
  const editorFor = (entry: TimelineEntry) => {
    const done = (text: string) => {
      setEditing(null)
      // Emptied is not deleted: the lines nested under it would lose their parent.
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
        <section key={day.day} className="journal-day">
          <DayHead day={day.day} today={today} count={day.entries.length} onOpen={note ? () => opens.onOpen(note) : undefined} />
          <ol className="timeline-entries">
            {day.entries.map((entry, at) => (
              <Fragment key={entry.at}>
                {partOf(entry.start) !== partOf(day.entries[at - 1]?.start ?? -1) && (
                  <li className="timeline-part" aria-hidden>
                    <span>{partOf(entry.start)}</span>
                  </li>
                )}
                <Entry
                  entry={entry}
                  colours={colours}
                  tables={tables}
                  typeOf={typeOf}
                  editor={editing === keyOf(entry) && editorFor(entry)}
                  onPress={() => setEditing(keyOf(entry))}
                  {...opens}
                />
              </Fragment>
            ))}
            {day.day === today && newEntry}
          </ol>
          <DayTotals text={day.text} totals={totals} typeOf={typeOf} place="timeline" />
        </section>
      ))}
    </>
  )
}

/**
 * The part of the day an entry starts in, so a long day reads in pieces: before
 * five is the night (an entry past midnight is filed on its day), then morning,
 * afternoon from noon, evening from five. Nothing before the first entry.
 */
function partOf(minutes: number): string {
  if (minutes < 0) return ''
  const hour = Math.floor(minutes / 60) % 24
  return hour < 5 ? 'Night' : hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening'
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const month = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

/**
 * A day's head, as a journal's page opens: the day's number large, its weekday
 * (or today, yesterday, tomorrow) and month beside it, and how many entries it
 * holds. The date opens the day's note.
 */
function DayHead({ day, today, count, onOpen }: { day: string; today: string; count: number; onOpen?: () => void }) {
  const date = dayDate(day)
  const near = Math.abs(daysBetween(today, day)) <= 1 ? relativeDay(day, today) : ''
  return (
    <header className={day === today ? 'journal-head today' : 'journal-head'}>
      <button className="journal-date" onClick={onOpen} disabled={!onOpen}>
        <span className="journal-number">{date.getDate()}</span>
        <span className="journal-names">
          <span className="journal-weekday">{near ? `${near.charAt(0).toUpperCase()}${near.slice(1)} · ${weekday.format(date)}` : weekday.format(date)}</span>
          <span className="journal-month">{month.format(date)}</span>
        </span>
      </button>
      {count > 0 && <span className="journal-count">{countOf(count, 'entry', 'entries')}</span>}
    </header>
  )
}

/**
 * One entry: its clock, its mark on the rail, and what it says (or its `editor`
 * while being edited), its fields under it. What is nested under it is a count
 * until pressed open: shown whole, a video's notes buried the rest of the day.
 */
function Entry({
  entry,
  colours,
  tables,
  typeOf,
  editor,
  onPress,
  ...opens
}: {
  entry: TimelineEntry
  colours: Record<string, string>
  tables: Record<string, string[]>
  typeOf: (name: string) => PropertyType
  editor: ReactNode
  onPress: () => void
} & Opens) {
  const fields = fieldsOf(entry.text, tables, typeOf)
  const block = entry.end !== null
  const [open, setOpen] = useState(false)
  const detail = entry.below.filter((line) => line.trim() !== '')
  // The entry's colour is its first coloured tag's: its dot, its wash, its chips.
  const hue = tagNames(entry.text).map((tag) => colours[tag]).find(Boolean)
  const hueOf = (tag: string) => colours[tag]
  return (
    <li className={block ? 'timeline-entry block' : 'timeline-entry'} data-hue={hue} onClick={onPress}>
      <span className="timeline-when">
        {clockText(entry.start)}
        {block && `–${clockText(entry.end!)}`}
        {block && <span className="timeline-length">{lengthOf(entry.end! - entry.start)}</span>}
      </span>
      <span className="timeline-rail" aria-hidden />
      {editor || (
        <span className="timeline-what">
          <Live text={wordsOf(entry, typeOf, fields.length > 0)} hueOf={hueOf} {...opens} />
          {fields.length > 0 && (
            <span className="timeline-fields">
              {fields.map((one) => (
                <span key={one.name} className="timeline-field">
                  <span className="timeline-field-name">{one.name}</span> <Live text={one.value} {...opens} />
                </span>
              ))}
            </span>
          )}
          {detail.length > 0 && (
            <button
              className="timeline-more"
              aria-expanded={open}
              onClick={(event) => (event.stopPropagation(), setOpen((was) => !was))}
            >
              <ChevronIcon open={open} />
              {countOf(detail.length, 'line')}
            </button>
          )}
          {open && (
            <span className="timeline-detail">
              {entry.below.map((line, at) => (
                <span key={at} className="timeline-below">
                  <Live text={line} {...opens} />
                </span>
              ))}
            </span>
          )}
        </span>
      )}
    </li>
  )
}

/**
 * One line in the note's own editor (its syntax, popups, Tab), ended once,
 * by whichever of Enter, Escape or leaving comes first. The press that ends
 * it can also blur it, and a second write would find its line changed.
 */
function EntryEditor({
  text,
  typing,
  onEnter,
  onEscape,
  onLeave,
  autoFocus,
  onOpenLink,
  onOpenTag,
}: {
  text: string
  typing: Typing
  autoFocus?: boolean
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
        autoFocus={autoFocus}
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
 * The line for a new entry at the bottom of today. Enter files it and starts
 * the next; Escape clears it; leaving keeps the draft until it is filed.
 */
function NewEntry({
  typing,
  onAdd,
  rowRef,
  ...opens
}: { typing: Typing; onAdd: (text: string) => void; rowRef: RefObject<HTMLLIElement | null> } & Opens) {
  // A new line each time: the editor reads its text at mount only.
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
        // Not on a phone: the page is opened to read, and the keyboard would cover it.
        autoFocus={!onAndroid}
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


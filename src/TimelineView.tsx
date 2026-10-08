import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { clockText, dayDate, daysAfter, lengthOf, localDateStamp, monthName, nearDay, shortDate, shortWeekday, weekdayName } from './clock'
import { EditLine, NewLine, type Typing } from './LineEditor'
import type { PropertyType } from './properties'
import { countOf, EmptyRow, READING, Section, statusCount } from './rows'
import { ChevronIcon } from './icons'
import { DayTotals } from './DayTotals'
import { dayGrid, QUIET_EM } from './dayGrid'
import { tagNames, type DayTotal } from './tags'
import { fieldsOf, reachOf, withCarried, wordsOf, type Reach, type ShownDay, type TimelineDay, type TimelineEntry } from './timeline'
import { TIMELINE_VIEWS, type Settings } from './settings'
import { ViewerHeader, ViewSwitch } from './ViewerHeader'
import { Live, type Opens as LineOpens } from './Live'
import type { VaultFile } from './vaultModel'

type Opens = LineOpens & { onOpen: (file: VaultFile) => void }

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
  view,
  onView,
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
  /** A list by clock, or a grid where height is time; kept in the vault's settings. */
  view: Settings['timelineView']
  onView: (next: Settings['timelineView']) => void
  /** An entry's line was changed to `text`. */
  onEdit: (entry: TimelineEntry, text: string) => void
  /** A new entry was typed at the bottom of today. */
  onAdd: (text: string) => void
} & Opens) {
  const today = localDateStamp()
  /** The entry being edited, by its note and line. One at a time. */
  const [editing, setEditing] = useState<string | null>(null)
  // With where it starts: a span's part carried into a later day is the same line.
  const keyOf = (entry: TimelineEntry) => `${entry.note.path}\n${entry.at}\n${entry.start}`
  const end = useRef<HTMLLIElement>(null)
  const read = days !== null
  // Today is at the bottom: the page opens there once it has content.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [read])
  const total = days?.reduce((sum, one) => sum + one.entries.length, 0) ?? 0
  // Today is always one section, in date order, for the new-entry line, even
  // with nothing written and before days a calendar sync has written ahead.
  const shown = withCarried(
    !days || days.some((one) => one.day === today)
      ? (days ?? [])
      : [...days, { day: today, note: null, entries: [], text: '' } satisfies ShownDay].sort((a, b) => a.day.localeCompare(b.day))
  )
  const editorFor = (entry: TimelineEntry) => (
    <EditLine className="timeline-what line-edit" text={entry.text} typing={typing} onSave={(text) => onEdit(entry, text)} onDone={() => setEditing(null)} {...opens} />
  )
  const newEntry = (
    // The new entry's line at the bottom of today, where an entry's clock and rail would be.
    <li className="timeline-entry timeline-new" ref={end}>
      <span className="timeline-when" />
      <span className="timeline-rail" aria-hidden />
      <NewLine className="timeline-what line-edit" typing={typing} onAdd={onAdd} {...opens} />
    </li>
  )

  return (
    <>
      <ViewerHeader name="Timeline" status={statusCount(total, 'entry', 'entries')}>
        <ViewSwitch views={TIMELINE_VIEWS} view={view} onView={onView} />
      </ViewerHeader>
      {!read && (
        <Section title="Days" count={0} startOpen>
          <EmptyRow text={READING} />
        </Section>
      )}
      {shown.map(({ note, ...day }) => (
        <section key={day.day} className="journal-day">
          <DayHead day={day.day} today={today} count={day.entries.filter((one) => one.start >= 0).length} onOpen={note ? () => opens.onOpen(note) : undefined} />
          {view === 'day' && <Grid day={day.day} entries={day.entries} keyOf={keyOf} colours={colours} typeOf={typeOf} tables={tables} {...opens} />}
          <ol className="timeline-entries">
            {view === 'list' && day.entries.map((entry, at) => (
              <Fragment key={keyOf(entry)}>
                {partOf(entry.start) !== partOf(day.entries[at - 1]?.start ?? -1) && (
                  <li className="timeline-part" aria-hidden>
                    <span>{partOf(entry.start)}</span>
                  </li>
                )}
                <Entry
                  entry={entry}
                  day={day.day}
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
          <DayTotals text={day.text} totals={totals} colours={colours} typeOf={typeOf} place="timeline" />
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

/**
 * The part of its day an entry covers: `09:00`, `09:00–10:30`, `23:30–` when it goes on
 * past midnight, `–07:00` when it came from the day before, or all day.
 */
function whenText(entry: TimelineEntry): string {
  const { since, until } = reachOf(entry)
  if (since && until) return 'all day'
  const from = since ? '' : clockText(entry.start)
  return entry.end === null ? from : `${from}–${until ? '' : clockText(entry.end)}`
}

/** A day a span reaches, named from the day it is shown on: `tomorrow`, or `Wed 14 Oct`. */
function reachDay(day: string, days: number): string {
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  const date = dayDate(daysAfter(day, days))
  return `${shortWeekday.format(date)} ${shortDate.format(date)}`
}

/**
 * Where a part of a span comes from and goes, said beside its clock: `until tomorrow,
 * 07:00`, `since yesterday, 23:30`. For any other entry, how long it lasted.
 */
function reachWords(entry: TimelineEntry, day: string): string {
  const { since, until } = reachOf(entry)
  const words = (lead: string, reach: Reach) => `${lead} ${reachDay(day, reach.days)}${reach.minute === null ? '' : `, ${clockText(reach.minute)}`}`
  if (since || until) return [since && words('since', since), until && words('until', until)].filter(Boolean).join(' · ')
  return entry.end === null ? '' : lengthOf(entry.end - entry.start)
}

/** An entry's classes: a stretch of time, and one that came from or goes to another day. */
function spanClasses(entry: TimelineEntry): string {
  const { since, until } = reachOf(entry)
  return [entry.end !== null && 'block', since && 'from-before', until && 'goes-on'].filter(Boolean).join(' ')
}

/**
 * A day as a calendar draws one (`dayGrid`): hours down the side, each entry a box as
 * tall as it lasted, entries that clash side by side, quiet stretches folded to a
 * band. A box shows what fits; a press opens it whole, with what is nested under it.
 */
function Grid({
  day,
  entries,
  keyOf,
  colours,
  typeOf,
  tables,
  ...opens
}: {
  day: string
  entries: readonly TimelineEntry[]
  keyOf: (entry: TimelineEntry) => string
  colours: Record<string, string>
  typeOf: (name: string) => PropertyType
  tables: Record<string, string[]>
} & Opens) {
  const [open, setOpen] = useState<string | null>(null)
  const grid = dayGrid(entries)
  if (grid.placed.length === 0 && grid.across.length === 0) return null
  /** A box: its clock, its words, and what is nested under it once pressed open. */
  const box = (entry: TimelineEntry, place: { top: number; height: number; left: string; width: string }, across: boolean) => {
    const key = keyOf(entry)
    const fields = fieldsOf(entry.text, tables, typeOf)
    return (
      <div
        key={key}
        className={['day-box', across && `day-across ${spanClasses(entry)}`, open === key && 'open'].filter(Boolean).join(' ')}
        data-hue={hueOf(entry, colours)}
        role="button"
        tabIndex={0}
        aria-expanded={open === key}
        style={{ top: `${place.top}em`, minHeight: `${place.height}em`, height: open === key ? undefined : `${place.height}em`, left: place.left, width: place.width }}
        onClick={() => setOpen((was) => (was === key ? null : key))}
      >
        <span className="day-box-when">{whenText(entry)}</span> <Live text={wordsOf(entry, typeOf, fields.length > 0)} colours={colours} {...opens} />
        {across && <span className="day-across-reach">{reachWords(entry, day)}</span>}
        {open === key && <Detail lines={[...fields.map((one) => `${one.name} ${one.value}`), ...entry.below]} {...opens} />}
      </div>
    )
  }
  return (
    <div className="day-grid" style={{ height: `${grid.height}em` }}>
      {grid.hours.map((one) => (
        <span key={`h${one.minutes}`} className="day-hour" style={{ top: `${one.top}em` }}>
          <span>{clockText(one.minutes)}</span>
        </span>
      ))}
      {grid.quiet.map((one) => (
        <span key={`q${one.top}`} className="day-quiet" style={{ top: `${one.top}em`, height: `${QUIET_EM}em` }}>
          {lengthOf(one.minutes)} quiet
        </span>
      ))}
      {/* What runs into or out of the day first, so the rest is drawn over it. */}
      <div className="day-boxes">
        {grid.across.map(({ entry, top, height }) => box(entry, { top, height, left: '0', width: '100%' }, true))}
        {grid.placed.map(({ entry, top, height, column, columns }) =>
          box(entry, { top, height, left: `${(column / columns) * 100}%`, width: `${100 / columns}%` }, false)
        )}
      </div>
    </div>
  )
}

/**
 * A day's head, as a journal's page opens: the day's number large, its weekday
 * (or today, yesterday, tomorrow) and month beside it, and how many entries it
 * holds. The date opens the day's note.
 */
function DayHead({ day, today, count, onOpen }: { day: string; today: string; count: number; onOpen?: () => void }) {
  const date = dayDate(day)
  const near = nearDay(day, today)
  return (
    <header className={day === today ? 'journal-head today' : 'journal-head'}>
      <button className="journal-date" onClick={onOpen} disabled={!onOpen}>
        <span className="journal-number">{date.getDate()}</span>
        <span className="journal-names">
          <span className="journal-weekday">{near ? `${near} · ${weekdayName.format(date)}` : weekdayName.format(date)}</span>
          <span className="journal-month">{monthName.format(date)}</span>
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
  day,
  colours,
  tables,
  typeOf,
  editor,
  onPress,
  ...opens
}: {
  entry: TimelineEntry
  /** The day it is shown on, which where a span reaches is named from. */
  day: string
  colours: Record<string, string>
  tables: Record<string, string[]>
  typeOf: (name: string) => PropertyType
  editor: ReactNode
  onPress: () => void
} & Opens) {
  const fields = fieldsOf(entry.text, tables, typeOf)
  const [open, setOpen] = useState(false)
  const detail = entry.below.filter((line) => line.trim() !== '')
  const reach = reachWords(entry, day)
  return (
    <li className={`timeline-entry ${spanClasses(entry)}`.trim()} data-hue={hueOf(entry, colours)} onClick={onPress}>
      <span className="timeline-when">
        {whenText(entry)}
        {reach && <span className="timeline-length">{reach}</span>}
      </span>
      <span className="timeline-rail" aria-hidden />
      {editor || (
        <span className="timeline-what">
          <Live text={wordsOf(entry, typeOf, fields.length > 0)} colours={colours} {...opens} />
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
          {open && <Detail lines={entry.below} {...opens} />}
        </span>
      )}
    </li>
  )
}

/** An entry's colour is its first coloured tag's: its dot, its wash, its chips. */
const hueOf = (entry: TimelineEntry, colours: Record<string, string>) =>
  tagNames(entry.text).map((tag) => colours[tag]).find(Boolean)

/** What is nested under an entry, opened. */
function Detail({ lines, ...opens }: { lines: readonly string[] } & Opens) {
  return (
    <span className="timeline-detail">
      {lines.map((line, at) => (
        <span key={at} className="timeline-below">
          <Live text={line} {...opens} />
        </span>
      ))}
    </span>
  )
}


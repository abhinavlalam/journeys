import { useMemo, useState } from 'react'
import { ViewerHeader } from './ViewerHeader'
import { countOf, NoteRow, READING, RowIcon, Section, stepIn } from './rows'
import { ChevronIcon } from './icons'
import { clockStart, dayDate, daysAfter, daysBetween, localDateStamp, relativeDay } from './clock'
import {
  dueReminders,
  firstWeekday,
  monthGrid,
  monthOf,
  readEvents,
  shiftMonth,
  type CalendarEvent,
} from './calendar'
import type { CollectedNote } from './useVaultTexts'
import type { VaultFile } from './vaultModel'

/** Two readings of the same lines: the days ahead as a list, and the month as
 *  the page every calendar draws. */
type View = 'agenda' | 'month'
const VIEWS: readonly { key: View; label: string }[] = [
  { key: 'agenda', label: 'Agenda' },
  { key: 'month', label: 'Month' },
]

/**
 * The calendar: every `--event` line in the daily notes — the ones the sync wrote
 * from a feed and the ones typed by hand alike — read two ways. **Agenda** is the
 * days ahead, each with its events and, first, whatever has a reminder due.
 * **Month** is the traditional page, seven wide, any month. A row or a chip opens
 * the note the line is in, and a day opens the day's page: the calendar is a
 * reading of the journal, not a second place to keep things. `Sync` reads the
 * feeds in `calendarFeeds` and writes the coming days.
 */
export function CalendarView({
  collected,
  declaration,
  dailyFolder,
  days,
  feeds,
  syncing,
  loading,
  onSync,
  onOpen,
  onOpenDay,
}: {
  /** Null while the vault is still being read. */
  collected: CollectedNote[] | null
  /** The `--event` structure the lines are read by. */
  declaration: string
  dailyFolder: string
  /** How many days the agenda shows, today first. */
  days: number
  /** How many feeds are configured — none, and Sync has nothing to read. */
  feeds: number
  syncing: boolean
  loading: boolean
  onSync: () => void
  onOpen: (file: VaultFile) => void
  /** Opens a day's page, making it if the day has none. */
  onOpenDay: (day: string) => void
}) {
  const today = localDateStamp()
  const now = Date.now()
  const [view, setView] = useState<View>('agenda')
  const [month, setMonth] = useState(monthOf(today))
  const grid = useMemo(() => monthGrid(month, firstWeekday()), [month])

  // One read covers both views: back to the month page's first day, and repeats
  // followed to the last day on either page.
  const shown = Array.from({ length: days }, (_, at) => daysAfter(today, at))
  const from = [grid[0], today].sort()[0]
  const to = [grid[grid.length - 1], shown[shown.length - 1]].sort()[1]
  const events = useMemo(
    () => (collected ? readEvents(collected, declaration, dailyFolder, from, to) : []),
    [collected, declaration, dailyFolder, from, to]
  )
  const ahead = events.filter((one) => one.day >= today && one.day <= shown[shown.length - 1])
  const due = dueReminders(events, now)

  const status = syncing ? 'Syncing…' : feeds === 0 ? 'No feeds' : ahead.length > 0 ? countOf(ahead.length, 'event') : ''
  return (
    <>
      <ViewerHeader name="Calendar" status={status}>
        <span className="viewer-actions">
          <span className="view-switch" role="group" aria-label="View">
            {VIEWS.map((one) => (
              <button
                key={one.key}
                className="header-action"
                aria-pressed={view === one.key}
                onClick={() => setView(one.key)}
              >
                {one.label}
              </button>
            ))}
          </span>
          <button className="header-action" onClick={onSync} disabled={syncing || feeds === 0}>
            Sync
          </button>
        </span>
      </ViewerHeader>
      {view === 'month' ? (
        <MonthPage
          month={month}
          grid={grid}
          today={today}
          events={events}
          onMonth={setMonth}
          onOpen={onOpen}
          onOpenDay={onOpenDay}
        />
      ) : (
        <>
          {due.length > 0 && (
            <Section title="Coming up" count={due.length} startOpen>
              {due.map((one) => (
                <EventRow key={rowKey(one)} event={one} lead={relativeDay(one.day, today)} onOpen={onOpen} />
              ))}
            </Section>
          )}
          {shown.map((day) => {
            const on = ahead.filter((one) => one.day === day)
            return (
              <Section key={day} title={dayTitle(day, today)} count={on.length} startOpen>
                {on.length === 0 ? (
                  <li style={{ paddingLeft: stepIn(1) }}>
                    <NoteRow
                      icon={<RowIcon />}
                      name={loading || collected === null ? READING : 'Nothing on.'}
                      disabled
                    />
                  </li>
                ) : (
                  on.map((one) => <EventRow key={rowKey(one)} event={one} onOpen={onOpen} />)
                )}
              </Section>
            )
          })}
        </>
      )}
    </>
  )
}

const rowKey = (one: CalendarEvent) => `${one.day} ${one.note.path} ${one.line}`

/** One event, in the journal line's own order: the clock, the title, then what
 *  else the line says, quietly and cut to the room left — an `at::` holding a
 *  meeting link is longer than the row. */
function EventRow({
  event,
  lead,
  onOpen,
}: {
  event: CalendarEvent
  /** Under Coming up: how far off it is. */
  lead?: string
  onOpen: (file: VaultFile) => void
}) {
  const { clock, fields } = event
  const detail = [lead, fields.at && `at ${fields.at}`, fields.with && `with ${fields.with}`, fields.source].filter(Boolean)
  return (
    <li style={{ paddingLeft: stepIn(1) }}>
      <NoteRow
        icon={<RowIcon icon="calendar" />}
        name={
          <>
            {clock && <span className="event-when">{clock}</span>}
            {event.what || event.note.name}
          </>
        }
        title={`${event.note.name}, line ${event.line + 1}`}
        trailing={detail.length > 0 ? <span className="row-count event-detail">{detail.join(' · ')}</span> : undefined}
        onClick={() => onOpen(event.note)}
      />
    </li>
  )
}

/**
 * The month as a page: a row of weekday names over whole weeks of days, the
 * months either side stepped back, today's number in the mark. A day grows with
 * what it holds rather than clipping to a fixed row and hiding the rest behind a
 * count, because the page is read, not fitted. Pressing a day opens its page and
 * pressing an event opens the note it is written in.
 */
function MonthPage({
  month,
  grid,
  today,
  events,
  onMonth,
  onOpen,
  onOpenDay,
}: {
  month: string
  grid: readonly string[]
  today: string
  events: readonly CalendarEvent[]
  onMonth: (month: string) => void
  onOpen: (file: VaultFile) => void
  onOpenDay: (day: string) => void
}) {
  const name = monthName.format(dayDate(`${month}-01`))
  return (
    <section className="calendar-month" aria-label={name}>
      <div className="calendar-nav">
        <button className="daily-step back" aria-label="Previous month" onClick={() => onMonth(shiftMonth(month, -1))}>
          <ChevronIcon open={false} />
        </button>
        <span className="calendar-month-name">{name}</span>
        <button className="daily-step forward" aria-label="Next month" onClick={() => onMonth(shiftMonth(month, 1))}>
          <ChevronIcon open={false} />
        </button>
        {month !== monthOf(today) && (
          <button className="header-action" onClick={() => onMonth(monthOf(today))}>
            Today
          </button>
        )}
      </div>
      <div className="calendar-grid">
        {grid.slice(0, 7).map((day) => (
          <span key={day} className="calendar-weekday">
            {weekdayName.format(dayDate(day))}
          </span>
        ))}
        {grid.map((day) => {
          const on = events.filter((one) => one.day === day)
          const outside = monthOf(day) !== month
          const classes = ['calendar-cell', outside && 'outside', day === today && 'today'].filter(Boolean).join(' ')
          return (
            <div key={day} className={classes} onClick={() => onOpenDay(day)}>
              <button
                className="calendar-date"
                aria-label={longDay.format(dayDate(day))}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenDay(day)
                }}
              >
                {Number(day.slice(8))}
              </button>
              {on.map((one) => (
                <button
                  key={rowKey(one)}
                  className={one.clock ? 'calendar-chip' : 'calendar-chip all-day'}
                  title={[one.clock, one.what, one.fields.at && `at ${one.fields.at}`].filter(Boolean).join(' ')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(one.note)
                  }}
                >
                  {one.clock && <span className="calendar-chip-when">{clockStart(one.clock)}</span>}
                  <span className="calendar-chip-what">{one.what || one.note.name}</span>
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}

const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
const weekdayName = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

/** `Today · Wednesday 24 Sept` for the first two days, the date alone after. */
function dayTitle(day: string, today: string): string {
  const date = longDay.format(dayDate(day))
  if (daysBetween(today, day) > 1) return date
  const word = relativeDay(day, today)
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} · ${date}`
}

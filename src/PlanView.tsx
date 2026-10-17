import { useState, type KeyboardEvent } from 'react'
import { shortDay } from './clock'
import { streakOf } from './habits'
import { CheckIcon } from './icons'
import { keptDays, type Planned } from './plan'
import { Section, stepIn } from './rows'
import { Tile, Tiles } from './trackerParts'

/** What writes the plan's table: a thing added for a day, and one ticked or its words changed. */
export interface PlanWrites {
  onAdd: (day: string, thing: string) => void
  onChange: (planned: Planned, change: { done?: boolean; thing?: string }) => void
}

/** Enter keeps what was typed, Escape drops it; leaving keeps it too, as a field for words does. */
function keys(keep: () => void, drop: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      keep()
    } else if (event.key === 'Escape') drop()
  }
}

/** One thing of a day's plan: its box, a press ticking it into the table, and its words, a press editing them. */
function Thing({ planned, onChange }: { planned: Planned; onChange: PlanWrites['onChange'] }) {
  const [editing, setEditing] = useState<string | null>(null)
  const keep = () => {
    const thing = editing?.trim()
    setEditing(null)
    if (thing && thing !== planned.thing) onChange(planned, { thing })
  }
  return (
    <li style={{ paddingLeft: stepIn(1) }}>
      <div className={planned.done ? 'task-row done' : 'task-row'}>
        <button className="task-box" role="checkbox" aria-checked={planned.done} aria-label={`${planned.thing}: done`} onClick={() => onChange(planned, { done: !planned.done })}>
          {planned.done && <CheckIcon />}
        </button>
        <span className="task-body">
          {editing !== null ? (
            <input
              className="plan-field"
              aria-label={`What ${planned.thing} is`}
              autoFocus
              value={editing}
              onChange={(event) => setEditing(event.currentTarget.value)}
              onKeyDown={keys(keep, () => setEditing(null))}
              onBlur={keep}
            />
          ) : (
            <span className="task-what" role="button" tabIndex={0} onClick={() => setEditing(planned.thing)} onKeyDown={keys(() => setEditing(planned.thing), () => {})}>
              <span className="task-words">{planned.thing}</span>
            </span>
          )}
        </span>
      </div>
    </li>
  )
}

/** The field for the next thing of a day, while the day has fewer than the plan's count. */
function NewThing({ left, onAdd }: { left: number; onAdd: (thing: string) => void }) {
  const [text, setText] = useState('')
  const keep = () => {
    if (text.trim()) onAdd(text.trim())
    setText('')
  }
  return (
    <li style={{ paddingLeft: stepIn(1) }}>
      <input
        className="plan-field plan-new"
        aria-label="Something to work on"
        placeholder={left === 1 ? 'One more thing to work on' : `${left} more things to work on`}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={keys(keep, () => setText(''))}
      />
    </li>
  )
}

/** A day's things, and the field for the next while it has fewer than the plan's count. */
function DayThings({ day, things, count, onAdd, onChange }: { day: string; things: readonly Planned[]; count: number } & PlanWrites) {
  return (
    <>
      {things.map((one) => (
        <Thing key={one.row} planned={one} onChange={onChange} />
      ))}
      {things.length < count && <NewThing left={count - things.length} onAdd={(thing) => onAdd(day, thing)} />}
    </>
  )
}

/**
 * The day's plan at the top of its daily note: its things from the plan's table, each
 * ticked there with a press, and a field for the next while there are fewer than the
 * plan has. The note holds none of it.
 */
export function PlanSection({ day, name, count, things, ...writes }: { day: string; name: string; count: number; things: readonly Planned[] } & PlanWrites) {
  return (
    <Section title={name} className="day-plan" count={things.filter((one) => one.done).length} startOpen>
      <DayThings day={day} things={things} count={count} {...writes} />
    </Section>
  )
}

/**
 * The plan's page in Trackers: today's things first, then each earlier day of the month
 * with its things, how many days were kept (all done) and the streak; a day's name
 * opens its note.
 */
export function PlanPage({
  today,
  count,
  rows,
  onOpenDay,
  ...writes
}: { today: string; count: number; rows: readonly Planned[]; onOpenDay: (day: string) => void } & PlanWrites) {
  const month = today.slice(0, 7)
  const days = [...new Set([today, ...rows.filter((one) => one.day.startsWith(month)).map((one) => one.day)])].sort().reverse()
  const kept = keptDays(rows, count)
  const thingsOf = (day: string) => rows.filter((one) => one.day === day)
  const doneToday = thingsOf(today).filter((one) => one.done).length
  const planned = days.filter((day) => thingsOf(day).length > 0)
  return (
    <>
      <Tiles>
        <Tile figure={`${doneToday} of ${count}`} name="done today" share={doneToday / count} />
        <Tile figure={`${planned.filter((day) => kept.has(day)).length} of ${planned.length}`} name="days this month with all done" />
        <Tile figure={String(streakOf(kept, today))} name="days in a row" />
      </Tiles>
      {days.map((day) => (
        <Section key={day} title={shortDay(day, today)} count={thingsOf(day).filter((one) => one.done).length} startOpen={day === today} onOpen={() => onOpenDay(day)}>
          {/* A day gone by is as it was planned: only today takes another thing. */}
          <DayThings day={day} things={thingsOf(day)} count={day === today ? count : thingsOf(day).length} {...writes} />
        </Section>
      ))}
    </>
  )
}

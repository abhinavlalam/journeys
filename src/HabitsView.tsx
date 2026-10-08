import { useLayoutEffect, useRef, useState } from 'react'
import { firstWeekday } from './calendar'
import { dayDate, localDateStamp, narrowWeekday, shortDate, weekdayName } from './clock'
import { habitDays, streakOf } from './habits'
import { AddButton, countOf, EmptyRow, NameField, READING, Section, stepIn } from './rows'
import { TAG_NAME } from './tags'
import { ViewerHeader } from './ViewerHeader'

/** How many weeks the page shows, this one last. Scrolled sideways when they do not fit. */
const WEEKS = 4

/** A habit as the page reads it: its tag, and the days its notes say it was done. */
export interface Habit {
  tag: string
  done: ReadonlySet<string>
}

/**
 * Habits: each tag tracked as a habit, a row of the last weeks' days, done where the
 * day's note carries the tag, with its streak and this week's count. Pressing a day
 * writes the tag into that day's note, or takes back a line that is the tag alone; a
 * day done in the note's own words is the note's. The tag opens its page, where it is
 * made a habit or not; + makes one of a tag typed here.
 */
export function HabitsView({
  habits,
  colours,
  onMark,
  onAdd,
  onOpenTag,
  onError,
}: {
  /** Null while the vault is still being read. */
  habits: Habit[] | null
  colours: Readonly<Record<string, string>>
  /** A day pressed: `done` is what it is to be. */
  onMark: (tag: string, day: string, done: boolean) => void
  onAdd: (tag: string) => void
  onOpenTag: (tag: string) => void
  onError: (message: string) => void
}) {
  const today = localDateStamp()
  const days = habitDays(today, firstWeekday(), WEEKS)
  const thisWeek = days.slice(-7).filter((day) => day <= today)
  const left = habits?.filter((one) => !one.done.has(today)).length ?? 0
  const [adding, setAdding] = useState<string | null>(null)
  // Today in sight: the grid opens at its end, as the timeline does.
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth
  }, [habits === null])

  /** A typed tag, `#` or not, made a habit; a name that is not a tag keeps the field and says why. */
  function add() {
    const tag = (adding ?? '').trim().replace(/^#/, '').toLowerCase()
    if (tag && !new RegExp(`^${TAG_NAME}$`).test(tag)) return onError(`#${tag} is not a tag: a tag is one word, with a letter in it.`)
    setAdding(null)
    if (tag) onAdd(tag)
  }

  return (
    <>
      <ViewerHeader name="Habits" status={!habits?.length ? '' : left > 0 ? `${left} left today` : 'All done today'} />
      <Section
        title="Habits"
        count={habits?.length ?? 0}
        startOpen
        actions={<AddButton label="Add a habit" onPress={() => setAdding((current) => current ?? '')} />}
      >
        {adding !== null && (
          <li style={{ paddingLeft: stepIn(1) }}>
            <NameField value={adding} placeholder="Tag…" onChange={setAdding} onSubmit={add} onCancel={() => setAdding(null)} onBlur={() => setAdding(null)} />
          </li>
        )}
        {!habits ? (
          <EmptyRow text={READING} />
        ) : habits.length === 0 ? (
          adding === null && <EmptyRow text="No habits yet: + makes a tag one, as its page does." />
        ) : (
          <li className="habit-box">
            <div className="habit-scroll" ref={scroller}>
              <table className="habit-table">
                <thead>
                  <tr>
                    <th />
                    {Array.from({ length: WEEKS }, (_, week) => (
                      <th key={week} colSpan={7} className="habit-week">
                        {shortDate.format(dayDate(days[week * 7]))}
                      </th>
                    ))}
                    <th className="habit-figure">Streak</th>
                    <th className="habit-figure">This week</th>
                  </tr>
                  <tr>
                    <th />
                    {days.map((day, at) => (
                      <th key={day} className={at % 7 === 0 ? 'habit-weekday week-start' : 'habit-weekday'} aria-current={day === today ? 'date' : undefined}>
                        {narrowWeekday.format(dayDate(day))}
                      </th>
                    ))}
                    <th />
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {habits.map(({ tag, done }) => {
                    const streak = streakOf(done, today)
                    return (
                      <tr key={tag} data-hue={colours[tag]}>
                        <th scope="row">
                          <button className="line-tag" data-hue={colours[tag]} onClick={() => onOpenTag(tag)}>
                            #{tag}
                          </button>
                        </th>
                        {days.map((day, at) => {
                          const on = done.has(day)
                          const date = dayDate(day)
                          return (
                            <td key={day} className={at % 7 === 0 ? 'week-start' : undefined}>
                              <button
                                className="habit-day"
                                aria-pressed={on}
                                aria-current={day === today ? 'date' : undefined}
                                aria-label={`#${tag}, ${weekdayName.format(date)} ${shortDate.format(date)}`}
                                // A day not yet here is not done or undone.
                                disabled={day > today}
                                onClick={() => onMark(tag, day, !on)}
                              />
                            </td>
                          )
                        })}
                        <td className="habit-figure">{streak > 0 ? countOf(streak, 'day') : ''}</td>
                        <td className="habit-figure">
                          {thisWeek.filter((day) => done.has(day)).length} of {thisWeek.length}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </li>
        )}
      </Section>
    </>
  )
}

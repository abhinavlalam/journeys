import { useEffect, useRef, type ReactNode } from 'react'
import { dayTitle, localDateStamp } from './clock'
import type { PropertyType } from './properties'
import { countOf, NoteRow, READING, readable, RowIcon, Section, stepIn } from './rows'
import { TAG_NAME, tagNames } from './tags'
import { clockText, fieldsOf, lengthOf, totalsOf, wordsOf, type TimelineDay, type TimelineEntry } from './timeline'
import { ViewerHeader } from './ViewerHeader'
import { linkLabelSpan, type VaultFile } from './vaultModel'

/** Places a total is rounded to, as a tag's table rounds its sums. */
const TOTAL_DECIMALS = 2

interface Opens {
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string) => void
  onOpenTag: (tag: string) => void
}

/**
 * The timeline: every daily note as the day happened, **oldest at the top and today
 * at the bottom**, the way a log reads — the page opens at its end. Each day is its
 * entries by clock, whichever group of the note each is written in; a moment is a
 * point on the day's rail and a block of time a bar, with how long it lasted. A tag
 * drawn as a table shows its entries' fields, and the day's totals close the day.
 */
export function TimelineView({
  days,
  tables,
  typeOf,
  loading,
  ...opens
}: {
  /** Null while the vault is still being read. */
  days: TimelineDay[] | null
  /** Every tag drawn as a table, with its structure (`tablesOf`). */
  tables: Record<string, string[]>
  typeOf: (name: string) => PropertyType
  loading: boolean
} & Opens) {
  const today = localDateStamp()
  const end = useRef<HTMLLIElement>(null)
  const read = days !== null
  // Today at the bottom, like a log: the page opens there, once there is a page.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [read])
  const total = days?.reduce((sum, one) => sum + one.entries.length, 0) ?? 0

  return (
    <>
      <ViewerHeader name="Timeline" status={total > 0 ? countOf(total, 'entry', 'entries') : ''} />
      {!days?.length ? (
        <Section title="Days" count={0} startOpen>
          <li style={{ paddingLeft: stepIn(1) }}>
            <NoteRow icon={<RowIcon />} name={loading || !read ? READING : 'No day written yet.'} disabled />
          </li>
        </Section>
      ) : (
        days.map((day) => (
          <Section key={day.day} title={dayTitle(day.day, today)} count={day.entries.length} startOpen>
            <li className="timeline-box" ref={day === days[days.length - 1] ? end : undefined}>
              <ol className="timeline-entries">
                {day.entries.map((entry) => (
                  <Entry key={entry.at} entry={entry} tables={tables} typeOf={typeOf} {...opens} />
                ))}
              </ol>
              <Totals entries={day.entries} tables={tables} typeOf={typeOf} />
            </li>
          </Section>
        ))
      )}
    </>
  )
}

/** One entry: its clock, its mark on the rail, what it says, and its group. */
function Entry({
  entry,
  tables,
  typeOf,
  ...opens
}: {
  entry: TimelineEntry
  tables: Record<string, string[]>
  typeOf: (name: string) => PropertyType
} & Opens) {
  const fields = fieldsOf(entry.text, tables, typeOf)
  const block = entry.start !== null && entry.end !== null
  // The group says what the entry's own tags do not: `#food` under `#diet`.
  const group = entry.group && !tagNames(entry.text).includes(entry.group) ? entry.group : null
  return (
    <li className={block ? 'timeline-entry block' : 'timeline-entry'} onClick={() => opens.onOpen(entry.note)}>
      <span className="timeline-when">
        {entry.start !== null && clockText(entry.start)}
        {block && `–${clockText(entry.end!)}`}
        {block && <span className="timeline-length">{lengthOf(entry.end! - entry.start!)}</span>}
      </span>
      <span className="timeline-rail" aria-hidden />
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
      {group && <span className="timeline-group">{group}</span>}
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

// Writing the feeds' events into the daily notes: the calendar's
// one write, through `vault.ts`.

import { EVENT, eventLine, lineKey, readEvent, SOURCE, untouched, type EventFormat } from './calendar'
import { fetchFeed } from './calendarFeed'
import { dayDate, daysAfter, localDateStamp } from './clock'
import { occurrences, parseIcs } from './ics'
import type { CalendarFeed } from './settings'
import { collectTagLines } from './tags'
import { ensureDailyNote, fileExists, readVaultFile, vaultFileRef, writeVaultFile } from './vault'
import type { VaultFile } from './vaultModel'

/**
 * Each day's `#event` lines from every feed, for `days` days from `today`, and every name a
 * feed goes by, its own included. Every day is listed, empty or not, so an event that is
 * gone can be taken back. A body that is not a calendar is refused: a Wi-Fi sign-in page
 * answers any address, and read as no events it took every synced line back out.
 */
export async function feedLines(
  feeds: readonly CalendarFeed[],
  today: string,
  days: number,
  properties: readonly string[]
): Promise<{ byDay: Map<string, string[]>; sources: Set<string> }> {
  const from = dayDate(today)
  const to = dayDate(daysAfter(today, days))
  const byDay = new Map(Array.from({ length: days }, (_, at) => [daysAfter(today, at), [] as string[]] as const))
  const sources = new Set<string>()
  for (const { name, url } of feeds) {
    const body = await fetchFeed(url)
    if (!/^BEGIN:VCALENDAR/m.test(body)) throw new Error(`${name || url} did not answer with a calendar.`)
    const feed = parseIcs(body)
    // Never an empty name: a line typed by hand with no `source::` belongs to no feed.
    for (const one of [name, feed.name]) if (one) sources.add(one)
    for (const one of occurrences(feed, from, to)) {
      byDay.get(localDateStamp(one.start))?.push(eventLine(properties, one, name || feed.name))
    }
  }
  return { byDay, sources }
}

export interface Synced {
  /** Every note written, with its new text. */
  changed: { file: VaultFile; text: string }[]
  /** The days that had no note before. */
  created: VaultFile[]
}

/**
 * Brings each day's note in line with what the feeds say for that day.
 *
 * Added: a line the note does not have yet (same clock and title, read
 * as the calendar reads them, so an edited line is still the same
 * event) goes at the end. A day with nothing to add is only read if
 * its note exists; the sync makes a note for an event, never for none.
 *
 * Taken back: a synced line whose event the feeds no longer have, only
 * when it is wholly the calendar's: it names one of `sources`, holds
 * nothing but its fields (`untouched`), and has nothing nested under
 * it. `byDay` holds every day the feeds were read for, empty days
 * included, or a day's last deleted event would never be taken back.
 */
export async function syncEvents(
  vaultPath: string,
  folder: string,
  format: EventFormat,
  byDay: ReadonlyMap<string, readonly string[]>,
  sources: ReadonlySet<string>
): Promise<Synced> {
  const keyOf = (line: string) => lineKey(format.typeOf, line)
  const out: Synced = { changed: [], created: [] }
  for (const [day, lines] of byDay) {
    const page = vaultFileRef(vaultPath, `${folder}/${day}.md`)
    let file = page
    let created = false
    if (lines.length > 0) ({ file, created } = await ensureDailyNote(vaultPath, folder, day))
    else if (!(await fileExists(page))) continue
    const text = created ? '' : await readVaultFile(file)

    const wanted = new Set(lines.map(keyOf))
    const gone = new Set(
      collectTagLines(text, EVENT)
        .filter(
          (entry) =>
            entry.below.length === 0 &&
            sources.has(readEvent(entry.text, format.typeOf).fields[SOURCE] ?? '') &&
            !wanted.has(keyOf(entry.text)) &&
            untouched(format, entry.text)
        )
        .map((entry) => entry.at)
    )
    const kept = gone.size === 0 ? text : text.split('\n').filter((_, at) => !gone.has(at)).join('\n')

    const have = new Set(collectTagLines(kept, EVENT).map((one) => keyOf(one.text)))
    const fresh: string[] = []
    for (const line of lines) {
      const key = keyOf(line)
      if (have.has(key)) continue
      have.add(key)
      fresh.push(line)
    }
    if (fresh.length === 0 && gone.size === 0) continue
    if (created) out.created.push(file)
    const next =
      fresh.length === 0 ? kept : kept.trim() === '' ? `${fresh.join('\n')}\n` : `${kept.replace(/\n*$/, '\n')}${fresh.join('\n')}\n`
    await writeVaultFile(file, next)
    out.changed.push({ file, text: next })
  }
  return out
}

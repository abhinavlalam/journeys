// Writing the feeds' occurrences into the daily notes — the one place the calendar
// touches the disk, through `vault.ts` like everything else.

import { collectLines, readFields, templateFields } from './actions'
import { EVENT, lineKey, untouched } from './calendar'
import { ensureDailyNote, fileExists, readVaultFile, vaultFileRef, writeVaultFile } from './vault'
import type { VaultFile } from './vaultModel'

export interface Synced {
  /** Every note written, with the text it now holds. */
  changed: { file: VaultFile; text: string }[]
  /** The days that did not exist before. */
  created: VaultFile[]
}

/**
 * Brings each day's note in line with what the feeds say for that day.
 *
 * **Added**: a line the note does not already carry — the same clock and title,
 * read the way the calendar reads them, so a line edited after the sync is still the
 * same event — goes on the end, since a journal page is the day as it was written
 * and the meetings follow it rather than being threaded into it. A day with nothing
 * to add is only read if its page is there: the sync makes a page for an event,
 * never for the absence of one.
 *
 * **Taken back**: a line the sync wrote whose event the feeds no longer have —
 * deleted, moved or renamed in the calendar — comes out, and only when all of it is
 * the calendar's: it names one of `sources`, it says nothing but its fields
 * (`untouched`), and nothing is nested under it. A line with a word added or a note
 * written beneath it is the owner's, and stays. `byDay` holds every day the feeds
 * were read for, with the days that have no events, or a deleted day's last event
 * would never be taken back.
 */
export async function syncEvents(
  vaultPath: string,
  folder: string,
  declaration: string,
  byDay: ReadonlyMap<string, readonly string[]>,
  sources: ReadonlySet<string>
): Promise<Synced> {
  const fields = templateFields(declaration)
  const out: Synced = { changed: [], created: [] }
  for (const [day, lines] of byDay) {
    const page = vaultFileRef(vaultPath, `${folder}/${day}.md`)
    let file = page
    let created = false
    if (lines.length > 0) ({ file, created } = await ensureDailyNote(vaultPath, folder, day))
    else if (!(await fileExists(page))) continue
    const text = created ? '' : await readVaultFile(file)

    const wanted = new Set(lines.map((line) => lineKey(fields, line)))
    const gone = new Set(
      collectLines(text, EVENT)
        .filter(
          (entry) =>
            entry.below.length === 0 &&
            sources.has(readFields(entry.text, fields).source ?? '') &&
            !wanted.has(lineKey(fields, entry.text)) &&
            untouched(declaration, entry.text)
        )
        .map((entry) => entry.at)
    )
    const kept = gone.size === 0 ? text : text.split('\n').filter((_, at) => !gone.has(at)).join('\n')

    const have = new Set(collectLines(kept, EVENT).map((one) => lineKey(fields, one.text)))
    const fresh: string[] = []
    for (const line of lines) {
      const key = lineKey(fields, line)
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

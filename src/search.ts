// Finding a note by what is in it.
//
// Pure: notes and their text in, matches out, over the one read
// of the vault, so no disk and nothing async.
//
// Case-insensitive substring, and nothing more: no fuzzy matching, no
// scores, no index. `includes` over a vault takes microseconds, and each
// addition would need explaining when a visible note does not come back.

import { splitPageProperties } from './properties'
import type { VaultFile } from './vaultModel'

export interface SearchHit {
  note: VaultFile
  /**
   * The first line the words are on, trimmed. Absent when the
   * name matched, since the row already shows the name.
   */
  line?: string
}

/**
 * Every note containing `query`, name matches before text matches,
 * each sorted by name. Only the body is searched: a `path:: Plans/Q3`
 * would make every note under `Plans/` a hit for "plans". A name match
 * is enough for that note; a second row for its text would be noise.
 */
export function searchNotes(
  notes: Iterable<{ note: VaultFile; text: string }>,
  query: string,
  limit = 40
): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const named: SearchHit[] = []
  const inside: SearchHit[] = []
  for (const { note, text } of notes) {
    if (note.name.toLowerCase().includes(needle)) {
      named.push({ note })
      continue
    }
    const { body } = splitPageProperties(text)
    const line = body.split('\n').find((one) => one.toLowerCase().includes(needle))
    if (line !== undefined) inside.push({ note, line: line.trim() })
  }

  const byName = (a: SearchHit, b: SearchHit) => a.note.name.localeCompare(b.note.name)
  return [...named.sort(byName), ...inside.sort(byName)].slice(0, limit)
}

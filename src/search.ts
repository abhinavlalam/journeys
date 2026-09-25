// Finding a note by what is in it.
//
// **Pure**: notes and their text in, matches out. The corpus is the one the rest of
// the app already holds — `App` reads every note once and everything is derived
// from that array (CLAUDE.md) — so searching costs no disk at all and there is
// nothing here to make asynchronous.
//
// Substring and case-insensitive, and that is deliberately the whole of it: no
// fuzzy matching, no ranking by score, no index. A vault is a folder of notes
// someone wrote, `String.includes` over it is microseconds, and every one of those
// additions is a thing that has to be explained when a note the user can see does
// not come back.

import { splitFrontmatter } from './frontmatter'
import type { VaultFile } from './vaultModel'

export interface SearchHit {
  note: VaultFile
  /** The first line the words sit on, trimmed. Absent when the *name* matched —
   *  the row already shows the name, and repeating it says nothing. */
  line?: string
}

/**
 * Every note that carries `query`, names before contents, each half by name.
 *
 * The **body** is searched, not the whole file: a property is not prose, and
 * `path: Plans/Q3` would otherwise make every note under `Plans/` a hit for
 * "plans" — which is the one result nobody is looking for, since the tree already
 * says where a note lives.
 *
 * A name match ends that note: it is the strongest thing that can be said about a
 * note, and a second row for a mention in its own text is noise beside it.
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
    const { body } = splitFrontmatter(text)
    const line = body.split('\n').find((one) => one.toLowerCase().includes(needle))
    if (line !== undefined) inside.push({ note, line: line.trim() })
  }

  const byName = (a: SearchHit, b: SearchHit) => a.note.name.localeCompare(b.note.name)
  return [...named.sort(byName), ...inside.sort(byName)].slice(0, limit)
}

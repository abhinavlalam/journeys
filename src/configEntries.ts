/**
 * A `.config` file of entries keyed by name (`properties.json`, `tags.json`),
 * as text in and text out; `useConfigEntries` keeps one in step with the disk.
 *
 * As with `settings.json`, the file may be edited by hand: a write keeps
 * every entry and field it does not know, sorts by name so a diff reads
 * well, and refuses to write over a file it cannot read or parse, saying so.
 */
export type Entries = Record<string, Record<string, unknown>>

/**
 * The JSON object a text holds, or null, which callers read as do
 * not write. A parse failure and a wrong shape are the same answer.
 */
function asObject(text: string): Record<string, unknown> | null {
  try {
    const read: unknown = JSON.parse(text)
    return read && typeof read === 'object' && !Array.isArray(read)
      ? (read as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * The entries a file holds, or null when it is not a JSON object.
 * Anything under a name that is not an object is skipped, not repaired.
 */
export function readEntries(text: string): Entries | null {
  const parsed = text.trim() ? asObject(text) : {}
  if (!parsed) return null
  const found: Entries = {}
  for (const [name, entry] of Object.entries(parsed)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) found[name] = entry as Record<string, unknown>
  }
  return found
}

/**
 * `text` with `fields` merged into `name`'s entry and the file sorted, or
 * null when the text is not a JSON object and must not be written over.
 */
export function withEntry(text: string, name: string, fields: Record<string, unknown>): string | null {
  const parsed = text.trim() ? asObject(text) : {}
  if (!parsed) return null
  const next = { ...parsed, [name]: { ...(parsed[name] as object), ...fields } }
  const sorted = Object.fromEntries(Object.keys(next).sort().map((key) => [key, next[key]]))
  return `${JSON.stringify(sorted, null, 2)}\n`
}

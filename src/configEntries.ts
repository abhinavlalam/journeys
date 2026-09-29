/**
 * **A `.config` file of entries keyed by name** — `properties.json` now, a tag's
 * structure next — as text in and text out; `useConfigEntries` keeps one in step
 * with the disk.
 *
 * The bargain `settings.json` makes: someone may edit the file by hand, so a write
 * keeps every entry and field it does not understand, sorts by name so a diff
 * reads, and **refuses a file it cannot read or parse**, saying so, rather than
 * writing over it.
 */
export type Entries = Record<string, Record<string, unknown>>

/** The JSON object a text holds, or null — which the callers mean as "do not
 *  overwrite", so a parse failure and a wrong shape are one answer. */
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

/** The entries a file holds, or null for one that is not a JSON object. Anything
 *  that is not an object under a name is skipped rather than repaired. */
export function readEntries(text: string): Entries | null {
  const parsed = text.trim() ? asObject(text) : {}
  if (!parsed) return null
  const found: Entries = {}
  for (const [name, entry] of Object.entries(parsed)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) found[name] = entry as Record<string, unknown>
  }
  return found
}

/** `text` with `fields` merged into `name`'s entry, the whole file sorted — or null
 *  when the text is not a JSON object and so must not be written over. */
export function withEntry(text: string, name: string, fields: Record<string, unknown>): string | null {
  const parsed = text.trim() ? asObject(text) : {}
  if (!parsed) return null
  const next = { ...parsed, [name]: { ...(parsed[name] as object), ...fields } }
  const sorted = Object.fromEntries(Object.keys(next).sort().map((key) => [key, next[key]]))
  return `${JSON.stringify(sorted, null, 2)}\n`
}

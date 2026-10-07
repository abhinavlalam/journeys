/**
 * A `.config` file of entries keyed by name (`properties.json`, `tags.json`),
 * as text in and text out; `useConfigEntries` keeps one in step with the disk.
 *
 * As with `settings.json`, the file may be edited by hand: a write keeps
 * every entry and field it does not know, sorts by name so a diff reads
 * well, and refuses to write over a file it cannot read or parse, saying so.
 */
export type Entries = Record<string, Record<string, unknown>>

/** `value` when it is one of `values`: a choice read from a file a hand may have edited. */
export const oneOf = <T>(values: readonly T[], value: unknown): T | undefined => values.find((one) => one === value)

/** The name an entry is kept under, matched in any case, or `name` when none is: a write keeps the file's spelling. */
export const keyIn = (entries: Entries, name: string) =>
  Object.keys(entries).find((one) => one.toLowerCase() === name.toLowerCase()) ?? name

/** `value` when it is a plain object, else null. `JSON.parse('7')` and `'null'` both succeed. */
const objectIn = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/**
 * The JSON object a text holds, or null, which callers read as do
 * not write. A parse failure and a wrong shape are the same answer.
 */
export function asObject(text: string): Record<string, unknown> | null {
  try {
    return objectIn(JSON.parse(text))
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
    const one = objectIn(entry)
    if (one) found[name] = one
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
  // Only an object is merged into: spread, a hand-typed `"amount": "number"` became {0: 'n', …}.
  const next = { ...parsed, [name]: { ...objectIn(parsed[name]), ...fields } }
  const sorted = Object.fromEntries(Object.keys(next).sort().map((key) => [key, next[key]]))
  return `${JSON.stringify(sorted, null, 2)}\n`
}

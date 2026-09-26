// Reading and writing one property in a note's YAML frontmatter.
//
// **Pure**: text in, text out. `vault.ts` does the reading and writing; this only
// knows the shape of the block, which is why it can be tested without a disk.
//
// A line-based rewrite rather than a YAML library: `gray-matter` breaks in the
// webview, where `Buffer` is undefined. That means this handles the flat `key: value` a note actually
// carries and nothing more — no nesting, no lists, no anchors. Anything it does not
// understand it leaves *exactly* as it found it, which is the property that matters:
// the app must not reformat a block it only came to change one line of.

/** The block, if the note opens with one — the one rule in the app for where
 *  frontmatter ends. `splitFrontmatter` was a second copy of it in `vault.ts`. */
const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/**
 * A property's **name** at the top level of a block — no leading space, so a
 * nested key belongs to the key above it and is not one of these.
 *
 * The one rule for what a property is called: `propertyKeys` reads a block with
 * it, and `editorPreview` marks a name with it, so the list in the Actions pane
 * and the colour in the note cannot disagree about what counts.
 */
export const PROPERTY_KEY = /^([A-Za-z][\w-]*)(?=\s*:)/

/** `key: value` at the top level — no leading space, so a nested key is not one. */
function lineFor(key: string): RegExp {
  return new RegExp(`^${key}\\s*:\\s*(.*)$`)
}

/**
 * The value of `key`, or null when the note has no block or no such key.
 *
 * Quotes are stripped, because a value written by hand may carry them and a value
 * written by `withProperty` does not — a reader should not care which.
 */
export function readProperty(raw: string, key: string): string | null {
  const block = BLOCK.exec(raw)
  if (!block) return null
  const matcher = lineFor(key)
  for (const line of block[1].split(/\r?\n/)) {
    const found = matcher.exec(line)
    if (found) {
      const value = found[1].trim()
      if (!value) return null
      return value.replace(/^["'](.*)["']$/, '$1')
    }
  }
  return null
}

/** `key: value`, or `key:` for a value that is empty — a blank to fill, which a
 *  declared default writes and a trailing space would leave in a file people diff. */
function line(key: string, value: string): string {
  return value === '' ? `${key}:` : `${key}: ${value}`
}

/**
 * `raw` with `key` set to `value`, or removed when `value` is null.
 *
 * Four cases, and the order matters:
 *
 * - **The key is there** — that one line is replaced, and every other line, the
 *   spacing and the line endings survive untouched.
 * - **A block without the key** — the line is appended to the end of the block, so
 *   a hand-written order is not shuffled.
 * - **No block at all** — one is created, followed by a blank line. The blank line
 *   is not cosmetic: without it the first line of the note becomes part of the
 *   block's trailing context for some parsers.
 * - **Removing the last line of a block** — the block goes with it, rather than
 *   leaving `---\n---` behind for the reader to wonder about.
 */
export function withProperty(raw: string, key: string, value: string | null): string {
  const block = BLOCK.exec(raw)
  const matcher = lineFor(key)

  if (!block) {
    if (value === null) return raw
    return `---\n${line(key, value)}\n---\n\n${raw}`
  }

  const inner = block[1]
  const rest = raw.slice(block[0].length)
  const eol = block[0].includes('\r\n') ? '\r\n' : '\n'
  const lines = inner.split(/\r?\n/)
  const at = lines.findIndex((line) => matcher.test(line))

  if (value === null) {
    if (at === -1) return raw
    lines.splice(at, 1)
    // Nothing left worth a block.
    if (lines.every((line) => line.trim() === '')) return rest.replace(/^\r?\n/, '')
    return `---${eol}${lines.join(eol)}${eol}---${block[2] || eol}${rest}`
  }

  if (at === -1) lines.push(line(key, value))
  else lines[at] = line(key, value)
  return `---${eol}${lines.join(eol)}${eol}---${block[2] || eol}${rest}`
}

/**
 * A leading block held aside from the body.
 *
 * `parseNoteLinks` is the caller: a property's value is not prose, and a `path:`
 * full of slashes is not a set of links. Only a **leading** block counts — a `---`
 * in the middle of a note is a horizontal rule, and taking that one would swallow
 * everything above it.
 */
export function splitFrontmatter(raw: string): { prefix: string; body: string } {
  const block = BLOCK.exec(raw)
  if (!block) return { prefix: '', body: raw }
  return { prefix: block[0], body: raw.slice(block[0].length) }
}

/**
 * Every property named in a note's block, in the order they are written.
 *
 * The names only: what a property *is* is a question the Actions pane answers, and
 * what one holds is the note's business. A note with no block has none.
 */
export function propertyKeys(raw: string): string[] {
  const block = BLOCK.exec(raw)
  if (!block) return []
  const found: string[] = []
  for (const line of block[1].split(/\r?\n/)) {
    const key = PROPERTY_KEY.exec(line)
    if (key) found.push(key[1])
  }
  return found
}

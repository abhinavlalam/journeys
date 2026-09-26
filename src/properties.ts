// A note's **page properties**, as plain text.
//
// **Two forms of one thing.** A property is `key:: value` wherever it is written —
// a page's or a block's — and a note's page properties are the `key:: value` lines
// it opens with; the first line that is not one ends them. A YAML block between
// `---` lines is read as page properties too, and **written in the form it has**:
// Claude Code's skills must open with one, and a vault brought from another app is
// full of them. Nothing turns one form into the other behind anyone's back; a note
// with no properties yet is given the `::` form.
//
// **Pure**: text in, text out. `vault.ts` does the reading and writing. A line-based
// rewrite rather than a YAML library — `gray-matter` breaks in the webview, where
// `Buffer` is undefined — so this handles the flat `key: value` a note carries and
// leaves anything it does not understand *exactly* as it found it: the app must not
// reformat a block it only came to change one line of.

/**
 * The properties the app itself keeps in a note, **defined here and nowhere else**:
 * the icon its row wears, and where it sits (`knownPath`). Every other property is
 * the vault's own.
 */
export const APP_PROPERTIES = { icon: 'icon', path: 'path' } as const

/** A YAML block, and the one rule for where one ends. */
const YAML = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/** A page property line: a name, `::`, and whatever follows as its value. */
const PAGE_LINE = /^[A-Za-z][\w-]*::/

/**
 * A property's **name** at the start of a line — no leading space, so a nested YAML
 * key belongs to the key above it and is not one of these. It reads `key:` and
 * `key::` alike.
 *
 * The one rule for what a property is called: `propertyKeys` reads a block with it,
 * and `editorPreview` marks a name with it, so the list in the Actions pane and the
 * colour in the note cannot disagree about what counts.
 */
export const PROPERTY_KEY = /^([A-Za-z][\w-]*)(?=\s*:)/

/** The block a note opens with, in either form, or null. */
interface PageBlock {
  /** Where the block ends and the body begins. */
  end: number
  /** Its property lines, without their line endings. */
  lines: string[]
  /** What follows YAML's closing `---`: its line ending, or nothing at the end of the file. */
  yaml: { after: string } | null
  eol: string
}

function pageBlock(raw: string): PageBlock | null {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const yaml = YAML.exec(raw)
  if (yaml) return { end: yaml[0].length, lines: yaml[1].split(/\r?\n/), yaml: { after: yaml[2] }, eol }
  const lines: string[] = []
  let end = 0
  while (end < raw.length) {
    const next = raw.indexOf('\n', end)
    const stop = next === -1 ? raw.length : next + 1
    const line = raw.slice(end, stop).replace(/\r?\n$/, '')
    if (!PAGE_LINE.test(line)) break
    lines.push(line)
    end = stop
  }
  return lines.length > 0 ? { end, lines, yaml: null, eol } : null
}

/** A top-level `key: value` or `key:: value` line of this block's form. */
function lineFor(key: string, block: PageBlock | null): RegExp {
  return new RegExp(`^${key}\\s*${block?.yaml ? ':' : '::'}\\s*(.*)$`)
}

/** `key:: value`, or `key::` for an empty value — a blank to fill, where a trailing
 *  space would be one more thing in a file people diff. */
function line(key: string, value: string, block: PageBlock | null): string {
  const sep = block?.yaml ? ':' : '::'
  return value === '' ? `${key}${sep}` : `${key}${sep} ${value}`
}

/**
 * The value of `key`, or null when the note has no such property.
 *
 * Quotes are stripped, because a value written by hand may carry them and a value
 * written by `withProperty` does not — a reader should not care which.
 */
export function readProperty(raw: string, key: string): string | null {
  const block = pageBlock(raw)
  if (!block) return null
  const matcher = lineFor(key, block)
  for (const one of block.lines) {
    const found = matcher.exec(one)
    if (found) {
      const value = found[1].trim()
      return value ? value.replace(/^["'](.*)["']$/, '$1') : null
    }
  }
  return null
}

/**
 * `raw` with `key` set to `value`, or removed when `value` is null — in the form the
 * note's block already has.
 *
 * - **The key is there** — that one line is replaced, and every other line, the
 *   spacing and the line endings survive untouched.
 * - **A block without the key** — the line is appended to it, so a hand-written
 *   order is not shuffled.
 * - **No block at all** — a `::` one is started, followed by a blank line that
 *   keeps the note's first line from reading as part of it.
 * - **Removing the last property** — the block goes with it, and the blank line
 *   after it, rather than leaving an empty `---` pair behind.
 */
export function withProperty(raw: string, key: string, value: string | null): string {
  const block = pageBlock(raw)
  if (!block) {
    if (value === null) return raw
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    return `${line(key, value, null)}${eol}${eol}${raw}`
  }

  const rest = raw.slice(block.end)
  const lines = [...block.lines]
  const at = lines.findIndex((one) => lineFor(key, block).test(one))
  if (value === null) {
    if (at === -1) return raw
    lines.splice(at, 1)
    if (lines.every((one) => one.trim() === '')) return rest.replace(/^\r?\n/, '')
  } else if (at === -1) lines.push(line(key, value, block))
  else lines[at] = line(key, value, block)

  const { eol } = block
  if (block.yaml) return `---${eol}${lines.join(eol)}${eol}---${block.yaml.after || eol}${rest}`
  // A block that is the whole note may end without a line ending, and keeps doing so.
  const closed = raw.slice(0, block.end).endsWith('\n') || rest !== '' ? eol : ''
  return `${lines.join(eol)}${closed}${rest}`
}

/**
 * The page properties held aside from the body.
 *
 * `parseNoteLinks` is a caller: a property's value is not prose, and a `path::` full
 * of slashes is not a set of links. Only a **leading** block counts — a `---` in the
 * middle of a note is a horizontal rule, and taking that one would swallow
 * everything above it.
 */
export function splitPageProperties(raw: string): { prefix: string; body: string } {
  const end = pageBlock(raw)?.end ?? 0
  return { prefix: raw.slice(0, end), body: raw.slice(end) }
}

/**
 * Every page property a note names, in the order they are written.
 *
 * The names only: what a property *is* is a question the Actions pane answers, and
 * what one holds is the note's business. A note with no block has none.
 */
export function propertyKeys(raw: string): string[] {
  return (pageBlock(raw)?.lines ?? []).flatMap((one) => {
    const key = PROPERTY_KEY.exec(one)
    return key ? [key[1]] : []
  })
}

// Properties, as plain text.
//
// A property is `key:: value`, a page's or a block's. A note's page
// properties are the `key:: value` lines it opens with; the first other line
// ends them. A YAML block between `---` lines is read as page properties
// too, and written back as YAML: skills must open with one, and notes from
// other apps have them. A note with no properties gets the `::` form.
//
// A block property is `key:: value` on any line. Its value is exactly its type
// (`PROPERTY_TYPES`), so the owner's own words can follow it (`blockProperties`).
//
// Text in, text out; `vault.ts` reads and writes. Line by line rather
// than a YAML library (`gray-matter` needs `Buffer`, which the webview
// lacks). A line this does not understand is left exactly as it was.

import { proseLines } from './prose'
import type { Entries } from './configEntries'

/**
 * The app's own properties, named here and nowhere else: the
 * row's icon, and where the note sits (`knownPath`).
 */
export const APP_PROPERTIES = { icon: 'icon', path: 'path' } as const

/** Whether a name is one of the app's own properties, which the vault does not type. */
export function isAppProperty(name: string): boolean {
  return Object.values(APP_PROPERTIES).some((one) => one === name.toLowerCase())
}

/**
 * The types a property can have. Chosen on the property's page
 * and kept in `.config/properties.json`, like `{ "amount": {
 * "type": "number" } }`. Unset or unknown is `text`.
 *
 * `backlink` is one `[[page]]`. `url` is a web address. `icon` and `path` are
 * the types of the app's own two properties; other properties may use them too.
 */
export const PROPERTY_TYPES = ['text', 'number', 'date', 'backlink', 'url', 'icon', 'path'] as const
export type PropertyType = (typeof PROPERTY_TYPES)[number]
export const PROPERTIES_FILE = 'properties.json'

/** The types of the app's own properties. The vault cannot change them. */
const APP_TYPES: Record<string, PropertyType> = { [APP_PROPERTIES.icon]: 'icon', [APP_PROPERTIES.path]: 'path' }

/**
 * A property's type: the app's for its own, else the vault's,
 * matched by name in any case.
 */
export function typeOf(entries: Entries, name: string): PropertyType {
  const own = APP_TYPES[name.toLowerCase()]
  if (own) return own
  const key = Object.keys(entries).find((one) => one.toLowerCase() === name.toLowerCase())
  return PROPERTY_TYPES.find((one) => one === entries[key ?? '']?.type) ?? 'text'
}

/** A YAML block, and where one ends. */
const YAML = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/** What a property can be called. Every pattern for a name is built from this. */
export const PROPERTY_NAME = String.raw`[A-Za-z][\w-]*`

/**
 * A label at the very start: a page property's line, or a label
 * right after another label, which leaves the first one empty.
 */
const LEADING_LABEL = new RegExp(`^${PROPERTY_NAME}::`)

/**
 * A property's name at the start of a line, as `key:` or `key::`. No
 * leading space, so a nested YAML key is not one. `propertyKeys` and
 * `editorPreview` both use it, so the list and the note's colouring agree.
 */
export const PROPERTY_KEY = new RegExp(String.raw`^(${PROPERTY_NAME})(?=\s*:)`)

/** The block a note opens with, in either form, or null. */
interface PageBlock {
  /** Where the block ends and the body begins. */
  end: number
  /** Its property lines, without line endings. */
  lines: string[]
  /**
   * What follows YAML's closing `---`: its line ending, or
   * nothing at the end of the file.
   */
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
    if (!LEADING_LABEL.test(line)) break
    lines.push(line)
    end = stop
  }
  return lines.length > 0 ? { end, lines, yaml: null, eol } : null
}

/** A block's lines as names and values, with quotes taken off. */
function pageEntries(block: PageBlock | null): { name: string; value: string }[] {
  const entry = new RegExp(`^([A-Za-z][\\w-]*)\\s*${block?.yaml ? ':' : '::'}\\s*(.*)$`)
  return (block?.lines ?? []).flatMap((one) => {
    const found = entry.exec(one)
    return found ? [{ name: found[1], value: found[2].trim().replace(/^["'](.*)["']$/, '$1') }] : []
  })
}

/** A top-level property line in this block's form. */
function lineFor(key: string, block: PageBlock | null): RegExp {
  return new RegExp(`^${key}\\s*${block?.yaml ? ':' : '::'}\\s*(.*)$`)
}

/** `key:: value`, or `key::` when empty, with no trailing space. */
function line(key: string, value: string, block: PageBlock | null): string {
  const sep = block?.yaml ? ':' : '::'
  return value === '' ? `${key}${sep}` : `${key}${sep} ${value}`
}

/** The value of page property `key`, or null when it is missing or empty. */
export function readProperty(raw: string, key: string): string | null {
  return pageEntries(pageBlock(raw)).find((one) => one.name === key)?.value || null
}

/**
 * `raw` with `key` set to `value`, or removed when `value` is
 * null, in the block's own form.
 *
 * - The key is there: that line is replaced; every other line is left alone.
 * - The block lacks the key: the line is added at its end, so the order is kept.
 * - No block: a `::` block is started, with a blank line after it.
 * - The last property removed: the block and its blank line go too.
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
  // A block that is the whole note may end without a line ending, and still does.
  const closed = raw.slice(0, block.end).endsWith('\n') || rest !== '' ? eol : ''
  return `${lines.join(eol)}${closed}${rest}`
}

/**
 * The page properties split from the body. Only a block at the
 * start counts: a `---` further down is a horizontal rule.
 */
export function splitPageProperties(raw: string): { prefix: string; body: string } {
  const end = pageBlock(raw)?.end ?? 0
  return { prefix: raw.slice(0, end), body: raw.slice(end) }
}

/** A block property's label: a name and `::`, at the line's start or after a space. */
const BLOCK_LABEL = new RegExp(String.raw`(^|\s)(${PROPERTY_NAME})::`, 'g')

/**
 * Where a number or a date stops: the line's end, a space,
 * punctuation, or a full stop that is not a decimal point.
 */
const STOP = String.raw`(?=$|[\s,;:!?)\]]|\.(?!\d))`

/**
 * Where a value of each type ends, so the owner's words can follow it.
 * A backlink is one `[[…]]`. A url runs to the next space, minus
 * trailing punctuation. An icon is a key (`book`) or an emoji. Text
 * and a path are one word (a `[[link]]` counts as one) unless quoted.
 */
const WORD = /^(?:\[\[[^\]\n]+\]\]|[^\s"“”]\S*)/
const VALUE: Record<PropertyType, RegExp> = {
  number: new RegExp(String.raw`^-?\d+(?:\.\d+)?${STOP}`),
  date: new RegExp(String.raw`^\d{4}-\d{2}-\d{2}${STOP}`),
  backlink: /^\[\[[^\]\n]+\]\]/,
  url: /^https?:\/\/\S*[^\s.,;:!?)\]]/,
  icon: /^(?:[a-z][a-z0-9-]*|[^\x00-\x7F\s]{1,4})(?=$|\s)/,
  path: WORD,
  text: WORD,
}

/** The types whose longer values are written in quotes. */
const QUOTABLE: readonly PropertyType[] = ['text', 'path']

/** Text in quotes: `"`, or the curly pair macOS types instead. */
const QUOTED = /^["“]([^"”\n]*)["”]/

/**
 * `name:: value` for a text value: one word as is, more in
 * quotes. Nothing escapes a quote, so one inside becomes `'`.
 */
export function textProperty(name: string, value: string): string {
  const text = value.replace(/["“”]/g, "'")
  return `${name}:: ${/\s/.test(text) ? `"${text}"` : text}`
}

/** One `key:: value` on a line. */
export interface BlockProperty {
  name: string
  /**
   * The value without quotes; `''` when there is none, or it is
   * not of the property's type.
   */
  value: string
  /** False when what follows the label is not a value of the property's type. */
  valid: boolean
  /** The label's start, the value's span inside any quotes, and the end of it all. */
  from: number
  valueFrom: number
  valueTo: number
  to: number
}

/**
 * The `key:: value` properties on one line, in order, each read as its type. Read
 * left to right, so a `name::` inside a quoted value or a link is not a label.
 *
 * `typeOf` gives each property's type. `prose` is the line with
 * code masked (`proseLines`), when the caller has it: labels are
 * looked for there, and values are read from the line itself.
 */
export function blockProperties(
  line: string,
  typeOf: (name: string) => PropertyType,
  prose = line
): BlockProperty[] {
  const found: BlockProperty[] = []
  const label = new RegExp(BLOCK_LABEL)
  for (let hit = label.exec(prose); hit; hit = label.exec(prose)) {
    const start = line.length - line.slice(hit.index + hit[0].length).trimStart().length
    const rest = line.slice(start)
    const type = typeOf(hit[2])
    const at: BlockProperty = { name: hit[2], value: '', valid: true, from: hit.index + hit[1].length, valueFrom: start, valueTo: start, to: start }
    // Nothing yet, or another label right after: the property is empty.
    if (rest.trim() !== '' && !LEADING_LABEL.test(rest)) {
      const quoted = QUOTABLE.includes(type) ? QUOTED.exec(rest) : null
      const plain = quoted ? null : VALUE[type].exec(rest)
      if (quoted) Object.assign(at, { value: quoted[1], valueFrom: start + 1, valueTo: start + 1 + quoted[1].length, to: start + quoted[0].length })
      else if (plain) Object.assign(at, { value: plain[0], valueTo: start + plain[0].length, to: start + plain[0].length })
      else at.valid = false
    }
    found.push(at)
    // Carry on past the value, so nothing inside it counts as a
    // label. After an empty value, carry on from the label.
    if (at.to > start) label.lastIndex = at.to
  }
  return found
}

/**
 * A line as the editor shows it with the caret elsewhere: each
 * block property's name and quotes left out. A value not of its
 * type keeps its name. For pages that quote a line.
 */
export function readBlock(line: string, typeOf: (name: string) => PropertyType): string {
  let out = ''
  let at = 0
  for (const one of blockProperties(line, typeOf)) {
    if (!one.valid) continue
    out += line.slice(at, one.from) + line.slice(one.valueFrom, one.valueTo)
    at = one.to
  }
  return out + line.slice(at)
}

/**
 * Every property a note carries, in order: its page properties, then
 * each block property on its lines, outside code. A block value not
 * of its type is left out. The Properties pages are built from these.
 */
export function noteProperties(raw: string, typeOf: (name: string) => PropertyType): { name: string; value: string }[] {
  const block = pageBlock(raw)
  const lines = raw.split(/\r?\n/)
  const prose = proseLines(raw)
  const first = raw.slice(0, block?.end ?? 0).split('\n').length - 1
  const found = pageEntries(block)
  for (let at = first; at < lines.length; at++) {
    for (const one of blockProperties(lines[at], typeOf, prose[at])) {
      if (one.valid) found.push({ name: one.name, value: one.value })
    }
  }
  return found
}

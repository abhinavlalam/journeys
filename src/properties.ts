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
// **Block properties** are the same `key:: value`, on a line of the note, where a
// value is exactly what its type says (`PROPERTY_TYPES`), so the owner's own words
// can follow it (`blockProperties`).
//
// **Pure**: text in, text out. `vault.ts` does the reading and writing. A line-based
// rewrite rather than a YAML library — `gray-matter` breaks in the webview, where
// `Buffer` is undefined — so this handles the flat `key: value` a note carries and
// leaves anything it does not understand *exactly* as it found it: the app must not
// reformat a block it only came to change one line of.

import { keywordAt } from './actions'
import { proseLines } from './prose'
import type { Entries } from './configEntries'

/**
 * The properties the app itself keeps in a note, **defined here and nowhere else**:
 * the icon its row wears, and where it sits (`knownPath`). Every other property is
 * the vault's own.
 */
export const APP_PROPERTIES = { icon: 'icon', path: 'path' } as const

/** Whether a name is one of the app's own properties, which the vault does not type. */
export function isAppProperty(name: string): boolean {
  return Object.values(APP_PROPERTIES).some((one) => one === name.toLowerCase())
}

/**
 * **What a property's values are**, set on the property's own page and kept in the
 * vault's `.config/properties.json`, one entry per property: `{ "amount": { "type":
 * "number" } }`. Unset, or a word this list does not have, is `text`.
 *
 * `backlink` is a page, `[[…]]`, so it links the page back; `url` is an address on
 * the web; `icon` and `path` are what the app's own two properties hold, and a vault
 * may give its own properties those types too.
 */
export const PROPERTY_TYPES = ['text', 'number', 'date', 'backlink', 'url', 'icon', 'path'] as const
export type PropertyType = (typeof PROPERTY_TYPES)[number]
export const PROPERTIES_FILE = 'properties.json'

/** The app's own properties' types, which no entry in the vault changes. */
const APP_TYPES: Record<string, PropertyType> = { [APP_PROPERTIES.icon]: 'icon', [APP_PROPERTIES.path]: 'path' }

/** A property's type — the app's for its own, else the entries', by name whatever
 *  its case. */
export function typeOf(entries: Entries, name: string): PropertyType {
  const own = APP_TYPES[name.toLowerCase()]
  if (own) return own
  const key = Object.keys(entries).find((one) => one.toLowerCase() === name.toLowerCase())
  return PROPERTY_TYPES.find((one) => one === entries[key ?? '']?.type) ?? 'text'
}

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

/** A block's `key: value` or `key:: value` lines as names and values, quotes off —
 *  a value written by hand may carry them, and one `withProperty` writes does not. */
function pageEntries(block: PageBlock | null): { name: string; value: string }[] {
  const entry = new RegExp(`^([A-Za-z][\\w-]*)\\s*${block?.yaml ? ':' : '::'}\\s*(.*)$`)
  return (block?.lines ?? []).flatMap((one) => {
    const found = entry.exec(one)
    return found ? [{ name: found[1], value: found[2].trim().replace(/^["'](.*)["']$/, '$1') }] : []
  })
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

/** The value of page property `key`, or null when the note has none, or an empty one. */
export function readProperty(raw: string, key: string): string | null {
  return pageEntries(pageBlock(raw)).find((one) => one.name === key)?.value || null
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

/** A block property's label: a name and `::`, at the line's start or after a space. */
const BLOCK_LABEL = /(^|\s)([A-Za-z][\w-]*)::/g

/** Where a number or a date stops: the line's end, a space, punctuation, or a full
 *  stop that is not a decimal point. */
const STOP = String.raw`(?=$|[\s,;:!?)\]]|\.(?!\d))`

/**
 * **What a value of each type is**, from where it begins — exactly that, so the
 * owner's own words can follow it on the line. A backlink is one `[[…]]`; a url
 * runs to the next space, less the punctuation of the sentence around it; an icon
 * is a key (`book`) or an emoji; text and a path are one word (a `[[link]]` counts
 * as one) unless they are quoted, which is `QUOTED`.
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

/** The types whose longer values are written between quotes. */
const QUOTABLE: readonly PropertyType[] = ['text', 'path']

/** Text between quotes, which is how text longer than a word is written: `"`, or the
 *  curly pair macOS types in its place, as it types `—` for `--`. */
const QUOTED = /^["“]([^"”\n]*)["”]/

/** A label at the very start: the value before it was left empty. */
const NEXT_LABEL = /^[A-Za-z][\w-]*::/

/** One `key:: value` on a line. */
export interface BlockProperty {
  name: string
  /** The value, quotes off; `''` when there is none, or none of the property's type. */
  value: string
  /** False when what follows the label is not a value of the property's type. */
  valid: boolean
  /** The label's start; the value's own span, inside any quotes; the end of it all. */
  from: number
  valueFrom: number
  valueTo: number
  to: number
}

/**
 * The `key:: value` properties one line carries, in order, each **as its type reads
 * it** — a number, a date, one backlink, a url, an icon, or a path or text: a word,
 * or a run between quotes. Read
 * left to right, so a `name::` inside a quoted value or a link is not a label, and a
 * value's end is where the line goes back to being prose.
 *
 * `typeOf` is each property's type (`.config/properties.json`). `prose` is the line
 * with its code masked (`proseLines`) when the caller has it: labels are looked for
 * there, so one in a code span is not one, and values are read off the line itself.
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
    // Nothing yet, or the next label straight after this one: a property not filled in.
    if (rest.trim() !== '' && !NEXT_LABEL.test(rest)) {
      const quoted = QUOTABLE.includes(type) ? QUOTED.exec(rest) : null
      const plain = quoted ? null : VALUE[type].exec(rest)
      if (quoted) Object.assign(at, { value: quoted[1], valueFrom: start + 1, valueTo: start + 1 + quoted[1].length, to: start + quoted[0].length })
      else if (plain) Object.assign(at, { value: plain[0], valueTo: start + plain[0].length, to: start + plain[0].length })
      else at.valid = false
    }
    found.push(at)
    // Past a value, so nothing inside it is a label; an empty one takes nothing,
    // and the search goes on from the label, with the space the next one needs.
    if (at.to > start) label.lastIndex = at.to
  }
  return found
}

/**
 * **A line as it reads**: each block property's name and quotes left out, as the
 * editor draws the line with the caret elsewhere — for a page quoting the line, so
 * the page draws what the note draws. A value not of its type keeps its name.
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
 * **Every property a note carries**, in the order written: its page properties,
 * then each block property on its lines — code left out, as it is for everything
 * that reads a note for meaning. The Properties pages are made of these.
 *
 * A block value that is not of its property's type is not one, and is left out.
 * Until the vault's collections are migrated, a line carrying a `--keyword` is a
 * collection's, and its `label::<<value>>` fields are not read as block properties.
 */
export function noteProperties(raw: string, typeOf: (name: string) => PropertyType): { name: string; value: string }[] {
  const block = pageBlock(raw)
  const lines = raw.split(/\r?\n/)
  const prose = proseLines(raw)
  const first = raw.slice(0, block?.end ?? 0).split('\n').length - 1
  const found = pageEntries(block)
  for (let at = first; at < lines.length; at++) {
    if (keywordAt(prose[at])) continue
    for (const one of blockProperties(lines[at], typeOf, prose[at])) {
      if (one.valid) found.push({ name: one.name, value: one.value })
    }
  }
  return found
}

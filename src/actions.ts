// A `--keyword` on a line, and what a collection makes of one.
//
//     09:42 --expense on [[Harbour Bistro]] using
//
// `--keyword` names a collection, and this module owns the rule for what one is:
// `OPENER`. The Actions pane lists the keywords the notes carry, and a collection's
// view gathers the lines that carry one — both read with that rule, so a list and a
// view cannot disagree about what counts.
//
// **What went, and why it is not coming back by accident.** There was a registry of
// *kinds* here — `ACTION_KINDS`, one entry (`calendar`), with the properties each
// kind required and a `missing` list for a line that had not got them all — and
// `parseAction` read a line against it so the editor could mark the keyword and dim
// its `key:` names. The calendar pane it served went a long time ago: nothing
// collected those lines, no note in the vault wrote one, and no test asserted the
// mark. It marked `--calendar` and nothing else, so the keywords a journal actually
// carries were never marked by it either. It is in the history.
//
// **Pure**: a string in, a description out.

import { maskCode } from './links'

/**
 * The dashes that open a keyword: `--`, and **the em dash macOS makes of it**.
 *
 * System-wide "smart dashes" rewrites `--` as you type, in a WKWebView as anywhere
 * else, so a journal line comes out `—instagram` and the app — which knew only
 * `--` — read it as prose. Reported from the running app with the line in the vault
 * to prove it: `- —instagram doomscrolled for time::<<20>>`, which collected
 * nothing. The app reads what the OS actually put in the file rather than asking
 * for a system setting to be turned off, and nothing rewrites those bytes; taking
 * the completion does, because that is the user typing it.
 */
const DASHES = '(?:--|\u2014|\u2013)'

/** `--keyword` as far as it has been typed, for the popup's `matchBefore`. */
export const KEYWORD_PREFIX = new RegExp(`${DASHES}[a-z0-9-]*`)

/**
 * The keyword a **declaration** opens with, and the space after it.
 *
 * Exported because two readers strip it — the fields a structure names, and the
 * detail the popup shows beside a name — and both had their own `--` written out.
 * Which was the whole of a reported bug: a structure typed with the em dash macOS
 * substitutes kept its keyword *inside* the first field's opening literal, so the
 * literal was `—instagram doomscrolled for time::<<` and no line ever carried it.
 * The table came out empty against a line that plainly says `time::<<20>>`.
 */
export const DECLARED_KEYWORD = new RegExp(`^\\s*${DASHES}[a-z][a-z0-9-]*`)

/**
 * `--keyword`, **wherever it sits in the line** — the one rule for what one is.
 *
 * It was anchored to the start of a line's content, past any indent and any bullet,
 * and that is not how these are written. From a real journal:
 *
 *     09:42 --expense on [[Harbour Bistro]]
 *     10:00 - Making --feature-updates for [[Journeys]]
 *     12:00 to 12:30 --research-activity for [[Rhea]]
 *
 * The clock comes first, the prose wraps around it, and the keyword lands where the
 * sentence puts it. So the rule is a search rather than an anchor.
 *
 * `(^|\s)` and not a bare search: the dashes have to start a word, or a hyphenated
 * `stroke--width` in prose would read as one. A lowercase letter after them, for the
 * same reason a `---` rule and an em dash are not keywords.
 */
const OPENER = new RegExp(`(^|\\s)${DASHES}([a-z][a-z0-9-]*)`)

/**
 * Where a line's `--keyword` sits, or null — the same `OPENER` the pane counts
 * with and a collection gathers by, so the editor cannot disagree with either
 * about which lines are a collection's.
 */
export function keywordAt(line: string): { from: number; to: number; name: string } | null {
  const opener = OPENER.exec(line)
  if (!opener) return null
  const from = (opener.index ?? 0) + opener[1].length
  return { from, to: from + opener[0].length - opener[1].length, name: opener[2] }
}

/**
 * **What on a collection line is the app's own writing**, in order: the keyword,
 * each `label::`, and the `<<`/`>>` that bound each value.
 *
 * One rule, two readers. The editor marks the keyword and hides the rest while the
 * caret is elsewhere; a collection's page draws the same spans, showing them in the
 * structure it declares and hiding them in the lines it gathered. Written twice
 * they would drift, and the drift would be a page that disagrees with the note it
 * is quoting — the arrangement `PROPERTY_KEY` already has between the pane's list
 * and the editor's colour.
 *
 * The value between a slot's brackets is **not** in here: it is what was typed, and
 * the caller keeps whatever lies between the spans.
 */
interface LineSyntax {
  from: number
  to: number
  /** `blank` is an **empty field with its lead-in** — see below. */
  kind: 'keyword' | 'label' | 'bracket' | 'blank'
}

/**
 * With the line's declaration, an empty field is one `blank` span from the end of
 * the field before it to its own closing `>>` — the connective prose, the label,
 * the brackets, together.
 *
 * Without it a line with a `for::` nobody filled rendered as `… 187501.99 |` and
 * every `--youtube` line ended in a dangling ` |`: the label and the brackets hid,
 * and the ` | ` that led into them did not, because nothing knew it *led into
 * them*. The declaration knows. It is the same string the snippet types, the
 * table reads and the page shows — this makes the renderer its fourth reader, and
 * leaves no scaffolding to strip out of a vault's notes by hand.
 *
 * Labels and brackets inside a blank are dropped from the list, so a reader that
 * hides both does not hide one twice.
 */
export function collectionSyntax(line: string, declaration?: string | null): LineSyntax[] {
  const keyword = keywordAt(line)
  if (!keyword) return []
  const found: LineSyntax[] = [{ from: keyword.from, to: keyword.to, kind: 'keyword' }]
  const rest = line.slice(keyword.to)
  for (const label of rest.matchAll(FIELD_LABEL)) {
    const at = keyword.to + (label.index ?? 0)
    found.push({ from: at, to: at + label[0].length, kind: 'label' })
  }
  for (const slot of rest.matchAll(HOLE)) {
    const at = keyword.to + (slot.index ?? 0)
    found.push({ from: at, to: at + 2, kind: 'bracket' })
    found.push({ from: at + slot[0].length - 2, to: at + slot[0].length, kind: 'bracket' })
  }
  const blanks: LineSyntax[] = []
  if (declaration) {
    // The walk `readFields` makes, keeping where the last field ended.
    let prevEnd = keyword.to
    for (const { from, to } of slotsIn(line, templateFields(declaration))) {
      if (!line.slice(from, to).trim()) blanks.push({ from: prevEnd, to: to + 2, kind: 'blank' })
      prevEnd = to + 2
    }
  }
  const inBlank = (part: LineSyntax) =>
    blanks.some((blank) => part.from >= blank.from && part.to <= blank.to)
  return [...found.filter((part) => !inBlank(part)), ...blanks].sort((a, b) => a.from - b.from)
}

/**
 * `amount:: ` on a collection line — the label, and the one space after it.
 *
 * The space goes with it, or `spent currency:: EUR` would read `spent EUR` with two
 * spaces where the label was; the leading space stays, or it would read `spentINR`.
 */
const FIELD_LABEL = /[A-Za-z][\w-]*\s*::\s?/g



/** `OPENER` as a search. Built once: `matchAll` species-constructs its own regex,
 *  so there is no `lastIndex` to share. */
const KEYWORDS = new RegExp(OPENER, 'g')

/**
 * A note's lines with everything that is **not prose** masked out: fenced blocks,
 * their delimiters and inline code become spaces.
 *
 * `maskCode`'s rule, the one the links read too. A vault holds shell in fences —
 * `--postprocessor-args`, `--sub-langs` — and a flag someone pasted is not a
 * collection they keep. This had a rule of its own, which closed a fence on any
 * run of backticks, so a fence holding a shorter one leaked what followed. Line
 * numbers are kept, because `collectLines` reads the *unmasked* line back out by
 * index.
 */
export function proseLines(raw: string): string[] {
  return maskCode(raw).split(/\r?\n/)
}

/**
 * Every `--keyword` the lines of a note carry, in the order written.
 *
 * The names only, and off `OPENER` — the same rule `collectLines` gathers a line
 * with — so the list in the Actions pane and the lines a collection's view shows
 * cannot disagree about what counts. The same arrangement `propertyKeys` and
 * `PROPERTY_KEY` have, and for the same reason.
 */
export function actionKeywords(raw: string): string[] {
  return proseLines(raw).flatMap((line) => [...line.matchAll(KEYWORDS)].map((one) => one[2]))
}

// ---------------------------------------------------------------------------
// What a collection collects
// ---------------------------------------------------------------------------

/**
 * One collected entry: a line carrying the keyword, and the lines nested under it.
 *
 * **A collection is not a file.** `.config/actions/collections/expense.md` was an
 * empty page with the name on it; what someone wants when they click `expense` is
 * the twenty lines in the vault that say `--expense`, with whatever is written
 * under each. So a collection is a *view* over the notes, and this is the shape of
 * what it shows.
 */
export interface CollectedLine {
  /** The line itself, its own indent and trailing space off. */
  text: string
  /**
   * The lines nested under it, in order, with **the entry's indent removed and
   * nothing else touched** — so what is left is the nesting as it was written, and
   * the view can render it verbatim rather than modelling depth in numbers.
   */
  below: string[]
  /** 0-based line number in the note. Identity for a row, and the only way two
   *  identical lines in one note are two entries. */
  at: number
}

/**
 * A line's indent, or **-1 for a blank line**, which is what `gatherLines` needs: a
 * blank must not end the run below an entry, so it has to be distinguishable from a
 * line at indent 0 rather than counted as one.
 *
 * Named for the -1 because `editorCommands` has its own version that answers the
 * line's *length* for a blank, since there it is looking for where the content
 * starts. Two behaviours under one name is the shape of a bug waiting, which
 * `baseName` in `vaultModel` already cost once.
 */
function indentOrBlank(line: string): number {
  return line.trim() === '' ? -1 : line.length - line.trimStart().length
}

/**
 * Every line in a note carrying `--keyword`, each with what is nested under it.
 *
 * **Nesting is the indent and nothing else.** A run under an entry continues while
 * the lines are deeper than the entry's own line, and ends at the first line back
 * at its level — the same rule the eye uses, and the same one a list marker's box
 * is drawn from. A blank line does not end it, because a nested block can hold
 * one; blanks left on the end of a run are dropped rather than shown as air.
 *
 * A fence *under* an entry is content and comes along. A fence the entry is
 * *inside* means there is no entry: `actionKeywords` skips code for the same
 * reason, and this has to agree with it or the pane would list a collection whose
 * view is empty.
 *
 * Two keywords on one line make one entry in each of their collections, which is
 * the same answer `mentions` gives for two links on a line: one line is one thing
 * to read.
 */
export function collectLines(raw: string, keyword: string): CollectedLine[] {
  const want = keyword.toLowerCase()
  return gatherLines(raw, (prose) =>
    // Two keywords on one line make one entry in each of their collections, which
    // is the answer `mentions` gives for two links on a line: one line is one
    // thing to read.
    [...prose.matchAll(KEYWORDS)].some((one) => one[2] === want)
  )
}

/**
 * Every line `wanted` accepts, **with the run nested under it** — the gather half
 * of a collection's view, and now a tag's.
 *
 * Split out when tags asked the same question of a different syntax: what differs
 * between the two is one predicate, and a second copy of this loop is two pages
 * that could disagree about where a block ends. `wanted` is handed the line with
 * its code **masked**, so a `--keyword` or a `#tag` inside a fence or a backtick
 * span is not one; the text kept is the *unmasked* line, which is why the mask
 * preserves the numbering rather than filtering.
 *
 * The run continues while the lines are deeper than the entry's own and ends at the
 * first one back at its level. A blank line does not break it, and trailing blanks
 * are dropped. The entry's indent comes off each, so what is left is the nesting as
 * written and `pre-wrap` can print it verbatim.
 */
export function gatherLines(raw: string, wanted: (prose: string) => boolean): CollectedLine[] {
  const lines = raw.split(/\r?\n/)
  // Masked in one pass, because the run below an entry is gathered by looking
  // forward and cannot re-count fences as it goes.
  const prose = proseLines(raw)

  const found: CollectedLine[] = []
  for (let at = 0; at < lines.length; at++) {
    if (!wanted(prose[at])) continue

    const indent = indentOrBlank(lines[at])
    const below: string[] = []
    for (let next = at + 1; next < lines.length; next++) {
      const deeper = indentOrBlank(lines[next])
      if (deeper !== -1 && deeper <= indent) break
      below.push(lines[next].slice(indent).replace(/\s+$/, ''))
    }
    while (below.length > 0 && below[below.length - 1].trim() === '') below.pop()

    found.push({ text: lines[at].trim(), below, at })
  }
  return found
}

// ---------------------------------------------------------------------------
// What a collection declares

/**
 * Where the structures live: **one JSON file, not a folder of markdown**.
 *
 * `.config/actions/collections.json`, keyed by collection name:
 *
 *     {
 *       "expense": {
 *         "structure": "--expense amount::<<>> at merchant:: [[<<>>]]",
 *         "fields": ["amount", "merchant"]
 *       }
 *     }
 *
 * It was a file per collection whose first `--` line was the declaration, which
 * asks anything reading the vault to glob a folder and parse markdown to find a
 * fact that is plainly data. **An agent walking these notes should be able to read
 * the structures in one open**, which is the whole reason for the shape.
 *
 * `structure` is the authority. `fields` is written beside it for that reader —
 * the names, in order, so nothing has to implement `templateFields` to know what a
 * line of this kind carries — and the app **re-derives it on every read**, so a
 * hand-edited `structure` can never be contradicted by a stale list next to it.
 */
export const COLLECTIONS_FILE = 'actions/collections.json'

/**
 * The structures a `collections.json` holds, or null when the text is not JSON.
 *
 * Null and not `{}`: a file the app cannot read is a file it must not overwrite,
 * and the two answers are told apart by the caller — the same bargain
 * `.config/settings.json` makes with a config it cannot parse.
 *
 * Anything that is not an object with a string `structure` is skipped rather than
 * repaired. It is a file someone may edit by hand, and a half-typed entry is not a
 * reason to throw the rest away.
 */
export function readCollections(text: string): Record<string, string> | null {
  const parsed = asObject(text)
  if (!parsed) return null
  const found: Record<string, string> = {}
  for (const [name, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== 'object') continue
    const structure = (entry as { structure?: unknown }).structure
    if (typeof structure === 'string') found[name] = structure
  }
  return found
}

/** The JSON object a text holds, or null — which this file means as "do not
 *  overwrite", so a parse failure and a wrong shape are one answer. */
export function asObject(text: string): Record<string, unknown> | null {
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
 * `text` with `name`'s structure set — the whole file, written back sorted.
 *
 * Sorted by name because this is a file in a vault someone syncs: a diff that
 * reorders itself on every write is a diff nobody reads. Entries the app does not
 * understand are carried through untouched, for the same reason it skips them on
 * the way in.
 */
export function withCollection(text: string, name: string, structure: string): string | null {
  // An empty file is an empty set, not a broken one: the first collection written
  // into a vault has nothing to read.
  const parsed = text.trim() ? asObject(text) : {}
  if (!parsed) return null
  // **What the app writes opens with `--`.** The box a structure is typed into is an
  // ordinary input, so macOS substitutes an em dash there as readily as in the
  // note — and a structure stored with one inserts one into every line it completes.
  // The app *reads* all three dashes (see `DASHES`); it writes one of them.
  const canonical = structure.replace(new RegExp(`^(\\s*)${DASHES}`), '$1--')
  // `structure` is the declaration — `''` for a collection that exists and has not
  // been given a shape, which is what the `+` makes — and `fields` is derived
  // beside it for whatever reads this file without this code.
  const entry = {
    structure: canonical,
    fields: templateFields(canonical).map((field) => field.name),
  }
  const next = { ...parsed, [name]: { ...(parsed[name] as object), ...entry } }
  const sorted = Object.fromEntries(Object.keys(next).sort().map((key) => [key, next[key]]))
  return `${JSON.stringify(sorted, null, 2)}\n`
}

// ---------------------------------------------------------------------------

/**
 * A **slot** in a declaration: `<<amount>>`.
 *
 * Doubled brackets, and not for symmetry with `[[a link]]` alone: markdown reads a
 * single `<something>` as an **autolink**, so `<<amount>>` in a line is already
 * syntax — the editor would draw it as a link and another tool would render it as
 * one. `<<` is nothing in markdown, exactly as `[[` is nothing, which is why the
 * app can spend both.
 *
 * The name inside is the slot's own: it becomes the placeholder the caret lands on
 * and the column's heading, so the structure explains itself as it is filled in.
 *
 * No newline and no nesting, so an unclosed `<<` is text rather than a slot that
 * swallows the rest of the line.
 */
const HOLE = /<<([^<>\n]*)>>/g

/**
 * A declaration as a CodeMirror snippet: `amount::<<>>` becomes `amount::<<${1:}>>`.
 *
 * Which is the whole of what makes the completion work — `snippetCompletion` puts
 * the caret in the first slot and Tab moves to the next, so the structure is filled
 * in rather than deleted. A brace in the declaration is escaped on the way, because
 * `${` is the snippet syntax and a `{` someone wrote is a `{` they want.
 *
 * **The brackets are literal and the field sits between them.** You type *into* a
 * slot, not over it: `<<>>` is punctuation the line keeps, exactly as `[[ ]]` is,
 * and `amount::<<480>>` is the finished line. A named slot's name is the field's
 * placeholder — selected, so typing replaces it — and an empty one is an empty
 * field with the caret between the brackets.
 *
 * A **number** and not a name, which is not cosmetic: CodeMirror links snippet
 * fields that share a name, so a line of `<<>>` slots would be *one* field repeated
 * — type into the first and every slot fills with it. Numbered, they are as
 * distinct as their order.
 */
export function declarationSnippet(line: string): string {
  let out = ''
  let read = 0
  let seq = 0
  for (const hole of line.matchAll(HOLE)) {
    out += escapeBraces(line.slice(read, hole.index))
    // `${1:…}` has no escape for a brace, and a field name is not where one belongs.
    out += `<<\${${++seq}:${hole[1].trim().replace(/[{}]/g, '')}}>>`
    read = (hole.index ?? 0) + hole[0].length
  }
  return out + escapeBraces(line.slice(read))
}

const escapeBraces = (text: string) => text.replace(/[{}]/g, (brace) => `\\${brace}`)

// ---------------------------------------------------------------------------
// What a declaration says a line is made of
// ---------------------------------------------------------------------------

/**
 * One **field** a declaration names — its name, and the literal text that
 * introduces it.
 *
 * A *field* and not a *property*: a property is a key in a note's frontmatter and
 * says something about the whole note. A field is part of one line. The app already
 * draws that distinction one scale apart, and giving them one word would put two
 * unrelated things under it.
 */
export interface TemplateField {
  name: string
  /** The literal that introduces it, **including the `<<` that opens the slot** —
   *  `` spent currency::<< `` — searched for in a line to find where the value
   *  starts. The value ends at the matching `>>`, so nothing needs to say where. */
  opens: string
}

/**
 * The fields a declaration names, in order.
 *
 * **The declaration is the schema.** It is already the snippet you type into and
 * the documentation of the shape; read as a sequence of literals and holes it is
 * also the parser that reads the values back out, so one string does three jobs and
 * a note needs no second syntax for the app to understand it.
 */
export function templateFields(declaration: string): TemplateField[] {
  return holesOf(declaration)
    .filter((hole) => hole.name)
    .map(({ name, opens }) => ({ name, opens: `${opens}<<` }))
}

/** Every slot in a declaration's body, named or not, with where it sits. */
interface Hole {
  name: string
  /** The literal in front of it, up to the `<<`. */
  opens: string
  /** What the declaration wrote inside it — a default, or a name. */
  inner: string
  /** Its span in the body. */
  from: number
  to: number
}

function holesOf(declaration: string): Hole[] {
  // **The keyword and not a character more.** This consumed the whitespace after it
  // and put one space back, which is right when the declaration has one and wrong
  // when it does not: `--watch/<<source>>` became ` /<<source>>`, so the field's
  // opening literal wanted a space the line never wrote and the source read as
  // absent. What follows the keyword is the user's, whitespace included.
  const body = declaration.replace(DECLARED_KEYWORD, '')
  const holes: Hole[] = []
  let read = 0
  for (const hole of body.matchAll(HOLE)) {
    const from = hole.index ?? 0
    const opens = body.slice(read, from)
    // **A `label::` names the column and the slot's own text is its default;
    // otherwise the slot names itself.** `currency::<<EUR>>` is a column called
    // currency pre-filled with EUR — `declarationSnippet` already inserts the inner
    // text, so the default was one comparison away. The `::` is what decides, and
    // has to be: `labelOf` answers the last *word* before a slot whether or not it
    // is a label, so ` at <<merchant>>` must still be a column called merchant and
    // not one called at. Five tests said so the moment the label was tried first.
    const inner = hole[1].trim()
    const name = isLabelled(opens) ? labelOf(opens) : inner || labelOf(opens)
    holes.push({ name, opens, inner, from, to: from + hole[0].length })
    read = from + hole[0].length
  }
  return holes
}

/**
 * A line written from a declaration and values for its fields — `readFields` the
 * other way round, for the one thing in the app that writes a collected line on
 * the user's behalf (the calendar's sync).
 *
 * A slot takes its field's value, or keeps what the declaration wrote inside it
 * when that is a default (`currency::<<EUR>>`); a slot that names itself and has no
 * value comes out empty. **A `|` divides a structure into parts, and a part whose
 * every slot came out empty is left out** — an event nobody is `with::` should not
 * carry ` | with:: <<>>` down a journal. The first part always stays, because the
 * keyword is in it. `readFields` reads a line with parts missing exactly as it
 * reads a full one, since a literal it cannot find is a field it skips.
 */
export function fillFields(declaration: string, values: Record<string, string>): string {
  const keyword = DECLARED_KEYWORD.exec(declaration)?.[0].trim() ?? ''
  const body = declaration.replace(DECLARED_KEYWORD, '')
  const holes = holesOf(declaration)
  const valueOf = (hole: Hole) => values[hole.name] ?? (isLabelled(hole.opens) ? hole.inner : '')
  // Parts are cut on the *declaration's* pipes, before any value — whose own `|`
  // is text — goes in. A slot stands in as its index, between NULs, until then.
  let marked = ''
  let read = 0
  holes.forEach((hole, at) => {
    marked += `${body.slice(read, hole.from)}\u0000${at}\u0000`
    read = hole.to
  })
  marked += body.slice(read)
  const slots = /\u0000(\d+)\u0000/g
  const kept = marked.split('|').filter((part, at) => {
    const own = [...part.matchAll(slots)].map((slot) => holes[Number(slot[1])])
    return at === 0 || own.length === 0 || own.some((hole) => valueOf(hole) !== '')
  })
  const line = kept.join('|').replace(slots, (_, at) => `<<${valueOf(holes[Number(at)])}>>`)
  return `${keyword}${line}`.replace(/\s+$/, '')
}

/**
 * The values one line gives for those fields.
 *
 * **The brackets are the bounds, and that is the whole parser.** A value is what
 * sits between `<<` and `>>` — so a value may hold spaces, a comma, a `::` or a
 * `[[link]]` and still end exactly where it ends. This used to be three rules and
 * a longest-suffix search for "where could this value possibly stop", because the
 * slot was typed *over* and the line came out with nothing marking a value at all;
 * every one of them was guesswork the brackets make unnecessary.
 *
 * **Partial, and never a complaint.** A literal the line does not carry is a field
 * skipped, not a line rejected — the search simply does not advance, so the field
 * after it is still found. A note is a draft; the app does not get to say a line is
 * wrong.
 *
 * The scan starts at the keyword — a journal line opens with a clock, and the
 * template describes what follows the keyword, not the whole line.
 */
export function readFields(
  line: string,
  fields: readonly TemplateField[]
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const { field, from, to } of slotsIn(line, fields)) {
    const value = line.slice(from, to).trim()
    // An empty slot is a value nobody has typed, not a blank value.
    if (value) values[field.name] = value
  }
  return values
}

/**
 * Where each field's value sits in a line: after the literal that introduces it, up
 * to the `>>` that closes it. **The one walk** — `readFields` takes the values out
 * of it and `collectionSyntax` finds the empty slots with it, so a table and the
 * editor cannot disagree about where a field is. A literal the line does not carry
 * does not advance the search.
 */
function* slotsIn(line: string, fields: readonly TemplateField[]) {
  let at = keywordAt(line)?.to ?? 0
  for (const field of fields) {
    const opens = line.indexOf(field.opens, at)
    if (opens === -1) continue
    const from = opens + field.opens.length
    const to = line.indexOf('>>', from)
    if (to === -1) continue
    yield { field, from, to }
    at = to + 2
  }
}

/** Whether the literal ends in a real label — `amount::`, `at merchant:` — rather
 *  than trailing off in prose. The `[[` that opens a link slot does not count. */
function isLabelled(opens: string): boolean {
  return /:\s*(\[\[\s*)?$/.test(opens)
}

/**
 * The name an **empty** slot takes: the label in front of it.
 *
 * `amount::<<>>` says `amount` once, which is how someone writes a structure —
 * naming it twice, `amount:: <<amount>>`, is the same word said for the parser's
 * benefit. So the last word of the opening literal is the field's name, with the
 * `::` or `:` that labels it, the `[[` that opens a link, and any spaces taken off.
 *
 * A slot may still name itself when there is no label to take it from — a leading
 * `--tasks <<what>>` has nothing in front of it — and a name written inside the
 * slot always wins.
 */
function labelOf(opens: string): string {
  const label = opens.replace(/\[\[\s*$/, '').trim().replace(/:+$/, '').trim()
  return /[A-Za-z0-9]$/.test(label) ? (label.split(/\s+/).pop() ?? '') : ''
}

import { describe, expect, it } from 'vitest'
import {
  actionKeywords,
  collectionSyntax,
  keywordAt,
  collectLines,
  declarationSnippet,
  readCollections,
  readFields,
  templateFields,
  withCollection,
} from '../actions'

/**
 * `--keyword` and the `key: value` pairs that define it.
 *
 * The syntax exists so a line can be read without quoting anything, which is what
 * fixes its shape: a value runs to the next `key:` or to the end of the line. What
 * these pin is the reading, not any behaviour — nothing in `actions.ts` acts.
 */
/**
 * **Every `--keyword` a note's lines carry.** The Collections group lists what the
 * notes are *using*, the way Properties lists the property names in play — and it
 * reads them with `OPENER`, the same rule `collectLines` gathers a line with, so a
 * list of collections and the lines one shows cannot disagree about what counts.
 */
describe('actionKeywords', () => {
  it('answers with the names, in the order written', () => {
    const note = [
      '# A page',
      '--reading date: 2026-09-12',
      '- --calendar date: 2026-09-12 title: Kickoff',
      'nothing here',
      '  * --reading again',
    ].join('\n')
    expect(actionKeywords(note)).toEqual(['reading', 'calendar', 'reading'])
  })

  it('reads every keyword on a line, wherever it sits', () => {
    expect(actionKeywords('    --deep in')).toEqual(['deep'])
    expect(actionKeywords('- --bulleted x')).toEqual(['bulleted'])
    // The real shapes: after a clock, after prose, hyphenated.
    expect(actionKeywords('09:42 --expense on [[Harbour Bistro]]')).toEqual(['expense'])
    expect(actionKeywords('12:00 to 12:30 --research-activity for [[Rhea]]')).toEqual([
      'research-activity',
    ])
    expect(actionKeywords('10:00 - Making --feature-updates for [[Journeys]]')).toEqual([
      'feature-updates',
    ])
    // A rule is not a keyword, nor a spaced pair, nor dashes inside a word.
    expect(actionKeywords('---')).toEqual([])
    expect(actionKeywords('-- spaced')).toEqual([])
    expect(actionKeywords('stroke--width is a property')).toEqual([])
  })

  /** A vault holds shell in code fences — `--postprocessor-args`, `--sub-langs` —
   *  and a flag someone pasted is not a collection they keep. */
  it('leaves code alone, fenced or inline', () => {
    const note = ['```sh', 'yt-dlp --sub-langs en url', '```', 'and `--inline` too'].join('\n')
    expect(actionKeywords(note)).toEqual([])
    expect(actionKeywords('~~~\n--fenced\n~~~\n--outside\n')).toEqual(['outside'])
  })

  it('answers with nothing for a note that carries none', () => {
    expect(actionKeywords('# Title\n\njust prose\n')).toEqual([])
  })
})

/**
 * **What a collection collects.**
 *
 * A collection is not a file — clicking `expense` used to write an empty
 * `expense.md` — it is the lines of the vault that carry `--expense`, each with
 * whatever is written under it. Nesting is the indent and nothing else, which is
 * the rule the eye uses and the one a list marker's box is drawn from.
 */
describe('collectLines', () => {
  it('collects a line wherever the keyword sits in it', () => {
    const note = [
      '# Tuesday',
      '',
      '09:42 --expense on [[Harbour Bistro]] using',
      '10:00 - Making --feature-updates for [[Journeys]]',
      '12:00 to 12:30 --research-activity for [[Rhea]]',
    ].join('\n')
    expect(collectLines(note, 'expense').map((one) => one.text)).toEqual([
      '09:42 --expense on [[Harbour Bistro]] using',
    ])
    expect(collectLines(note, 'feature-updates')[0].at).toBe(3)
    expect(collectLines(note, 'research-activity')).toHaveLength(1)
  })

  it('takes the lines nested under an entry, and stops at its own level', () => {
    const note = [
      '09:42 --expense on [[Harbour Bistro]]',
      '  - amount:: 480',
      '  - card',
      '10:00 - standup',
    ].join('\n')
    const [entry] = collectLines(note, 'expense')
    // The entry's own indent comes off; a top-level entry has none, so its
    // children keep the two spaces that make them children.
    expect(entry.below).toEqual(['  - amount:: 480', '  - card'])
    expect(entry.text).toBe('09:42 --expense on [[Harbour Bistro]]')
  })

  // The entry's own indent comes off and **nothing else does**, so the view can
  // print the run verbatim: two levels under the entry are still two levels.
  it('keeps the nesting under an entry, relative to the entry', () => {
    const note = ['  - 09:42 --expense at the airport', '    - taxi 240', '      - tipped'].join(
      '\n'
    )
    expect(collectLines(note, 'expense')[0].below).toEqual(['  - taxi 240', '    - tipped'])
  })

  it('carries a blank line inside a run, and drops the ones on the end', () => {
    const note = ['--watching a series', '  - s01', '', '  - s02', '', '', 'Something else'].join(
      '\n'
    )
    expect(collectLines(note, 'watching')[0].below).toEqual(['  - s01', '', '  - s02'])
  })

  it('collects an entry with nothing under it', () => {
    expect(collectLines('--note keep this\n--note and this\n', 'note')).toEqual([
      { text: '--note keep this', below: [], at: 0 },
      { text: '--note and this', below: [], at: 1 },
    ])
  })

  /** The same code rule `actionKeywords` reads by, or the pane would list a
   *  collection whose view is empty. A fence *under* an entry is its content. */
  it('finds no entry inside code, and keeps a fence that is under one', () => {
    const fenced = ['```sh', 'yt-dlp --sub-langs en', '```'].join('\n')
    expect(collectLines(fenced, 'sub-langs')).toEqual([])
    expect(collectLines('Ran `--expense` by hand', 'expense')).toEqual([])
    const under = ['--note how it runs', '  ```sh', '  npm ci', '  ```', 'done'].join('\n')
    expect(collectLines(under, 'note')[0].below).toEqual(['  ```sh', '  npm ci', '  ```'])
  })

  it('counts a name case-insensitively and a line once per collection', () => {
    expect(collectLines('09:00 --expense twice --expense again', 'EXPENSE')).toHaveLength(1)
  })

  it('answers with nothing for a keyword no line carries', () => {
    expect(collectLines('# A page\n\nJust prose.\n', 'expense')).toEqual([])
  })
})

/**
 * **A slot can be empty, and take its name from the label in front of it.**
 *
 * `amount::<<>>` says `amount` once, which is how a person writes a structure.
 * Saying it twice — `amount:: <<amount>>` — is the same word repeated for the
 * parser's benefit, and this is a file someone writes by hand.
 *
 * **The brackets stay in the line.** You type *between* them, so a written line is
 * `amount::<<480>>` and the value's bounds are punctuation rather than a guess.
 * This used to be three rules and a longest-suffix search for where a value could
 * possibly stop; every one of them is gone, and with them the reason a field had to
 * be labelled to survive its neighbours going missing.
 */
describe('a structure written the way a vault writes one', () => {
  const DECL =
    '--expense spent currency::<<>> amount::<<>> at merchant:: <<>> using account::<<>> | Ending Balance end-amount::<<>>'
  const fields = templateFields(DECL)
  const read = (line: string) => readFields(line, fields)

  it('names every field from its label', () => {
    expect(fields.map((f) => f.name)).toEqual([
      'currency',
      'amount',
      'merchant',
      'account',
      'end-amount',
    ])
  })

  it('reads a line written to the whole structure', () => {
    expect(
      read(
        '09:42 --expense spent currency::<<EUR>> amount::<<480>> at merchant:: <<[[Harbour Bistro]]>> using account::<<Northbank>> | Ending Balance end-amount::<<12000>>'
      )
    ).toEqual({
      currency: 'EUR',
      amount: '480',
      merchant: '[[Harbour Bistro]]',
      account: 'Northbank',
      'end-amount': '12000',
    })
  })

  /**
   * **What the brackets buy.** A space, a comma, a colon pair, a link, a `|` — none
   * of them can end a value, because the `>>` does. Every one of these was a value
   * the old rules would have cut short or swallowed a connector into.
   */
  it('reads a value that holds anything but its own closing bracket', () => {
    expect(
      read(
        '20:00 --expense spent currency::<<EUR, or USD>> amount::<<1,299.50>> at merchant:: <<Tea :: Co>> using account::<<a card | shared>> | Ending Balance end-amount::<<>>'
      )
    ).toEqual({
      currency: 'EUR, or USD',
      amount: '1,299.50',
      merchant: 'Tea :: Co',
      account: 'a card | shared',
    })
  })

  /** A slot nobody typed into is a value nobody wrote, not a blank one. */
  it('reads an empty slot as absent', () => {
    expect(read('13:15 --expense spent currency::<<>> amount::<<60>>')).toEqual({ amount: '60' })
  })

  /**
   * **Partial, and never a complaint.** A literal the line does not carry does not
   * advance the search, so the field after it is still found where it is.
   */
  it('reads the fields a line wrote and skips the ones it did not', () => {
    expect(read('13:15 --expense spent amount::<<60>> using account::<<cash>>')).toEqual({
      amount: '60',
      account: 'cash',
    })
    expect(read('15:00 --expense spent amount::<<20>> | Ending Balance end-amount::<<900>>')).toEqual(
      { amount: '20', 'end-amount': '900' }
    )
  })

  /** The line the vault was already full of, against a structure written later. */
  it('reads nothing from a line that predates the structure', () => {
    expect(read('18:00 --expense on [[Corner Shop]] using')).toEqual({})
  })

  /**
   * **Declaration order is the order.** A label written out of turn is not found:
   * each field is looked for after the one before it, so a value cannot be taken
   * from the far end of the line by a label that happens to match.
   */
  it('reads a field written out of order as absent', () => {
    expect(read('17:00 --expense spent account::<<Northbank>> amount::<<7>>')).toEqual({ amount: '7' })
  })

  /** A name inside the slot still wins, for a field no label introduces. */
  it('lets a slot name itself where there is no label', () => {
    expect(templateFields('--tasks <<what>> by <<when>>').map((f) => f.name)).toEqual([
      'what',
      'when',
    ])
  })

  /**
   * **A `label::` names the column and the slot's own text is its default.**
   * `currency::<<EUR>>` is a column called currency, and the snippet inserts EUR
   * pre-filled, so a value that is the same on every line is typed once, in the
   * declaration, and a note's line stops linking a currency code eighteen times.
   * The `::` is what decides: without it the slot still names itself, or
   * ` at <<merchant>>` would be a column called at.
   */
  it('takes the column from a label and the default from the slot', () => {
    const declared = '--expense spent currency::<<EUR>> amount::<<>> at <<merchant>>'
    expect(templateFields(declared).map((f) => f.name)).toEqual(['currency', 'amount', 'merchant'])
    // The snippet is where the default lands: the slot arrives already filled.
    expect(declarationSnippet(declared)).toContain('currency::<<${1:EUR}>>')
    // And a line written from it reads back the value, default or overtyped.
    expect(readFields('--expense spent currency::<<EUR>> amount::<<480>> at <<Corner Shop>>', templateFields(declared)))
      .toEqual({ currency: 'EUR', amount: '480', merchant: 'Corner Shop' })
  })
})

/**
 * **A declaration as a CodeMirror snippet**, and the slot is inserted *visibly*:
 * `amount::<<>>` becomes `amount::${<<amount>>}`, so what lands in the note is
 * `amount::<<amount>>` with the brackets selected. An empty field is a gap between
 * two labels where there is nothing to see and nothing to say where one value ends
 * and the next label begins; the brackets say both, and are typed over.
 */
/**
 * **The em dash macOS makes of `--`.**
 *
 * Smart dashes is a system-wide substitution and a WKWebView gets it like any other
 * text field, so a line typed as `--instagram` lands in the file as `—instagram`
 * and collected nothing. Reported from the running app, with the line in the vault.
 */
describe('the dashes a keyword opens with', () => {
  it('reads the em dash the OS substitutes', () => {
    const real = '- \u2014instagram doomscrolled for time::<<20>>'
    expect(actionKeywords(real)).toEqual(['instagram'])
    expect(keywordAt(real)?.name).toBe('instagram')
    expect(collectLines(real, 'instagram')).toHaveLength(1)
    expect(actionKeywords('09:42 --expense on [[A Shop]]')).toEqual(['expense'])
    // An en dash is the same substitution one keystroke earlier.
    expect(actionKeywords('09:42 \u2013expense on [[A Shop]]')).toEqual(['expense'])
  })

  /**
   * **A structure typed with the em dash still names its fields.** Reported from
   * the running app: `—instagram doomscrolled for time::<<>>` read nothing off
   * `—instagram doomscrolled for time::<<20>>`, because the fields were derived by
   * a strip that knew only `--` — so the keyword stayed *inside* the first field's
   * opening literal and no line could ever carry it. One rule, `DECLARED_KEYWORD`.
   */
  it('strips the keyword a structure opens with, whichever dash it is', () => {
    const typed = '\u2014instagram doomscrolled for time::<<>>'
    expect(templateFields(typed).map((f) => f.name)).toEqual(['time'])
    expect(readFields('-  \u2014instagram doomscrolled for time::<<20>>', templateFields(typed)))
      .toEqual({ time: '20' })
    // And a line typed the other way reads against it, because the keyword is not
    // part of what either side matches on.
    expect(readFields('--instagram doomscrolled for time::<<5>>', templateFields(typed)))
      .toEqual({ time: '5' })
  })

  /**
   * **The keyword is stripped and not a character more.** The strip consumed the
   * whitespace after the keyword and put one space back, which is right when the
   * declaration has one and wrong when it does not: `--watch/<<source>>` became
   * ` /<<source>>`, so the field wanted a space the line never wrote. Found auditing
   * a real vault — four `--watch/yt` lines read their link and not their source.
   */
  it('strips the keyword without touching what follows it', () => {
    const slashed = '--watch/<<source>> link::<<>> | <<title>>'
    expect(templateFields(slashed).map((f) => f.opens)).toEqual([
      '/<<',
      ' link::<<',
      ' | <<',
    ])
    expect(
      readFields('08:30 - --watch/<<yt>> link::<<https://example.test/v>> | <<>>', templateFields(slashed))
    ).toEqual({ source: 'yt', link: 'https://example.test/v' })
  })

  /** What is *stored* has one spelling, so the snippet it completes to does too. */
  it('writes a structure back with plain dashes', () => {
    const written = withCollection('{}', 'instagram', '\u2014instagram for time::<<>>')!
    expect(JSON.parse(written).instagram.structure).toBe('--instagram for time::<<>>')
    expect(JSON.parse(written).instagram.fields).toEqual(['time'])
  })

  it('leaves a dash that is punctuation alone', () => {
    // A space after it is prose.
    expect(actionKeywords('the flight \u2014 instagram was down')).toEqual([])
    // The hyphenated word that made this rule a search rather than an anchor.
    expect(actionKeywords('a stroke--width of 2')).toEqual([])
    // And an em dash joining two words is typography.
    expect(actionKeywords('the flight\u2014instagram')).toEqual([])
  })
})


/**
 * **An empty field hides with its lead-in.** Without the declaration a line's
 * `for::` nobody filled rendered as `… 187501.99 |` — label and brackets hid, the
 * ` | ` that led into them did not, because nothing knew it led into them. The
 * declaration knows: it is the same string the snippet types and the table reads.
 */
describe('a collection line read against its declaration', () => {
  const DECL = '--expense amount::<<>> at merchant:: <<>> | for:: <<>>'
  const kinds = (line: string, decl?: string) =>
    collectionSyntax(line, decl).map((p) => `${p.kind}@${p.from}-${p.to}`)

  it('makes one blank of an empty field, its lead-in included', () => {
    const line = '--expense amount::<<99>> at merchant:: <<[[Shop]]>> | for:: <<>>'
    const parts = collectionSyntax(line, DECL)
    const blank = parts.find((p) => p.kind === 'blank')!
    // From the end of `merchant`'s slot to the end of `for`'s: ` | for:: <<>>`.
    expect(line.slice(blank.from, blank.to)).toBe(' | for:: <<>>')
    // And the label and brackets inside it are not listed twice.
    expect(parts.filter((p) => p.from >= blank.from && p.to <= blank.to)).toEqual([blank])
  })

  it('leaves a filled field to its label and brackets alone', () => {
    const line = '--expense amount::<<99>> at merchant:: <<[[Shop]]>> | for:: <<lunch>>'
    expect(kinds(line, DECL).filter((k) => k.startsWith('blank'))).toEqual([])
  })

  /** The first field's lead-in reaches back to the keyword. */
  it('takes the words between the keyword and an empty first field', () => {
    const line = '--expense amount::<<>> at merchant:: <<[[Shop]]>> | for:: <<x>>'
    const blank = collectionSyntax(line, DECL).find((p) => p.kind === 'blank')!
    expect(line.slice(blank.from, blank.to)).toBe(' amount::<<>>')
  })

  it('emits no blanks without a declaration', () => {
    const line = '--expense amount::<<>> at merchant:: <<>>'
    expect(kinds(line).some((k) => k.startsWith('blank'))).toBe(false)
  })
})

describe('declarationSnippet', () => {
  it('puts the field between the brackets, and leaves them in the line', () => {
    expect(declarationSnippet('--expense <<amount>> at <<merchant>>')).toBe(
      '--expense <<${1:amount}>> at <<${2:merchant}>>'
    )
    expect(declarationSnippet('--note plain')).toBe('--note plain')
    // **You type into a slot, not over it.** An empty one is an empty field with
    // the caret between the brackets, which the line keeps.
    expect(declarationSnippet('--expense amount::<<>>')).toBe('--expense amount::<<${1:}>>')
  })

  /**
   * **Two slots must not be one field.** CodeMirror links snippet fields that share
   * a name, so a declaration of bare `<<>>` slots named after their text would be
   * one field repeated — type in the first and every slot in the line fills with it.
   * Numbered, they are as distinct as their order.
   */
  it('gives each slot a field of its own', () => {
    const snippet = declarationSnippet('--expense currency::<<>> amount::<<>>')
    expect(snippet).toBe('--expense currency::<<${1:}>> amount::<<${2:}>>')
    expect(new Set(snippet.match(/\$\{[^}]*\}/g)).size).toBe(2)
  })

  /** `${` is the snippet syntax, so a brace someone wrote has to survive as one. */
  it('escapes a brace in the declaration', () => {
    expect(declarationSnippet('--expense {cash} <<amount>>')).toBe(
      '--expense \\{cash\\} <<${1:amount}>>'
    )
  })

  /** A single bracket is markdown's own autolink, not a slot. */
  it('leaves a single bracket and an unclosed one alone', () => {
    expect(declarationSnippet('--expense <amount>')).toBe('--expense <amount>')
    expect(declarationSnippet('--expense <<amount at [[x]]')).toBe('--expense <<amount at [[x]]')
  })
})

/**
 * **The structures live in one JSON file**, `.config/actions/collections.json`,
 * keyed by name — so anything walking the vault reads every structure in one open
 * rather than globbing a folder and parsing markdown for a fact that is data.
 *
 * `structure` is the authority; `fields` is written beside it for that reader and
 * re-derived here on every read, so a hand-edited structure can never be
 * contradicted by a stale list next to it.
 */
describe('collections.json', () => {
  const FILE = JSON.stringify(
    {
      expense: {
        structure: '--expense amount::<<>> at merchant:: [[<<>>]]',
        fields: ['amount', 'merchant'],
      },
      quotes: { structure: '', fields: [] },
    },
    null,
    2
  )

  it('reads a structure for each collection, and an empty one as declared', () => {
    expect(readCollections(FILE)).toEqual({
      expense: '--expense amount::<<>> at merchant:: [[<<>>]]',
      quotes: '',
    })
  })

  /** Null and not `{}`: a file the app cannot read is one it must not overwrite,
   *  and the caller tells the two apart. */
  it('answers null for anything that is not an object of entries', () => {
    expect(readCollections('{ "expense": ')).toBeNull()
    expect(readCollections('[]')).toBeNull()
    expect(readCollections('"a string"')).toBeNull()
  })

  /** A half-typed entry is not a reason to throw the rest away. */
  it('skips an entry it does not understand and keeps the others', () => {
    expect(readCollections('{"a": {"structure": "--a"}, "b": 7, "c": {"note": "x"}}')).toEqual({
      a: '--a',
    })
  })

  it('writes a structure, and the fields it names, sorted by collection', () => {
    const written = withCollection(FILE, 'habit', '--habit did::<<>> for <<minutes>> minutes')!
    expect(JSON.parse(written)).toEqual({
      expense: {
        structure: '--expense amount::<<>> at merchant:: [[<<>>]]',
        fields: ['amount', 'merchant'],
      },
      habit: {
        structure: '--habit did::<<>> for <<minutes>> minutes',
        fields: ['did', 'minutes'],
      },
      quotes: { structure: '', fields: [] },
    })
    // Sorted, because a diff that reorders itself on every write is one nobody
    // reads — and a vault is synced.
    expect(Object.keys(JSON.parse(written))).toEqual(['expense', 'habit', 'quotes'])
    expect(written.endsWith('\n')).toBe(true)
  })

  it('replaces one structure and leaves every other entry alone', () => {
    const written = withCollection(FILE, 'expense', '--expense amount::<<>>')!
    expect(JSON.parse(written).expense).toEqual({
      structure: '--expense amount::<<>>',
      fields: ['amount'],
    })
    expect(JSON.parse(written).quotes).toEqual({ structure: '', fields: [] })
  })

  /** What an entry carries beyond the structure is someone else's, and survives. */
  it('carries through a key it does not know', () => {
    const written = withCollection('{"expense": {"structure": "--expense", "note": "mine"}}', 'expense', '--expense amount::<<>>')!
    expect(JSON.parse(written).expense.note).toBe('mine')
  })

  it('starts a file that is not there yet', () => {
    expect(JSON.parse(withCollection('', 'quotes', '')!)).toEqual({
      quotes: { structure: '', fields: [] },
    })
  })

  /** A file it cannot parse is a file it will not overwrite: someone may be
   *  editing it by hand, and a stray comma is not a reason to lose their work. */
  it('refuses to write over a file it cannot read', () => {
    expect(withCollection('{ "expense": ', 'expense', '--expense')).toBeNull()
    expect(withCollection('[1, 2]', 'expense', '--expense')).toBeNull()
  })
})

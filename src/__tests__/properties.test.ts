import { describe, expect, it } from 'vitest'
import { blockProperties, noteProperties, readProperty, splitPageProperties, typeOf as typeIn, withProperty } from '../properties'

const untyped = () => 'text' as const
const propertyKeys = (raw: string) => noteProperties(raw, untyped).map((one) => one.name)

/**
 * One page property as plain text, in a YAML block or in the `key::
 * value` lines a note opens with. The module must not reformat: it
 * changes one line, and every other line, the order, the spacing and
 * the line endings come back unchanged. Most of these check that.
 */
describe('readProperty', () => {
  it('reads a value, with or without quotes', () => {
    expect(readProperty('---\nicon: 📚\n---\nbody\n', 'icon')).toBe('📚')
    expect(readProperty('---\nicon: "📚"\n---\nbody\n', 'icon')).toBe('📚')
    expect(readProperty("---\nicon: '📚'\n---\nbody\n", 'icon')).toBe('📚')
  })

  it('answers null for a note with no block, and for a missing key', () => {
    expect(readProperty('# Just a note\n', 'icon')).toBeNull()
    expect(readProperty('---\nstatus: draft\n---\nbody\n', 'icon')).toBeNull()
  })

  it('answers null for a key with nothing after the colon', () => {
    expect(readProperty('---\nicon:\n---\nbody\n', 'icon')).toBeNull()
  })

  it('ignores an indented key, which belongs to something else', () => {
    expect(readProperty('---\nmeta:\n  icon: 📚\n---\nbody\n', 'icon')).toBeNull()
  })

  it('does not read a block that is not at the very start', () => {
    expect(readProperty('text\n---\nicon: 📚\n---\n', 'icon')).toBeNull()
  })

  /** A name in any case, as everywhere else: a hand-typed `Icon::` was a second icon line. */
  it('reads and writes a name in any case', () => {
    expect(readProperty('Icon:: book\n', 'icon')).toBe('book')
    expect(withProperty('Icon:: book\n\nbody\n', 'icon', 'star')).toBe('icon:: star\n\nbody\n')
  })
})

describe('withProperty', () => {
  it('replaces the one line and leaves the rest of the block alone', () => {
    const before = '---\nstatus: draft\nicon: 📗\ntags: [a, b]\n---\n# Reading\n'
    expect(withProperty(before, 'icon', '📚')).toBe(
      '---\nstatus: draft\nicon: 📚\ntags: [a, b]\n---\n# Reading\n'
    )
  })

  it('appends to a block that has no such key, keeping the order it had', () => {
    expect(withProperty('---\nstatus: draft\n---\nbody\n', 'icon', '📚')).toBe(
      '---\nstatus: draft\nicon: 📚\n---\nbody\n'
    )
  })

  // A note with no properties gets the `::` form. The blank line matters:
  // otherwise the note's first line would read as part of the block.
  it('starts a `::` block, with the blank line after it', () => {
    expect(withProperty('# Reading\n', 'icon', '📚')).toBe('icon:: 📚\n\n# Reading\n')
    expect(withProperty('', 'path', 'Kickoff')).toBe('path:: Kickoff\n\n')
  })

  it('removes the line, and the block with it when nothing is left', () => {
    expect(withProperty('---\nicon: 📚\n---\n\n# Reading\n', 'icon', null)).toBe('# Reading\n')
    expect(withProperty('icon:: 📚\n\n# Reading\n', 'icon', null)).toBe('# Reading\n')
    expect(withProperty('---\nstatus: draft\nicon: 📚\n---\nbody\n', 'icon', null)).toBe(
      '---\nstatus: draft\n---\nbody\n'
    )
  })

  it('changes nothing when asked to remove what is not there', () => {
    const untouched = '---\nstatus: draft\n---\nbody\n'
    expect(withProperty(untouched, 'icon', null)).toBe(untouched)
    expect(withProperty('# Reading\n', 'icon', null)).toBe('# Reading\n')
  })

  it('keeps CRLF endings, rather than quietly converting the file', () => {
    expect(withProperty('---\r\nstatus: draft\r\n---\r\nbody\r\n', 'icon', '📚')).toBe(
      '---\r\nstatus: draft\r\nicon: 📚\r\n---\r\nbody\r\n'
    )
  })

  it('round-trips: what it writes is what it reads', () => {
    const written = withProperty('# Reading\n', 'icon', '📚')
    expect(readProperty(written, 'icon')).toBe('📚')
    expect(readProperty(withProperty(written, 'icon', '🗓'), 'icon')).toBe('🗓')
    expect(readProperty(withProperty(written, 'icon', null), 'icon')).toBeNull()
  })
})

/** The block split from the body, by the same rule `readProperty` uses. */
describe('splitting page properties off the body', () => {
  it('holds a leading block in the prefix, verbatim', () => {
    const { prefix, body } = splitPageProperties('---\nstatus: draft\n---\n\n# Title\n')
    expect(prefix).toBe('---\nstatus: draft\n---\n')
    expect(body).toBe('\n# Title\n')
    expect(prefix + body).toBe('---\nstatus: draft\n---\n\n# Title\n')
  })

  it('leaves a note with none alone', () => {
    expect(splitPageProperties('# Title\n')).toEqual({ prefix: '', body: '# Title\n' })
  })

  // Only a block at the start counts. A `---` further down is a
  // horizontal rule, and taking it would eat everything above.
  it('ignores a block that does not start the file', () => {
    const raw = '# Title\n\n---\nnot: frontmatter\n---\n'
    expect(splitPageProperties(raw)).toEqual({ prefix: '', body: raw })
  })

  it('handles CRLF', () => {
    const { prefix } = splitPageProperties('---\r\nstatus: draft\r\n---\r\nbody')
    expect(prefix).toBe('---\r\nstatus: draft\r\n---\r\n')
  })
})

/**
 * Every property a note names. The Actions pane lists these, and
 * the note colours them, by one rule: `PROPERTY_KEY`.
 */
describe('the names of the properties a note carries', () => {
  it('answers with the names, in the order written', () => {
    expect(propertyKeys('---\nicon: compass\ndate: 2026-09-12\n---\nbody\n')).toEqual([
      'icon',
      'date',
    ])
  })

  it('answers with nothing for a note that has no block', () => {
    expect(propertyKeys('# Just a note\n')).toEqual([])
    expect(propertyKeys('text\n---\nicon: compass\n---\n')).toEqual([])
  })

  // As `readProperty` reads: an indented key belongs to the key above.
  it('skips an indented key', () => {
    expect(propertyKeys('---\nmeta:\n  nested: yes\n---\n')).toEqual(['meta'])
  })

  it('keeps a name as it was typed, hyphens and all', () => {
    expect(propertyKeys('---\nDue-Date: soon\nowner: me\n---\n')).toEqual(['Due-Date', 'owner'])
  })

  it('is not fooled by a colon in a value', () => {
    expect(propertyKeys('---\nwhen: 09:05 sharp\n---\n')).toEqual(['when'])
  })
})

/**
 * The `::` form: the note opens with its `key:: value` lines and the
 * first other line ends them, so a blank line, heading or prose closes
 * the block, and a `key:: value` further down is not a page property.
 */
describe('page properties written as key:: value', () => {
  const note = 'icon:: book\npath:: Areas/Plans\n\n# Plans\n\nlater:: not one\n'

  it('reads them, and only at the top', () => {
    expect(readProperty(note, 'icon')).toBe('book')
    expect(readProperty(note, 'path')).toBe('Areas/Plans')
    expect(readProperty(note, 'later')).toBeNull()
    expect(readProperty('icon::\n# x\n', 'icon')).toBeNull()
    expect(readProperty('# Plans\nicon:: book\n', 'icon')).toBeNull()
  })

  // `later:: not one` is not a page property, but it is a block property.
  it('names them, and splits them off the body', () => {
    expect(propertyKeys(note)).toEqual(['icon', 'path', 'later'])
    expect(splitPageProperties(note)).toEqual({
      prefix: 'icon:: book\npath:: Areas/Plans\n',
      body: '\n# Plans\n\nlater:: not one\n',
    })
  })

  it('writes in their form: one line replaced, one appended, nothing else touched', () => {
    expect(withProperty(note, 'icon', 'star')).toBe(note.replace('icon:: book', 'icon:: star'))
    expect(withProperty(note, 'type', 'project')).toBe(
      'icon:: book\npath:: Areas/Plans\ntype:: project\n\n# Plans\n\nlater:: not one\n'
    )
    expect(withProperty(note, 'path', null)).toBe('icon:: book\n\n# Plans\n\nlater:: not one\n')
  })

  it('keeps CRLF, and a note that is only its block without a last line ending', () => {
    expect(withProperty('icon:: book\r\n\r\nbody\r\n', 'path', 'x')).toBe('icon:: book\r\npath:: x\r\n\r\nbody\r\n')
    expect(withProperty('icon:: book', 'icon', 'star')).toBe('icon:: star')
  })

  // A YAML block is written as YAML: a skill's must stay the YAML Claude
  // Code reads, and nothing converts a note's form behind its owner's back.
  it('leaves a YAML block YAML', () => {
    expect(withProperty('---\nname: summarise\n---\n', 'icon', 'zap')).toBe('---\nname: summarise\nicon: zap\n---\n')
  })
})

/**
 * A block property is `key:: value` on a line, and its value is exactly its type: a
 * number, a date, one link, or text (one word, or a quoted run), so the words around
 * it are the owner's. A value not of its type is not read, and says so (`valid`).
 */
describe('block properties', () => {
  const types = { currency: 'backlink', amount: 'number', account: 'backlink', merchant: 'backlink', due: 'date', site: 'url', mood: 'icon', home: 'path' } as const
  const typeOf = (name: string) => types[name as keyof typeof types] ?? 'text'
  const read = (line: string) => blockProperties(line, typeOf).map((one) => [one.name, one.value, one.valid])

  it('reads a whole entry, each value ending where its type does', () => {
    const line =
      '08:40 #expense spent currency:: [[EUR]] amount:: 1240 using account::[[Northwind Card]] at merchant:: [[Harbour Bistro]] for description:: "two [[Lakeside Pies]] and a [[Ginger Beer]]"'
    expect(read(line)).toEqual([
      ['currency', '[[EUR]]', true],
      ['amount', '1240', true],
      ['account', '[[Northwind Card]]', true],
      ['merchant', '[[Harbour Bistro]]', true],
      ['description', 'two [[Lakeside Pies]] and a [[Ginger Beer]]', true],
    ])
    // The words between are the line's own, not part of a value.
    const found = blockProperties(line, typeOf)
    const gaps = found.slice(1).map((one, at) => line.slice(found[at].to, one.from).trim())
    expect(gaps).toEqual(['', 'using', 'at', 'for'])
  })

  /** The vault marks an estimate with `~`; as a number it was not read, and no total had it. */
  it('reads a number marked as an estimate', () => {
    expect(read('08:40 #food oats amount:: ~400 by eye')).toEqual([['amount', '~400', true]])
    // The mark alone is no number.
    expect(read('amount:: ~')).toEqual([['amount', '', false]])
  })

  it('reads text as one word, or as the run between quotes, the curly ones too', () => {
    expect(read('category:: food at lunch')).toEqual([['category', 'food', true]])
    expect(read('note:: “smart quotes from macOS” then prose')).toEqual([['note', 'smart quotes from macOS', true]])
    // A label inside quotes is part of the value.
    expect(read('note:: "see a:: b" and x:: y')).toEqual([
      ['note', 'see a:: b', true],
      ['x', 'y', true],
    ])
    // The quotes are outside the value's own span, so the editor can hide them.
    const quoted = blockProperties('note:: "a b" c', typeOf)[0]
    expect(['note:: "a b" c'.slice(quoted.valueFrom, quoted.valueTo), quoted.to]).toEqual(['a b', 12])
  })

  it('refuses what is not of the type, and leaves an unclosed quote unread', () => {
    expect(read('amount:: about 1200')).toEqual([['amount', '', false]])
    expect(read('amount:: 12.5x')).toEqual([['amount', '', false]])
    expect(read('amount:: 12.50.')).toEqual([['amount', '12.50', true]])
    expect(read('due:: 2026-09-27, then')).toEqual([['due', '2026-09-27', true]])
    expect(read('merchant:: Harbour')).toEqual([['merchant', '', false]])
    expect(read('note:: "never closed')).toEqual([['note', '', false]])
  })

  it('reads a url, an icon and a path, each exactly', () => {
    expect(read('site:: https://example.org/menu. Then prose')).toEqual([['site', 'https://example.org/menu', true]])
    expect(read('site:: example.org')).toEqual([['site', '', false]])
    expect(read('mood:: sun today')).toEqual([['mood', 'sun', true]])
    expect(read('mood:: ☀️ today')).toEqual([['mood', '☀️', true]])
    expect(read('mood:: Sunny!')).toEqual([['mood', '', false]])
    expect(read('home:: Areas/Plans then')).toEqual([['home', 'Areas/Plans', true]])
    expect(read('home:: "Areas/Harbour View" then')).toEqual([['home', 'Areas/Harbour View', true]])
  })

  // `icon` and `path` are the app's own, and no vault entry retypes them.
  it('types the app’s own properties as the app does', () => {
    const entries = { icon: { type: 'number' }, owner: { type: 'backlink' } }
    expect([typeIn(entries, 'icon'), typeIn(entries, 'Path'), typeIn(entries, 'OWNER'), typeIn(entries, 'other')]).toEqual([
      'icon',
      'path',
      'backlink',
      'text',
    ])
  })

  it('takes a label only at the start or after a space, and nothing after one as empty', () => {
    expect(read('at:: 09:05 https://x.example/a::b ok')).toEqual([['at', '09:05', true]])
    expect(read('due::')).toEqual([['due', '', true]])
    expect(read('due:: amount:: 3')).toEqual([
      ['due', '', true],
      ['amount', '3', true],
    ])
    expect(read('Note: this is prose')).toEqual([])
  })

  it('are read after the page ones, with code and invalid values left out', () => {
    const raw = [
      'icon:: book',
      '',
      '08:10 #expense amount:: 480 amount:: lots',
      'in `x:: 1` code',
      '```',
      'y:: 2',
      '```',
      '',
    ].join('\n')
    expect(noteProperties(raw, typeOf)).toEqual([
      { name: 'icon', value: 'book' },
      { name: 'amount', value: '480' },
    ])
  })

  /** A note that is only its page block, with no line ending after it, was read twice. */
  it('reads a page block once when nothing follows it', () => {
    expect(noteProperties('icon:: book', typeOf)).toEqual([{ name: 'icon', value: 'book' }])
  })
})

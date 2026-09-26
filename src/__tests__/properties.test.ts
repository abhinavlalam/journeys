import { describe, expect, it } from 'vitest'
import { propertyKeys, readProperty, splitPageProperties, withProperty } from '../properties'

/**
 * One page property, as plain text — in a YAML block, or in the `key:: value`
 * lines a note opens with.
 *
 * The whole point of this module is that it *does not reformat*. The app came to
 * change one line; every other line, the key order, the spacing and the line
 * endings are the user's and have to come back unchanged. Most of what follows is
 * that invariant from a different angle.
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

  // A note with no properties is given the one form every property takes, page or
  // block. The blank line is not cosmetic: the note's first line would otherwise
  // read as the block's next one.
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

/**
 * The block held aside from the body, off the same rule `readProperty` uses.
 *
 * The editor shows frontmatter now — the document is the file's own text — so this
 * is no longer about putting a prefix back on save. `parseNoteLinks` is the caller:
 * a `path:` full of slashes is a property, not a set of links.
 */
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

  // Only a *leading* block is frontmatter. A `---` in the middle of a note is a
  // horizontal rule, and taking it would eat everything above it.
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
 * Every property a note names.
 *
 * The Actions pane lists these, so what counts as a property here and what gets
 * the accent in the note are one rule — `PROPERTY_KEY`, exported from the same
 * module and used by both.
 */
describe('propertyKeys', () => {
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

  // The same rule `readProperty` reads by: an indented key belongs to the key
  // above it, and this app does not know what that means.
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
 * **The `::` form**, which is what every property is in this app, page or block.
 * The note opens with its `key:: value` lines and the first line that is not one
 * ends them — so a blank line, a heading or prose closes the block, and a
 * `key:: value` further down the note is not a page property.
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

  it('names them, and splits them off the body', () => {
    expect(propertyKeys(note)).toEqual(['icon', 'path'])
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

  // A YAML block is written as YAML: a skill's must stay the frontmatter Claude
  // Code reads, and nothing converts a note's form behind its owner's back.
  it('leaves a YAML block YAML', () => {
    expect(withProperty('---\nname: summarise\n---\n', 'icon', 'zap')).toBe('---\nname: summarise\nicon: zap\n---\n')
  })
})

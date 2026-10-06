import { describe, expect, it } from 'vitest'
import { collectTagLines, lineWords, tagAt, tagLine, tagNames } from '../tags'

/**
 * `#word` in a note's prose. Most of this file is what is not a tag (a heading,
 * an anchor, a colour, a shebang), since a real vault holds all of those.
 */
describe('tagNames', () => {
  it('reads a tag, and nests one on a slash', () => {
    expect(tagNames('booked it #travel today')).toEqual(['travel'])
    expect(tagNames('#todo/urgent and #todo/later')).toEqual(['todo/urgent', 'todo/later'])
    expect(tagNames('#inbox-triage and #read_later')).toEqual(['inbox-triage', 'read_later'])
  })

  /** As in CommonMark: a heading needs the space, so `#Plans` is free to be a tag. */
  it('is not a heading', () => {
    expect(tagNames('# Plans')).toEqual([])
    expect(tagNames('## Section')).toEqual([])
    expect(tagNames('###### Deep')).toEqual([])
    // No space, so not a heading, and so a tag, folded like the rest.
    expect(tagNames('#Plans')).toEqual(['plans'])
  })

  /** A `#` in the middle of a word is someone's text. */
  it('is not an anchor or part of a word', () => {
    expect(tagNames('see https://example.invalid/page#section')).toEqual([])
    expect(tagNames('see [[Areas/Plans#Roadmap]]')).toEqual([])
    expect(tagNames('issue abc#42 was closed')).toEqual([])
  })

  /** A tag has a letter. A number after a hash is just a number. */
  it('is not a bare number', () => {
    expect(tagNames('#2026 was the year')).toEqual([])
    expect(tagNames('#1')).toEqual([])
    // A letter anywhere in it is enough.
    expect(tagNames('#q1-2026')).toEqual(['q1-2026'])
  })

  /**
   * Read off `proseLines`, so code is skipped: `#!/bin/sh` and `#include` in fences,
   * `#ef476f` in a code span. The colour has letters, so only the mask keeps it out.
   */
  it('does not read code', () => {
    expect(tagNames('```sh\n#!/bin/sh\n#include <x>\n```')).toEqual([])
    expect(tagNames('the accent is `#ef476f` here')).toEqual([])
    // Outside the fence it is read again.
    expect(tagNames('```\n#nope\n```\n\nand #yes')).toEqual(['yes'])
  })

  it('reads every tag on a line, in the order written', () => {
    expect(tagNames('#one then #two then #three')).toEqual(['one', 'two', 'three'])
  })

  /**
   * Folded to lower case, the one name the app folds. `#Travel` and `#travel`
   * are one label; case carries nothing. The note's text is untouched.
   */
  it('folds a tag to one spelling', () => {
    expect(tagNames('#Travel and #TRAVEL and #travel')).toEqual(['travel', 'travel', 'travel'])
    expect(tagNames('#Todo/Urgent')).toEqual(['todo/urgent'])
  })
})

describe('collectTagLines', () => {
  /**
   * `gatherLines`' rule: the run nested under an entry comes
   * with it, and a blank line does not break it.
   */
  it('gathers the line and the run nested under it', () => {
    const note = ['# Monday', '', '- #travel to Harbour City', '  - terminal 1', '', '  - gate 14', '- #food later', ''].join('\n')
    const found = collectTagLines(note, 'travel')
    expect(found).toHaveLength(1)
    expect(found[0].text).toBe('- #travel to Harbour City')
    expect(found[0].below).toEqual(['  - terminal 1', '', '  - gate 14'])
  })

  it('gathers a tag whatever case the line wrote it in', () => {
    const note = '#Travel one\n#travel two\n#food three\n'
    expect(collectTagLines(note, 'TRAVEL').map((one) => one.text)).toEqual([
      '#Travel one',
      '#travel two',
    ])
  })

  it('gathers nothing for a tag no line carries', () => {
    expect(collectTagLines('# Monday\n\nnothing here\n', 'travel')).toEqual([])
  })

  it('stops the run at the entry’s own level, and keeps the nesting relative to it', () => {
    const note = ['09:42 #expense lunch', '  - taxi 240', '    - tipped', '10:00 standup'].join('\n')
    expect(collectTagLines(note, 'expense')[0].below).toEqual(['  - taxi 240', '    - tipped'])
    // The entry's own indent comes off and nothing else.
    const nested = ['  - 09:42 #expense at the airport', '    - taxi 240', '      - tipped'].join('\n')
    expect(collectTagLines(nested, 'expense')[0].below).toEqual(['  - taxi 240', '    - tipped'])
  })

  it('drops the blank lines on the end of a run, and an entry may have none', () => {
    const note = ['#watching a series', '  - s01', '', '', 'Something else', '#watching and this'].join('\n')
    expect(collectTagLines(note, 'watching')).toEqual([
      { text: '#watching a series', below: ['  - s01'], at: 0 },
      { text: '#watching and this', below: [], at: 5 },
    ])
  })

  /** A fence under an entry is its content; an entry inside a fence is not an entry. */
  it('finds no entry inside code, and keeps a fence that is under one', () => {
    expect(collectTagLines(['```sh', 'echo #build', '```'].join('\n'), 'build')).toEqual([])
    expect(collectTagLines('Ran `#build` by hand', 'build')).toEqual([])
    const under = ['#note how it runs', '  ```sh', '  npm ci', '  ```', 'done'].join('\n')
    expect(collectTagLines(under, 'note')[0].below).toEqual(['  ```sh', '  npm ci', '  ```'])
  })

  it('makes one entry of a line that says its tag twice', () => {
    expect(collectTagLines('09:00 #expense twice #expense again', 'expense')).toHaveLength(1)
  })
})

describe('tagAt', () => {
  /** What a press reads. The offset may be anywhere in the tag, the `#` included. */
  it('answers the tag under an offset, and null elsewhere', () => {
    const line = 'booked it #travel today'
    const at = line.indexOf('#travel')
    expect(tagAt(line, at)).toBe('travel')
    expect(tagAt(line, at + 3)).toBe('travel')
    expect(tagAt(line, at + '#travel'.length)).toBe('travel')
    expect(tagAt(line, 0)).toBeNull()
    expect(tagAt(line, line.length - 1)).toBeNull()
  })

  it('picks the right one of several on a line', () => {
    const line = '#one and #two'
    expect(tagAt(line, line.indexOf('#two') + 1)).toBe('two')
    expect(tagAt(line, line.indexOf('#one') + 1)).toBe('one')
  })

  /** Folded, so pressing `#Travel` opens the same page as the `travel` row. */
  it('folds what a press reads', () => {
    expect(tagAt('went #Travel today', 6)).toBe('travel')
  })
})

/** The phone's tag form writes the line the laptop would, and reads back as written. */
describe('a tag’s line from a form', () => {
  const types: Record<string, 'number' | 'backlink' | 'text' | 'date'> = { amount: 'number', merchant: 'backlink', note: 'text', on: 'date' }
  const typeOf = (name: string) => types[name] ?? 'text'
  const line = (fields: Record<string, string>, clock = '', what = '') =>
    tagLine('expense', ['amount', 'merchant', 'note', 'on'], { clock, what, fields }, typeOf)

  it('puts the clock, the tag and the words first, then each value in the structure’s order', () => {
    expect(line({ merchant: 'Harbour Bistro', amount: '24.50' }, '12:30', 'lunch')).toBe(
      '12:30 #expense lunch amount:: 24.50 merchant:: [[Harbour Bistro]]'
    )
  })

  it('writes each value as its type reads it, and leaves out what is empty', () => {
    expect(line({ merchant: '[[Harbour Bistro]]', note: 'by the water', on: '2026-10-04', amount: ' ' })).toBe(
      '#expense merchant:: [[Harbour Bistro]] note:: "by the water" on:: 2026-10-04'
    )
  })
})

/** What a tag's table shows as a line's own words: the calendar's reading of an event's title. */
describe('a line’s own words', () => {
  const typeOf = (name: string) => (name === 'dose' || name === 'amount' ? ('number' as const) : ('text' as const))

  it('leaves out the clock, the tags, the values and a leading list mark', () => {
    expect(lineWords('08:45 #supplement [[Supplements/Fish Oil]] dose:: 2', typeOf)).toBe('[[Supplements/Fish Oil]]')
    expect(lineWords('09:15 - #youtube [[Tide tables]] link:: https://example.com/tides', typeOf)).toBe('[[Tide tables]]')
    expect(lineWords('- #task Book the retest: vitamin D due:: 2026-12-20', typeOf)).toBe('Book the retest: vitamin D')
    expect(lineWords('- [ ] #task call the harbour', typeOf)).toBe('call the harbour')
    expect(lineWords('#quote Without a goal, you can’t score. by:: [[Mira Vance]]', typeOf)).toBe('Without a goal, you can’t score.')
  })

  it('keeps words written after a value, and is empty on a line that is all values', () => {
    expect(lineWords('08:40 #expense lunch amount:: 480 at the water', typeOf)).toBe('lunch at the water')
    expect(lineWords('09:00 #expense amount:: 5', typeOf)).toBe('')
  })
})

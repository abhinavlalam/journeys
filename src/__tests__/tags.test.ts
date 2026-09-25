import { describe, expect, it } from 'vitest'
import { collectTagLines, tagAt, tagNames } from '../tags'

/**
 * `#word` in a note's prose. **The guards are most of the definition**, so most of
 * this file is about what is *not* a tag — a heading, an anchor, a colour, a shell
 * shebang — because every one of those is a thing a real vault holds.
 */
describe('tagNames', () => {
  it('reads a tag, and nests one on a slash', () => {
    expect(tagNames('booked it #travel today')).toEqual(['travel'])
    expect(tagNames('#todo/urgent and #todo/later')).toEqual(['todo/urgent', 'todo/later'])
    expect(tagNames('#inbox-triage and #read_later')).toEqual(['inbox-triage', 'read_later'])
  })

  /** The line CommonMark draws too: a heading *requires* the space, so `#Plans`
   *  was never one and is free to be a tag. */
  it('is not a heading', () => {
    expect(tagNames('# Plans')).toEqual([])
    expect(tagNames('## Section')).toEqual([])
    expect(tagNames('###### Deep')).toEqual([])
    // No space, so not a heading — and therefore a tag, folded like every other.
    expect(tagNames('#Plans')).toEqual(['plans'])
  })

  /** A `#` in the middle of a word is somebody's text, which is the guard
   *  `OPENER` uses for `--` and for the same reason. */
  it('is not an anchor or part of a word', () => {
    expect(tagNames('see https://example.invalid/page#section')).toEqual([])
    expect(tagNames('see [[Areas/Plans#Roadmap]]')).toEqual([])
    expect(tagNames('issue abc#42 was closed')).toEqual([])
  })

  /** A tag carries a letter. A number after a hash is a number somebody wrote. */
  it('is not a bare number', () => {
    expect(tagNames('#2026 was the year')).toEqual([])
    expect(tagNames('#1')).toEqual([])
    // A letter anywhere in it is enough.
    expect(tagNames('#q1-2026')).toEqual(['q1-2026'])
  })

  /**
   * Off `proseLines`, so code is not scanned — a vault holds `#!/bin/sh` and
   * `#include` in fenced blocks and `#ef476f` in a backtick span. The colour is the
   * interesting one: it carries letters, so only the mask keeps it out.
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
   * **Lowercased, and it is the one name in the app that is folded rather than
   * kept as first written.** A property keeps its spelling, because `Status` is a
   * word someone chose for a block. A tag is a *label*, and `#Travel` beside
   * `#travel` is one label that looks like two — the case is never information.
   * The note's own bytes are untouched; this is only the name the app shows.
   */
  it('folds a tag to one spelling', () => {
    expect(tagNames('#Travel and #TRAVEL and #travel')).toEqual(['travel', 'travel', 'travel'])
    expect(tagNames('#Todo/Urgent')).toEqual(['todo/urgent'])
  })
})

describe('collectTagLines', () => {
  /** `collectLines`' own rule, through the `gatherLines` both of them read: the run
   *  nested under an entry comes with it, and a blank line does not break it. */
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
})

describe('tagAt', () => {
  /** What a press reads. The offset may land anywhere in the tag, the `#`
   *  included, because the whole run is what was marked and pressed. */
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

  /** Folded, so pressing `#Travel` opens the page the pane's `travel` row opens
   *  rather than a second page for the same tag. */
  it('folds what a press reads', () => {
    expect(tagAt('went #Travel today', 6)).toBe('travel')
  })
})

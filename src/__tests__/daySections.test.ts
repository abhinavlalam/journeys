import { describe, expect, it } from 'vitest'
import { daySkeleton, sectioned, sectionOf, spansOf, withInSection, type DaySection } from '../daySections'

/** A daily note in sections: the same headings in every day, each line where its kind says. */

const SECTIONS: DaySection[] = [
  { name: 'Log', tags: [] },
  { name: 'Notes', tags: ['task', 'goal'] },
  { name: 'Trackers', tags: ['expense', 'food'] },
]
const NAMES = SECTIONS.map((one) => one.name)
const day = ['icon:: pen', '', '## Log', '09:30 standup', '', '## notes', '', '## Trackers', '12:55 #expense lunch amount:: 31.80', ''].join('\n')

describe('a day’s sections', () => {
  it('are its `## name` lines at the margin, in any case, each to the line before the next', () => {
    expect(spansOf(day, NAMES)).toEqual([
      { index: 0, heading: 2, end: 4 },
      { index: 1, heading: 5, end: 6 },
      { index: 2, heading: 7, end: 9 },
    ])
    // Not indented, not in code, and not another heading.
    expect(spansOf('  ## Log\n```\n## Log\n```\n## Plans\n', NAMES)).toEqual([])
  })

  it('take a line by its tags, else by its clock, else the second', () => {
    expect(sectionOf('#task send the invoice', SECTIONS)).toBe(1)
    expect(sectionOf('13:00 #food soup calories:: 250', SECTIONS)).toBe(2)
    expect(sectionOf('11:00 #event design review', SECTIONS)).toBe(0)
    expect(sectionOf('an idea for the graph', SECTIONS)).toBe(1)
    // A group of timed lines goes where they would.
    expect(sectionOf('#trip', SECTIONS, ['  08:00 the ferry'])).toBe(0)
  })

  it('begin a new day with their headings', () => {
    expect(daySkeleton(SECTIONS)).toBe('## Log\n\n## Notes\n\n## Trackers\n')
  })
})

describe('a line filed in a section', () => {
  it('goes after the section’s last line, or under its heading when it has none', () => {
    expect(withInSection(day, SECTIONS, 0, ['10:15 review', '  went well'])).toBe(day.replace('09:30 standup\n', '09:30 standup\n10:15 review\n  went well\n'))
    expect(withInSection(day, SECTIONS, 1, ['#task the invoice'])).toBe(day.replace('## notes\n', '## notes\n#task the invoice\n'))
    expect(withInSection(day, SECTIONS, 2, ['13:00 #food soup'])).toBe(`${day.trimEnd()}\n13:00 #food soup\n`)
  })

  it('makes a section the note lacks, before the next one it has, or at its end', () => {
    expect(withInSection('## Trackers\n', SECTIONS, 1, ['an idea'])).toBe('## Notes\nan idea\n\n## Trackers\n')
    expect(withInSection('09:00 written before the sections', SECTIONS, 0, ['10:00 now'])).toBe('09:00 written before the sections\n\n## Log\n10:00 now\n')
  })
})

describe('a day written before its sections', () => {
  it('is put in them, in the order it was written, each line with what is under it', () => {
    const before = [
      'icon:: pen',
      '09:30 standup',
      '  about the export',
      '#task send the invoice',
      '',
      '12:55 #expense lunch amount:: 31.80',
      'an idea for the graph',
      '13:00 #food soup calories:: 250',
      '',
    ].join('\n')
    expect(sectioned(before, SECTIONS)).toBe(
      [
        'icon:: pen',
        '',
        '## Log',
        '09:30 standup',
        '  about the export',
        '',
        '## Notes',
        '#task send the invoice',
        'an idea for the graph',
        '',
        '## Trackers',
        '12:55 #expense lunch amount:: 31.80',
        '13:00 #food soup calories:: 250',
        '',
      ].join('\n')
    )
    // One in its sections already is left as it is; an empty one gets them.
    expect(sectioned(day, SECTIONS)).toBe(day)
    expect(sectioned('', SECTIONS)).toBe(daySkeleton(SECTIONS))
  })
})

import { describe, expect, it } from 'vitest'
import { clockText, dayEntries, fieldsOf, lengthOf, timelineDays, totalsOf, withEntry, withNewEntry, wordsOf } from '../timeline'
import type { PropertyType } from '../properties'

/**
 * **A day as it happened.** A daily note is written by kind — a line of tags alone
 * heads a group, and the group's entries are nested under it — and the timeline
 * reads it by clock, every group's entries in the order they happened.
 */
const note = (path: string) => ({ path, absolutePath: `/v/${path}`, name: path.split('/').pop()!.replace(/\.md$/, '') })
const day = note('Daily/2026-09-21.md')
const text = () => 'text' as const
const summary = (raw: string) => dayEntries(day, raw).map((one) => [one.clock, one.group, one.text])

describe('a day’s entries', () => {
  const raw = [
    'mood:: calm',
    '',
    '#timeline',
    '     20:10 #flight from:: [[Harbour City]]',
    '     09:00 standup',
    '     Woke late.',
    '',
    '#expense',
    '     16:31 #expense amount:: 480',
    '          split with [[Mira Vance]]',
    '     08:30 #expense amount:: 60',
    '',
    '#diet',
    '     08:45 #food item:: oats',
    '',
  ].join('\n')

  it('reads every group’s entries by clock, the ones with no clock first', () => {
    expect(summary(raw)).toEqual([
      ['', 'timeline', 'Woke late.'],
      ['08:30', 'expense', '08:30 #expense amount:: 60'],
      ['08:45', 'diet', '08:45 #food item:: oats'],
      ['09:00', 'timeline', '09:00 standup'],
      ['16:31', 'expense', '16:31 #expense amount:: 480'],
      ['20:10', 'timeline', '20:10 #flight from:: [[Harbour City]]'],
    ])
  })

  it('keeps what is nested under an entry as its detail, and the line it came from', () => {
    const lunch = dayEntries(day, raw).find((one) => one.clock === '16:31')!
    expect(lunch.below).toEqual(['     split with [[Mira Vance]]'])
    expect(raw.split('\n')[lunch.at]).toBe('     16:31 #expense amount:: 480')
  })

  it('tells a moment from a block of time, and a block that runs past midnight', () => {
    const blocks = dayEntries(day, ['08:45 tea', '13:00 to 13:50 review', '14:00 - 15:30 walk', '23:00 to 01:00 flight'].join('\n'))
    expect(blocks.map((one) => [one.start, one.end])).toEqual([
      [8 * 60 + 45, null],
      [13 * 60, 13 * 60 + 50],
      [14 * 60, 15 * 60 + 30],
      [23 * 60, 25 * 60],
    ])
  })

  it('files an entry under the innermost of nested groups, and reads no code', () => {
    const nested = ['#diet', '     #supplement', '          08:00 omega', '     09:00 #food toast', '```', '10:00 not an entry', '```'].join('\n')
    expect(summary(nested)).toEqual([
      ['08:00', 'supplement', '08:00 omega'],
      ['09:00', 'diet', '09:00 #food toast'],
    ])
  })
})

describe('the days', () => {
  it('are the daily notes with anything in them, oldest first, and nothing else', () => {
    const days = timelineDays(
      [
        { note: note('Daily/2026-09-22.md'), text: '09:00 run\n' },
        { note: note('Daily/2026-09-20.md'), text: '08:00 tea\n' },
        { note: note('Daily/2026-09-21.md'), text: 'mood:: calm\n' },
        { note: note('Daily/Daily.md'), text: '09:00 not a day\n' },
        { note: note('Plans.md'), text: '09:00 not a day either\n' },
      ],
      'Daily'
    )
    expect(days.map((one) => one.day)).toEqual(['2026-09-20', '2026-09-22'])
  })
})

describe('a table tag’s entry', () => {
  const types: Record<string, PropertyType> = { amount: 'number', merchant: 'backlink' }
  const typeOf = (name: string) => types[name] ?? 'text'
  const tables = { expense: ['amount', 'merchant', 'for'] }

  it('shows the fields its structure names, in that order', () => {
    expect(fieldsOf('12:00 #expense merchant:: [[Harbour Bistro]] amount:: 480 mood:: calm', tables, typeOf)).toEqual([
      { name: 'amount', value: '480' },
      { name: 'merchant', value: '[[Harbour Bistro]]' },
    ])
    expect(fieldsOf('12:00 #food item:: oats', tables, text)).toEqual([])
  })

  it('totals the number fields over the day', () => {
    const entries = dayEntries(day, ['08:30 #expense amount:: 60', '12:00 #expense amount:: 480.5', '13:00 #food amount:: 9'].join('\n'))
    expect(totalsOf(entries, tables, typeOf)).toEqual([{ tag: 'expense', name: 'amount', total: 540.5 }])
  })
})

describe('how an entry reads', () => {
  const typeOf = (name: string): PropertyType => (name === 'amount' ? 'number' : 'text')
  const [entry] = dayEntries(day, '13:00 to 13:50 #expense lunch amount:: 480 with:: "Mira Vance"')

  it('says its words past the clock, its properties by value or, drawn as fields, not at all', () => {
    expect(wordsOf(entry, typeOf, false)).toBe('#expense lunch 480 Mira Vance')
    expect(wordsOf(entry, typeOf, true)).toBe('#expense lunch')
  })

  it('writes a clock the one way, and a block’s length in words', () => {
    expect([clockText(entry.start!), clockText(entry.end!), clockText(25 * 60)]).toEqual(['13:00', '13:50', '01:00'])
    expect([lengthOf(50), lengthOf(60), lengthOf(90)]).toEqual(['50 min', '1 h', '1 h 30 min'])
  })
})

/** **An edit writes its one line**: its indent and line ending kept, and every other
 *  byte of the note as it was. */
describe('writing an entry back', () => {
  const raw = ['mood:: calm', '#timeline', '     09:00 standup\r', '     13:00 review with [[Mira Vance]]', ''].join('\n')
  const [standup] = dayEntries(day, raw)

  it('rewrites the entry’s line where it stands, and nothing else', () => {
    expect(withEntry(raw, standup, '09:15 standup, late')).toBe(
      ['mood:: calm', '#timeline', '     09:15 standup, late\r', '     13:00 review with [[Mira Vance]]', ''].join('\n')
    )
  })

  it('keeps an edit to one line, whatever is pasted into it', () => {
    expect(withEntry(raw, standup, '09:15 standup\nand more')!.split('\n')[2]).toBe('     09:15 standup and more\r')
  })

  it('writes nothing when the line is no longer the entry’s', () => {
    expect(withEntry(raw.replace('standup', 'stand-up'), standup, '09:15 standup')).toBeNull()
  })
})

/** **A new entry is filed as the day is written**: under its tag's group, and every
 *  other byte of the note as it was. */
describe('filing a new entry', () => {
  const raw = ['#timeline', '     09:00 standup', '', '#expense', '     12:30 #expense lunch amount:: 480', '', '#diet', '     08:45 #food oats', ''].join('\n')
  const filed = (text: string, into = raw) => withNewEntry(day, into, text, '    ')

  it('goes under the group its tag heads, after the group’s last line, indented as its lines are', () => {
    expect(filed('19:00 #expense dinner')).toBe(raw.replace('amount:: 480\n', 'amount:: 480\n     19:00 #expense dinner\n'))
  })

  it('goes where its tag’s entries already are, as #food is under #diet', () => {
    expect(filed('13:00 #food rice')).toBe(raw.replace('#food oats\n', '#food oats\n     13:00 #food rice\n'))
  })

  it('goes under #timeline with no tag, or with none that has a group', () => {
    expect(filed('18:00 walk')).toBe(raw.replace('standup\n', 'standup\n     18:00 walk\n'))
    expect(filed('18:00 #travel cab')).toBe(raw.replace('standup\n', 'standup\n     18:00 #travel cab\n'))
  })

  it('makes #timeline at the end of a note with none, a blank line from what is above it', () => {
    expect(filed('09:00 run', 'mood:: calm\n')).toBe('mood:: calm\n\n#timeline\n    09:00 run\n')
    expect(filed('09:00 run', '')).toBe('#timeline\n    09:00 run\n')
  })

  it('indents a group with no lines yet one step in from its heading', () => {
    expect(filed('12:00 #expense tea', '#expense\n')).toBe('#expense\n    12:00 #expense tea\n')
  })
})

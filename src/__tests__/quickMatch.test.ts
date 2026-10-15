import { describe, expect, it } from 'vitest'
import { matchOf, ranked } from '../quickMatch'

/** Quick open's order: a name starting with what is typed first, then a word in it, then anywhere, then its letters in order. */

describe('quick open’s matching', () => {
  it('ranks a start, then a word’s start, then anywhere, then letters in order, and refuses the rest', () => {
    expect(['Roadmap', 'The road ahead', 'Crossroads', 'Ready made plans', 'Inbox'].map((name) => matchOf(name, 'road'))).toEqual([0, 1, 2, null, null])
    expect(matchOf('Roadmap', 'rdmp')).toBe(3)
    expect(matchOf('Roadmap', '  ')).toBe(0)
  })

  it('orders by how well, then the shorter name, and answers to a note’s other names', () => {
    const items = [
      { key: 'a', name: 'Lakeside Terminal' },
      { key: 'b', name: 'Harbour Bistro', also: ['The bistro'] },
      { key: 'c', name: 'Terminal' },
    ]
    expect(ranked(items, 'term', 5).map((one) => one.key)).toEqual(['c', 'a'])
    expect(ranked(items, 'the bis', 5).map((one) => one.key)).toEqual(['b'])
    expect(ranked(items, '', 2).map((one) => one.key)).toEqual(['c', 'b'])
  })
})

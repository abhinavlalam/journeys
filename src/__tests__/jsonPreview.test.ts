import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { jsonDecorations } from '../jsonPreview'

/**
 * The colour a JSON file gets, as marks over offsets.
 *
 * A scan and not a grammar, so the tests are the cases a scan gets wrong: a colon
 * inside a string, an escaped quote, a bracket in a string, and the depth of a
 * bracket in a span that does not start at the top of the file.
 */
/**
 * A caret parked where it is on **no** bracket.
 *
 * The default is offset 0, which in most of these documents is the opening `{` —
 * so without this every list below would also carry the pair highlight, and the
 * tests about tokens would be about two things.
 */
function clearOfBrackets(doc: string): number {
  for (let at = 0; at <= doc.length; at++) {
    const here = doc[at] ?? ''
    const before = doc[at - 1] ?? ''
    if (!'{}[]'.includes(here) && !'{}[]'.includes(before)) return at
  }
  return 0
}

const state = (doc: string, head = clearOfBrackets(doc)) =>
  EditorState.create({ doc, selection: { anchor: head } })

/** The marks at a given caret, as `class:text`. */
const at = (doc: string, head: number) =>
  spans(jsonDecorations(state(doc, head), 0, doc.length), doc)

function spans(set: DecorationSet, doc: string): string[] {
  const found: string[] = []
  const iter = set.iter()
  while (iter.value) {
    const cls = (iter.value.spec as { class?: string }).class ?? '?'
    found.push(`${cls.replace(/cm-json-/g, '')}:${JSON.stringify(doc.slice(iter.from, iter.to))}`)
    iter.next()
  }
  return found
}

const all = (doc: string) => spans(jsonDecorations(state(doc), 0, doc.length), doc)

/** The **raw text** of every mark carrying `cls`, for the cases where the point is
 *  what the token swallowed rather than which offsets it covered. */
function textOf(doc: string, cls: string): string[] {
  const found: string[] = []
  const iter = jsonDecorations(state(doc), 0, doc.length).iter()
  while (iter.value) {
    if ((iter.value.spec as { class?: string }).class === `cm-json-${cls}`) {
      found.push(doc.slice(iter.from, iter.to))
    }
    iter.next()
  }
  return found
}

describe('what each token is', () => {
  it('tells a property name from a string value', () => {
    expect(all('{ "icon": "compass" }')).toEqual([
      'bracket depth-0:"{"',
      'key:"\\"icon\\""',
      'string:"\\"compass\\""',
      'bracket depth-0:"}"',
    ])
  })

  it('marks numbers and the three keywords as literals', () => {
    expect(all('{ "a": 12.5, "b": true, "c": null, "d": false, "e": -3e4 }').filter((s) =>
      s.startsWith('number') || s.startsWith('atom')
    )).toEqual([
      'number:"12.5"',
      'atom:"true"',
      'atom:"null"',
      'atom:"false"',
      'number:"-3e4"',
    ])
  })

  /** The case a naive scan gets wrong: the colon is *inside* the value, so the
   *  value is not a name and the text after it is not a value. */
  it('leaves a colon inside a string alone', () => {
    expect(all('{ "when": "09:05 sharp" }')).toEqual([
      'bracket depth-0:"{"',
      'key:"\\"when\\""',
      'string:"\\"09:05 sharp\\""',
      'bracket depth-0:"}"',
    ])
  })

  it('does not let an escaped quote end a string', () => {
    // `String.raw`, so what is written here is what is in the file: one value,
    // quotes and all. Read as three tokens, the second `"` would end the string and
    // `no` would become bare words with a colour of their own.
    const doc = String.raw`{ "said": "he said \"no\"" }`
    expect(textOf(doc, 'string')).toEqual([String.raw`"he said \"no\""`])
    expect(textOf(doc, 'key')).toEqual(['"said"'])
  })

  it('does not read a bracket inside a string as structure', () => {
    const doc = '{ "shape": "{not a brace}" }'
    // The braces in the value neither take a colour nor move the depth: the pair
    // around the object is still depth 0, which it would not be if they counted.
    expect(all(doc).filter((one) => one.startsWith('bracket'))).toEqual([
      'bracket depth-0:"{"',
      'bracket depth-0:"}"',
    ])
    expect(textOf(doc, 'string')).toEqual(['"{not a brace}"'])
  })
})

describe('bracket depth', () => {
  it('colours a pair by how deep it is, and cycles at three', () => {
    const doc = '{"a":{"b":{"c":{"d":1}}}}'
    expect(all(doc).filter((s) => s.startsWith('bracket'))).toEqual([
      'bracket depth-0:"{"',
      'bracket depth-1:"{"',
      'bracket depth-2:"{"',
      'bracket depth-0:"{"',
      'bracket depth-0:"}"',
      'bracket depth-2:"}"',
      'bracket depth-1:"}"',
      'bracket depth-0:"}"',
    ])
  })

  it('gives an array the same treatment as an object', () => {
    expect(all('[[1]]').filter((s) => s.startsWith('bracket'))).toEqual([
      'bracket depth-0:"["',
      'bracket depth-1:"["',
      'bracket depth-1:"]"',
      'bracket depth-0:"]"',
    ])
  })

  /**
   * A span from the middle of the file still knows how deep it is: the scan starts
   * at the top of the document and only *marks* from `from`. Depth is not visible
   * in a slice, so a viewport-sized span would otherwise colour the same bracket
   * differently depending on where the window happened to be.
   */
  it('is right in a span that does not start at the top', () => {
    const doc = '{\n  "a": {\n    "b": 1\n  }\n}\n'
    const from = doc.indexOf('"b"')
    expect(spans(jsonDecorations(state(doc), from, doc.length), doc)).toEqual([
      'key:"\\"b\\""',
      'number:"1"',
      'bracket depth-1:"}"',
      'bracket depth-0:"}"',
    ])
  })
})

/**
 * The pair under the caret.
 *
 * Read off the brackets **the scan collected**, which is what makes a brace inside
 * a string unable to be one: the scan never offered it as a bracket at all.
 * `bracketMatching` from `@codemirror/language` counts characters, and with no
 * grammar to say what a string is, one brace in a value shifts every pair after it.
 */
describe('the pair the caret is on', () => {
  const matches = (doc: string, head: number) =>
    at(doc, head)
      .filter((one) => one.startsWith('match:') || one.startsWith('unmatched:'))
      .join(' ')

  it('marks both halves, from either side of either half', () => {
    const doc = '{ "a": 1 }'
    // Before the opener, after the opener, before the closer, after the closer.
    for (const head of [0, 1, 9, 10]) {
      expect(matches(doc, head)).toBe('match:"{" match:"}"')
    }
  })

  it('marks nothing when the caret is on neither', () => {
    expect(matches('{ "a": 1 }', 4)).toBe('')
  })

  it('picks the partner at its own depth, not the nearest bracket', () => {
    const doc = '{ "a": { "b": 1 } }'
    expect(at(doc, 0).filter((one) => one.startsWith('match:'))).toEqual([
      'match:"{"',
      'match:"}"',
    ])
    // The outer pair, so the closer marked is the *last* brace and not the inner one.
    const marked = jsonDecorations(state(doc, 0), 0, doc.length)
    const ends: number[] = []
    const iter = marked.iter()
    while (iter.value) {
      if ((iter.value.spec as { class?: string }).class === 'cm-json-match') ends.push(iter.from)
      iter.next()
    }
    expect(ends).toEqual([0, doc.length - 1])
  })

  it('crosses a bracket of the other kind without counting it', () => {
    const doc = '{ "a": [1, 2] }'
    expect(matches(doc, 0)).toBe('match:"{" match:"}"')
    // And the array's own pair, from inside it.
    expect(matches(doc, 7)).toBe('match:"[" match:"]"')
  })

  /** The case the library's matcher gets wrong: the brace in the value is not a
   *  bracket, so it neither pairs with anything nor breaks the pair that spans it. */
  it('never pairs with a brace inside a string', () => {
    const doc = '{ "shape": "a { in prose" }'
    expect(matches(doc, 0)).toBe('match:"{" match:"}"')
  })

  it('says so when nothing closes it', () => {
    expect(matches('{ "a": 1', 0)).toBe('unmatched:"{"')
    expect(matches('  }', 3)).toBe('unmatched:"}"')
  })

  // Highlighting a pair while text is selected says something about the selection
  // that is not true.
  it('is a cursor thing, not a selection thing', () => {
    const doc = '{ "a": 1 }'
    const selected = EditorState.create({ doc, selection: { anchor: 0, head: 6 } })
    const spansFound = spans(jsonDecorations(selected, 0, doc.length), doc)
    expect(spansFound.filter((one) => one.startsWith('match:'))).toEqual([])
  })
})

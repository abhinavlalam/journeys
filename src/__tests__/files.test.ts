import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { fileKind, isTextFile } from '../vaultModel'
import { csvDecorations, fieldsOf, separatorOf } from '../csvPreview'

describe('what a file is', () => {
  it('reads the kind off the extension, and a locked note is a note', () => {
    expect(fileKind('roadmap.md')).toBe('note')
    expect(fileKind('Secure/Private.enc')).toBe('note')
    expect(fileKind('data.json')).toBe('json')
    expect(fileKind('Exports/spend.CSV')).toBe('csv')
    expect(fileKind('table.tsv')).toBe('csv')
    expect(fileKind('notes.txt')).toBe('text')
    expect(fileKind('.config/tmux.conf')).toBe('text')
    expect(fileKind('deck.pdf')).toBe('pdf')
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg', 'g.heic']) {
      expect(fileKind(name), name).toBe('image')
    }
    // Anything else is a file the app has nothing to say about, which it says.
    expect(fileKind('archive.zip')).toBe('other')
    expect(fileKind('Makefile')).toBe('other')
  })

  /** What the corpus may read: a PDF read as text is nonsense in the index. */
  it('lets the corpus read text and nothing else', () => {
    expect(['roadmap.md', 'data.json', 'spend.csv', 'notes.txt'].every(isTextFile)).toBe(true)
    expect(['deck.pdf', 'a.png', 'archive.zip'].some(isTextFile)).toBe(false)
  })
})

describe('a delimited file', () => {
  it('takes its separator from the first line, and keeps it for the file', () => {
    expect(separatorOf('a,b,c')).toBe(',')
    expect(separatorOf('a\tb\tc')).toBe('\t')
    expect(separatorOf('a;b;c')).toBe(';')
    // A line with one of each is a comma file with punctuation in it.
    expect(separatorOf('a,b;c')).toBe(',')
    expect(separatorOf('one column')).toBe(',')
  })

  it('splits on the separator, and a quote protects its own', () => {
    const cut = (line: string) => fieldsOf(line, ',').map((f) => line.slice(f.from, f.to))
    expect(cut('a,b,c')).toEqual(['a', 'b', 'c'])
    expect(cut('"Smith, John",42')).toEqual(['"Smith, John"', '42'])
    // A doubled quote is an escaped one and does not end the field.
    expect(cut('"she said ""no""",ok')).toEqual(['"she said ""no"""', 'ok'])
    // An empty field is a field: the columns after it must not shift.
    expect(cut('a,,c')).toEqual(['a', '', 'c'])
    // A file being typed is unbalanced most of the time, and colour that vanishes
    // mid-keystroke is worse than colour that runs to the end of the line.
    expect(cut('a,"unclosed,b')).toEqual(['a', '"unclosed,b'])
  })

  it('marks every field with its column’s colour, cycling after six', () => {
    const doc = 'a,b,c,d,e,f,g,h\n1,2,3'
    const state = EditorState.create({ doc })
    const found: string[] = []
    const iter = csvDecorations(state, 0, doc.length).iter()
    while (iter.value) {
      found.push(`${(iter.value.spec as { class: string }).class}@${iter.from}-${iter.to}`)
      iter.next()
    }
    // The seventh column starts the cycle again.
    expect(found.slice(0, 8)).toEqual([
      'cm-csv-c0@0-1',
      'cm-csv-c1@2-3',
      'cm-csv-c2@4-5',
      'cm-csv-c3@6-7',
      'cm-csv-c4@8-9',
      'cm-csv-c5@10-11',
      'cm-csv-c0@12-13',
      'cm-csv-c1@14-15',
    ])
    // The second line starts at its own first column.
    expect(found.slice(8)).toEqual(['cm-csv-c0@16-17', 'cm-csv-c1@18-19', 'cm-csv-c2@20-21'])
  })

  it('leaves an empty field and an empty line unmarked', () => {
    const doc = 'a,,c\n\nx'
    const state = EditorState.create({ doc })
    const found: string[] = []
    const iter = csvDecorations(state, 0, doc.length).iter()
    while (iter.value) {
      found.push(`${(iter.value.spec as { class: string }).class}@${iter.from}-${iter.to}`)
      iter.next()
    }
    expect(found).toEqual(['cm-csv-c0@0-1', 'cm-csv-c2@3-4', 'cm-csv-c0@6-7'])
  })
})

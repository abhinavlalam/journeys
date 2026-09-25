import { describe, expect, it } from 'vitest'
import { searchNotes } from '../search'
import type { VaultFile } from '../vaultModel'

/**
 * Finding a note, over the corpus `App` already holds. No mock of anything: this
 * module could not reach a disk if it wanted to.
 */
const note = (path: string): VaultFile => ({
  path,
  absolutePath: `/v/${path}`,
  name: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
})

const VAULT = [
  { note: note('Pingbird.md'), text: '---\npath: Pingbird\n---\n\nWhat the messenger got right.\n' },
  { note: note('Plans/Q3.md'), text: '---\npath: Plans/Q3\n---\n\n# Q3\n\nShip the tree.\n' },
  { note: note('standup.md'), text: 'Standup\n\n- shipped the tree\n- reviewed the editor\n' },
]

const names = (query: string) => searchNotes(VAULT, query).map((hit) => hit.note.name)

describe('searchNotes', () => {
  it('finds a note by its name, whatever the case', () => {
    expect(names('pingbird')).toEqual(['Pingbird'])
    expect(names('Q3')).toEqual(['Q3'])
  })

  it('finds a note by a word inside it, and says which line', () => {
    expect(searchNotes(VAULT, 'messenger')).toEqual([
      { note: VAULT[0].note, line: 'What the messenger got right.' },
    ])
  })

  it('puts names before contents', () => {
    // `standup` names one note and appears in the text of none; `tree` is in the
    // text of two. Both halves come back, named first.
    expect(names('tree')).toEqual(['Q3', 'standup'])
  })

  /**
   * The body, not the whole file. `path: Plans/Q3` is a property, and searching it
   * would make every note under `Plans/` a hit for "plans" — the one answer nobody
   * is looking for, since the tree already says where a note sits.
   */
  it('does not search the properties', () => {
    expect(names('plans')).toEqual([])
  })

  it('answers nothing for an empty query, and for whitespace', () => {
    expect(searchNotes(VAULT, '')).toEqual([])
    expect(searchNotes(VAULT, '   ')).toEqual([])
  })

  it('says a note once, by its name, when both halves would match', () => {
    // "Pingbird" is the note's name and its `path:` — one row, no line under it.
    expect(searchNotes(VAULT, 'Pingbird')).toEqual([{ note: VAULT[0].note }])
  })

  it('stops at the limit', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      note: note(`note-${String(i).padStart(2, '0')}.md`),
      text: 'nothing here\n',
    }))
    expect(searchNotes(many, 'note').length).toBe(40)
    expect(searchNotes(many, 'note', 5).length).toBe(5)
  })
})

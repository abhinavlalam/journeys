import { describe, expect, it } from 'vitest'
import { nothingPicked, pick, pickMode, withoutUnder, type Picked } from '../picking'
import { visibleFiles } from '../links'
import type { VaultFolder } from '../vaultModel'

/** The rows as the tree draws them: `a`, then `Areas` open with `x` and `y`, then `b`. */
const ORDER = ['Areas/x.md', 'Areas/y.md', 'a.md', 'b.md']
const names = (picked: Picked) => [...picked.paths].sort()

describe('a gesture', () => {
  it('is read off the modifiers, and `mod` is the meta key', () => {
    expect(pickMode({ metaKey: false, shiftKey: false })).toBe('only')
    expect(pickMode({ metaKey: true, shiftKey: false })).toBe('toggle')
    expect(pickMode({ metaKey: false, shiftKey: true })).toBe('range')
    // Both: ⌘ wins, because toggling is the one that never loses what is picked.
    expect(pickMode({ metaKey: true, shiftKey: true })).toBe('toggle')
  })
})

describe('picking', () => {
  it('makes a plain click the whole set', () => {
    const one = pick({ paths: new Set(ORDER), anchor: 'b.md' }, 'a.md', 'only', ORDER)
    expect(names(one)).toEqual(['a.md'])
    expect(one.anchor).toBe('a.md')
  })

  it('adds and removes one at a time, and the anchor follows the hand', () => {
    let picked = pick(nothingPicked, 'a.md', 'toggle', ORDER)
    picked = pick(picked, 'b.md', 'toggle', ORDER)
    expect(names(picked)).toEqual(['a.md', 'b.md'])
    expect(picked.anchor).toBe('b.md')
    picked = pick(picked, 'b.md', 'toggle', ORDER)
    expect(names(picked)).toEqual(['a.md'])
    // Un-picking the anchor leaves none, so the next range starts where it is asked.
    expect(picked.anchor).toBeNull()
  })

  it('takes the range between the anchor and the row, in either direction', () => {
    const from = pick(nothingPicked, 'Areas/y.md', 'toggle', ORDER)
    expect(names(pick(from, 'b.md', 'range', ORDER))).toEqual(['Areas/y.md', 'a.md', 'b.md'])
    // Backwards is the same range.
    const to = pick(nothingPicked, 'b.md', 'toggle', ORDER)
    expect(names(pick(to, 'Areas/y.md', 'range', ORDER))).toEqual(['Areas/y.md', 'a.md', 'b.md'])
  })

  it('is one row when there is no anchor, or when an end is no longer shown', () => {
    expect(names(pick(nothingPicked, 'a.md', 'range', ORDER))).toEqual(['a.md'])
    const stale = { paths: new Set(['Deep/gone.md']), anchor: 'Deep/gone.md' }
    expect(names(pick(stale, 'b.md', 'range', ORDER))).toEqual(['b.md'])
  })

  it('drops a deleted note, and everything under a deleted folder', () => {
    const picked = { paths: new Set(ORDER), anchor: 'Areas/x.md' }
    expect(names(withoutUnder(picked, 'a.md'))).toEqual(['Areas/x.md', 'Areas/y.md', 'b.md'])
    const folder = withoutUnder(picked, 'Areas')
    expect(names(folder)).toEqual(['a.md', 'b.md'])
    expect(folder.anchor).toBeNull()
    // Nothing to drop is the same set, so a delete elsewhere costs no render.
    expect(withoutUnder(picked, 'other.md')).toBe(picked)
  })
})

describe('the order a range runs in', () => {
  const file = (path: string) => ({ path, absolutePath: `/v/${path}`, name: path.split('/').pop()! })
  const tree: VaultFolder = {
    path: '',
    absolutePath: '/v',
    name: 'v',
    folders: [
      {
        path: 'Areas',
        absolutePath: '/v/Areas',
        name: 'Areas',
        folders: [],
        files: [file('Areas/x.md'), file('Areas/y.md')],
      },
    ],
    files: [file('a.md'), file('b.md')],
  }

  /** `FolderTree` draws a folder's subfolders before its own files, so the order is
   *  the tree's and a range covers what lies between two clicks on screen. */
  it('is the tree’s own, and skips what a shut folder hides', () => {
    expect(visibleFiles(tree, new Set(['Areas'])).map((f) => f.path)).toEqual(ORDER)
    expect(visibleFiles(tree, new Set()).map((f) => f.path)).toEqual(['a.md', 'b.md'])
    expect(visibleFiles(null, new Set())).toEqual([])
  })
})

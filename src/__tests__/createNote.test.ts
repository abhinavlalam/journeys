import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What "New note…" may put on disk. A name with a `/` would write into an
 * unchosen folder, or fail on a missing one; a name with a leading dot
 * makes a file `walk` skips, invisible in the tree. A dot is refused, not
 * folded: `safeName` only replaces characters a path cannot hold, so
 * `.plan` would pass and a folder named that would hide everything in it.
 */

const disk = new Map<string, string>()
const dirs = new Set<string>()

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(async () => []),
  writeFile: vi.fn(),
  readTextFile: vi.fn(async (p: string) => disk.get(p) ?? ''),
  writeTextFile: vi.fn(async (p: string, text: string) => {
    disk.set(p, text)
  }),
  exists: vi.fn(async (p: string) => disk.has(p) || dirs.has(p)),
  mkdir: vi.fn(async (p: string) => {
    dirs.add(p)
  }),
  // A real move, since `convertToNested` below is one: a do-nothing
  // `rename` would let its test pass with the note left behind.
  rename: vi.fn(async (from: string, to: string) => {
    const text = disk.get(from)
    if (text === undefined) throw new Error(`no such file: ${from}`)
    disk.delete(from)
    disk.set(to, text)
  }),
  remove: vi.fn(async () => {}),
}))

const { convertToNested, createNote, ensureFolder, safeNewName } = await import('../vault')

beforeEach(() => {
  disk.clear()
  dirs.clear()
})

describe('a new note that names a path', () => {
  it('folds the separator instead of writing into another folder', async () => {
    const file = await createNote('/v', 'Notes', 'Q3/Plan')
    expect(file.path).toBe('Notes/Q3-Plan.md')
    expect([...disk.keys()]).toEqual(['/v/Notes/Q3-Plan.md'])
  })

  // Folding, not dropping, so two different names cannot become one.
  it('keeps every other character as typed', async () => {
    const file = await createNote('/v', 'Notes', 'Reading List 2026')
    expect(file.path).toBe('Notes/Reading List 2026.md')
  })
})

/**
 * A wikilink says where a note goes, not only its name. `[[Landmark
 * Plaza/Northwind Office]]` is written before either exists, and following
 * it makes the folder and the note in it. Before, `writeText` got a path
 * whose folder was missing and the click ended in an error. The folder stays
 * a nested note with nothing in it: its own `.md` waits for the first key.
 */
describe('a new note under folders that are not there', () => {
  it('creates the folders, and only the note as a file', async () => {
    const file = await createNote('/v', 'Landmark Plaza', 'Northwind Office')
    expect(file.path).toBe('Landmark Plaza/Northwind Office.md')
    expect([...disk.keys()]).toEqual(['/v/Landmark Plaza/Northwind Office.md'])
    expect([...dirs]).toEqual(['/v/Landmark Plaza'])
  })

  it('walks more than one level down', async () => {
    await createNote('/v', 'Landmark Plaza/Floor 3', 'Northwind Office')
    expect([...dirs]).toEqual(['/v/Landmark Plaza', '/v/Landmark Plaza/Floor 3'])
  })

  it('leaves a folder that is already there alone', async () => {
    dirs.add('/v/Landmark Plaza')
    expect(await ensureFolder('/v', 'Landmark Plaza/Floor 3')).toBe('Landmark Plaza/Floor 3')
    expect([...dirs]).toEqual(['/v/Landmark Plaza', '/v/Landmark Plaza/Floor 3'])
  })

  it('holds each segment to the same rule a typed name gets', async () => {
    await expect(createNote('/v', '.hidden', 'Plan')).rejects.toThrow(/starts with a dot/)
    expect([...dirs]).toEqual([])
  })
})

describe('a new note whose name starts with a dot', () => {
  it('is refused rather than written where nothing can show it', async () => {
    await expect(createNote('/v', 'Notes', '.plan')).rejects.toThrow(/starts with a dot/)
    expect([...disk.keys()]).toEqual([])
  })

  // The same rule for the folders a path names, where it matters
  // most: a hidden folder takes every note in it out of the tree.
  it('is refused for a folder in the path too', async () => {
    await expect(createNote('/v', '.hidden', 'plan')).rejects.toThrow(/dot/)
    expect([...dirs]).toEqual([])
    expect([...disk.keys()]).toEqual([])
  })
})

describe('a name that is nothing but illegal characters', () => {
  it('is refused rather than written as bare .md', async () => {
    await expect(createNote('/v', 'Notes', '///')).rejects.toThrow('Name required.')
    expect([...disk.keys()]).toEqual([])
  })
})

/** The rule is shared: both creators and `renameFile` and `renameFolder` use it. */
describe('the shared new-name rule', () => {
  it('folds what a path cannot hold and keeps everything else', () => {
    expect(safeNewName('Q3/Plan')).toBe('Q3-Plan')
    expect(safeNewName('  Reading List  ')).toBe('Reading List')
  })

  it('refuses an empty result and a leading dot', () => {
    expect(() => safeNewName('///')).toThrow('Name required.')
    expect(() => safeNewName('.claude')).toThrow(/dot/)
  })
})

/**
 * A page becomes a nested page: `Ideas.md` → `Ideas/Ideas.md`, a folder and one
 * move. The note's bytes are never read, so the conversion cannot mangle it.
 */
describe('a page becoming a nested page', () => {
  const page = (path: string) => ({
    path,
    absolutePath: `/v/${path}`,
    name: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
  })

  it('moves the note into the folder it implies, text and all', async () => {
    disk.set('/v/Notes/Ideas.md', '# Ideas\n\nThings worth trying.\n')
    const moved = await convertToNested(page('Notes/Ideas.md'), '/v')

    expect(moved.path).toBe('Notes/Ideas/Ideas.md')
    expect([...dirs]).toEqual(['/v/Notes/Ideas'])
    expect(disk.get('/v/Notes/Ideas/Ideas.md')).toBe('# Ideas\n\nThings worth trying.\n')
    expect(disk.has('/v/Notes/Ideas.md')).toBe(false)
  })

  it('refuses when a folder of that name is already there', async () => {
    disk.set('/v/Ideas.md', 'x')
    dirs.add('/v/Ideas')

    await expect(convertToNested(page('Ideas.md'), '/v')).rejects.toThrow(/already a nested note/)
    // And the note is still where it was, not half moved.
    expect(disk.has('/v/Ideas.md')).toBe(true)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What "New note…" is allowed to put on disk.
 *
 * A name holding a `/` would write into a folder the user never picked — or fail on
 * a directory that does not exist — and a name with a leading dot creates a file
 * `walk` skips: it opens in the editor and is then invisible to the tree,
 * unreachable from anywhere in the app.
 *
 * A dot is refused rather than folded, and that is the one thing `safeName` alone
 * does not fix: it folds only characters a path cannot hold, so `.plan` survives it
 * unchanged and a folder named for it would hide everything inside it.
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
  // A real move, because `convertToNested` below is one: a `rename` that did
  // nothing would let its test pass with the note left where it was.
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

  // Folding, not dropping: two different names must not collapse into one.
  it('keeps every other character as typed', async () => {
    const file = await createNote('/v', 'Notes', 'Reading List 2026')
    expect(file.path).toBe('Notes/Reading List 2026.md')
  })
})

/**
 * A wikilink says where a note goes, not only what it is called.
 *
 * `[[Landmark Plaza/Northwind Office]]` is written before either exists, and
 * following it has to make both — the folder, and the note inside it. Before this,
 * `writeText` was handed a path whose directory was not there and the click ended
 * in the error banner.
 *
 * The folder is left as a nested note with nothing in it: a folder *is* a note and
 * its own `.md` waits for the first keystroke, so following one link must not put
 * two notes on the disk.
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

  // The same rule reaches the folders a path names, which is where it matters most:
  // a hidden folder would take every note inside it out of the tree.
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

/**
 * The rule is shared, because both creators apply it and `renameFile` and
 * `renameFolder` do too — a second copy is how the four come to disagree.
 */
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
 * A page becomes a nested page: `Ideas.md` → `Ideas/Ideas.md`.
 *
 * That pairing is what a nested note *is*, so this is a folder and one move. The
 * note's bytes are never read, which is the property worth pinning: a conversion
 * that rewrote the file would be a conversion that could mangle it.
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
    // And the note is still where it was, rather than half-moved.
    expect(disk.has('/v/Ideas.md')).toBe(true)
  })
})

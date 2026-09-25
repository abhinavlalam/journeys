import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultFile, VaultFolder } from '../vaultModel'

/**
 * Where a rename is allowed to put a file.
 *
 * `renameFile` splices its destination out of the typed name, so without folding, a
 * name that walks up moves a note out of its folder — and out of the vault — and a
 * name holding `/` moves it into a folder nobody picked. Neither layer below says
 * anything: `fs:allow-rename` is scoped `**`, and the `exists()` collision guard
 * runs on the escaped path. A leading dot is the other half: `.archive` would
 * rename a folder, its note and every note under it into something `walk` skips.
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
  // Moves the bytes, so an escaped destination is visible as a key outside the
  // vault. A directory carries its contents, the way rename(2) does — otherwise the
  // folder note could not be found at its new home and would never be re-paired.
  rename: vi.fn(async (from: string, to: string) => {
    for (const key of [...disk.keys()]) {
      if (key !== from && !key.startsWith(`${from}/`)) continue
      disk.set(to + key.slice(from.length), disk.get(key) ?? '')
      disk.delete(key)
    }
    for (const dir of [...dirs]) {
      if (dir !== from && !dir.startsWith(`${from}/`)) continue
      dirs.delete(dir)
      dirs.add(to + dir.slice(from.length))
    }
  }),
  remove: vi.fn(async () => {}),
}))

const { renameFile, renameFolder } = await import('../vault')

const note = (path: string): VaultFile => ({
  path,
  absolutePath: `/v/${path}`,
  name: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
})

const folder = (path: string, withNote = false): VaultFolder => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    path,
    absolutePath: `/v/${path}`,
    name,
    folders: [],
    files: [],
    note: withNote ? note(`${path}/${name}.md`) : undefined,
  }
}

beforeEach(() => {
  disk.clear()
  dirs.clear()
  disk.set('/v/Notes/inbox.md', 'kept')
})

describe('renaming a note to a name that names a path', () => {
  it('refuses one that walks out of the vault', async () => {
    await expect(renameFile(note('Notes/inbox.md'), '../../../Desktop/pwned')).rejects.toThrow()
    expect([...disk.keys()]).toEqual(['/v/Notes/inbox.md'])
  })

  it('refuses one that walks up a single folder', async () => {
    await expect(renameFile(note('Notes/inbox.md'), '../evil')).rejects.toThrow()
    expect([...disk.keys()]).toEqual(['/v/Notes/inbox.md'])
  })

  it('folds a separator instead of writing into another folder', async () => {
    const renamed = await renameFile(note('Notes/inbox.md'), 'x/y')
    expect(renamed.path).toBe('Notes/x-y.md')
    expect([...disk.keys()]).toEqual(['/v/Notes/x-y.md'])
  })

  it('refuses a leading dot, which no view in the app can show', async () => {
    await expect(renameFile(note('Notes/inbox.md'), '.plan')).rejects.toThrow(/dot/)
    expect([...disk.keys()]).toEqual(['/v/Notes/inbox.md'])
  })

  /**
   * The invariant, stated without reference to any name: a rename changes a name,
   * never a location. `moveFile` is the operation that changes location, and its
   * destination comes from the tree.
   */
  it('never lands outside the note’s own folder, whatever is typed', async () => {
    for (const typed of ['../x', 'a/../../x', './../x', '..', 'x/../../y', '/etc/passwd']) {
      disk.clear()
      disk.set('/v/Notes/inbox.md', 'kept')
      const renamed = await renameFile(note('Notes/inbox.md'), typed).catch(() => null)
      if (renamed) expect(renamed.path.slice(0, renamed.path.lastIndexOf('/'))).toBe('Notes')
      for (const key of disk.keys()) expect(key.startsWith('/v/Notes/')).toBe(true)
    }
  })
})

describe('renaming a note that is nothing unusual', () => {
  it('still appends .md and stays put', async () => {
    const renamed = await renameFile(note('Notes/inbox.md'), 'report')
    expect(renamed.path).toBe('Notes/report.md')
    expect(renamed.name).toBe('report')
    expect([...disk.keys()]).toEqual(['/v/Notes/report.md'])
  })

  // Both volumes here are case-insensitive, so the containment check has to answer
  // on the *parent* rather than on a path equality that reads two names as one file.
  it('still allows a case-only rename', async () => {
    const renamed = await renameFile(note('Notes/inbox.md'), 'Inbox')
    expect(renamed.path).toBe('Notes/Inbox.md')
    expect([...disk.keys()]).toEqual(['/v/Notes/Inbox.md'])
  })
})

describe('renaming a folder', () => {
  beforeEach(() => {
    disk.clear()
    dirs.add('/v/Notes/trip')
    disk.set('/v/Notes/trip/trip.md', 'the note')
  })

  it('refuses a leading dot, which would hide the folder and everything in it', async () => {
    await expect(renameFolder(folder('Notes/trip', true), '.archive')).rejects.toThrow(/dot/)
    expect([...dirs]).toEqual(['/v/Notes/trip'])
    expect([...disk.keys()]).toEqual(['/v/Notes/trip/trip.md'])
  })

  it('folds a separator and keeps the folder note paired', async () => {
    const renamed = await renameFolder(folder('Notes/trip', true), 'Q3/Plan')
    expect(renamed.path).toBe('Notes/Q3-Plan')
    expect([...dirs]).toEqual(['/v/Notes/Q3-Plan'])
    expect([...disk.keys()]).toEqual(['/v/Notes/Q3-Plan/Q3-Plan.md'])
  })

  it('refuses a name that walks up', async () => {
    await expect(renameFolder(folder('Notes/trip', true), '../trip')).rejects.toThrow()
    expect([...dirs]).toEqual(['/v/Notes/trip'])
  })
})

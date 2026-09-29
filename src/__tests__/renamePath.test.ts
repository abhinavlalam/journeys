import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultFolder } from '../vaultModel'
import { vaultFile as note } from './fakeVault'

/**
 * Where a rename may put a file. `renameFile` builds its destination from the typed
 * name, so without folding a name that walks up moves a note out of its folder or the
 * vault, and a `/` moves it into an unchosen folder. Nothing below stops it:
 * `fs:allow-rename` is scoped `**`, and the `exists()` guard runs on the escaped path.
 * A leading dot would move a folder and all its notes into something `walk` skips.
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
  // Moves the bytes, so an escaped destination shows as a key
  // outside the vault. A folder carries its contents, as rename(2)
  // does, or the folder note would not be found at its new place.
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
   * The rule without names: a rename changes a name, never a location.
   * `moveFile` changes location, and its destination comes from the tree.
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

  // The volumes are case-insensitive, so the containment check answers on
  // the parent, not on a path equality that reads two names as one file.
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

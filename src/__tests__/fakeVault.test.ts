import { beforeEach, describe, expect, it, vi } from 'vitest'
import { disk, fsModule, resetFakeVault } from './fakeVault'
import { isSamePath } from '../vaultModel'

/**
 * The helper's own test: the real `vault.ts` runs on the fake disk,
 * so this checks that the real `walk`, `isSamePath`, and create,
 * rename, move and delete behave as on disk, case rules included.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())

const vault = await import('../vault')

beforeEach(() => {
  resetFakeVault()
})

describe('the fake disk under the real vault', () => {
  it('walks the default folder into the tree the app expects', async () => {
    const root = await vault.readVault('/v')

    expect(root.folders.map((f) => f.name)).toEqual(['Ideas'])
    expect(root.files.map((f) => f.path)).toEqual(['inbox.md', 'roadmap.md', 'standup.md'])

    const ideas = root.folders[0]
    // A nested folder note is lifted onto its folder, not listed as a
    // child: that is what makes a tree node both a note and a container.
    expect(ideas.note?.path).toBe('Ideas/Ideas.md')
    expect(ideas.files.map((f) => f.path)).toEqual(['Ideas/pingbird.md'])
  })

  /**
   * Every file, and no dot entry. The walk once hid everything but `.md`,
   * `.json` and `.enc`. What differs between a note and a PDF is what the
   * reading pane does with it (`fileKind`), not whether the tree shows it.
   */
  it('shows every file, and skips every dot-prefixed entry', async () => {
    disk.write('/v/deck.pdf', 'not markdown')
    disk.write('/v/whiteboard.png', 'not markdown either')
    disk.write('/v/.plan.md', 'hidden')
    disk.write('/v/.claude/skills/x/SKILL.md', 'hidden too')

    const root = await vault.readVault('/v')
    expect(root.files.map((f) => f.name)).toContain('deck.pdf')
    expect(root.files.map((f) => f.name)).toContain('whiteboard.png')
    // Why `safeNewName` refuses a leading dot: a `.plan.md`
    // would be written and then hidden here.
    expect(root.files.map((f) => f.name)).not.toContain('.plan')
    expect(root.folders.map((f) => f.name)).not.toContain('.claude')
  })

  it('hands back the same tree object when nothing changed', async () => {
    const first = await vault.readVault('/v')
    expect(await vault.readVault('/v')).toBe(first)

    disk.write('/v/new.md', 'something')
    expect(await vault.readVault('/v')).not.toBe(first)
  })

  it('is case-insensitive and case-preserving, as the volume is', async () => {
    disk.write('/v/index.md', 'first')
    // `exists("Index.md")` true for `index.md` made a case-only
    // rename trip its own guard.
    expect(disk.has('/v/INDEX.md')).toBe(true)
    expect(isSamePath('/v/Index.md', '/v/index.md')).toBe(true)

    disk.write('/v/Index.md', 'second')
    expect(disk.read('/v/index.md')).toBe('second')
    // One file, still with the name it was created with.
    expect(disk.paths().filter((p) => /index\.md$/i.test(p))).toEqual(['/v/index.md'])
  })

  it('lists a file it refuses to read, which a Map mock cannot express', async () => {
    disk.corrupt('/v/roadmap.md')

    const root = await vault.readVault('/v')
    expect(root.files.map((f) => f.path)).toContain('roadmap.md')
    await expect(vault.readVaultFile(root.files[1])).rejects.toThrow()
  })

  it('round-trips a write, a rename and a delete through vault.ts', async () => {
    const root = await vault.readVault('/v')
    const file = root.files.find((f) => f.path === 'roadmap.md')!

    await vault.writeVaultFile(file, '# Roadmap\n\nrewritten\n')
    expect(disk.read('/v/roadmap.md')).toContain('rewritten')

    const renamed = await vault.renameFile(file, 'plan')
    expect(renamed.path).toBe('plan.md')
    expect(disk.has('/v/roadmap.md')).toBe(false)
    expect(disk.read('/v/plan.md')).toContain('rewritten')

    await vault.deleteFile(renamed)
    expect(disk.has('/v/plan.md')).toBe(false)
  })

  it('renames a whole folder, subtree and folder note together', async () => {
    const root = await vault.readVault('/v')
    const ideas = root.folders.find((f) => f.name === 'Ideas')!

    await vault.renameFolder(ideas, 'Thoughts')

    expect(disk.has('/v/Ideas')).toBe(false)
    expect(disk.paths()).toContain('/v/Thoughts/pingbird.md')
    // The folder note is matched by name, so it must follow the
    // rename, or the folder comes back without its note.
    expect(disk.paths()).toContain('/v/Thoughts/Thoughts.md')
  })

  it('moves a note into a folder and refuses to move a folder inside itself', async () => {
    const root = await vault.readVault('/v')
    const file = root.files.find((f) => f.path === 'inbox.md')!

    const moved = await vault.moveFile(file, '/v', 'Ideas')
    expect(moved.path).toBe('Ideas/inbox.md')
    expect(disk.has('/v/inbox.md')).toBe(false)

    const ideas = root.folders.find((f) => f.name === 'Ideas')!
    await expect(vault.moveFolder(ideas, '/v', 'Ideas/deeper')).rejects.toThrow(/inside itself/)
  })

  it('refuses a write under a forbidden prefix, as an fs scope would', async () => {
    disk.forbid('/v/Ideas', 'forbidden path')
    const root = await vault.readVault('/v')
    await expect(vault.writeVaultFile(root.folders[0].note!, 'nope')).rejects.toThrow(/forbidden/)
  })
})

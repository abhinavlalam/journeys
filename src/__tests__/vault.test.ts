import { describe, expect, it, vi } from 'vitest'

// `vault.ts` imports the fs plugin at load, so even pure
// functions need the mock. Nothing here touches the disk.
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  writeFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}))

const { safeName, isSelfOrDescendant } = await import('../vault')

// Names are kept as typed; only characters a path cannot hold are replaced.
describe('note and folder names', () => {
  it('keeps case and spaces', () => {
    expect(safeName('Q3 Planning')).toBe('Q3 Planning')
    expect(safeName('  Areas  ')).toBe('Areas')
  })

  // Folding, not dropping, so two different names cannot become one.
  it('replaces characters a path cannot hold', () => {
    expect(safeName('a/b')).toBe('a-b')
    expect(safeName('a:b*c?d"e<f>g|h')).toBe('a-b-c-d-e-f-g-h')
    expect(safeName('a\\b')).toBe('a-b')
  })

  it('can reduce to nothing, which safeNewName is what refuses', () => {
    expect(safeName('   ')).toBe('')
    expect(safeName('///')).toBe('')
  })

  // It replaces a separator but keeps a leading dot, which is why
  // `safeNewName` exists on top of it. See `createNote.test.ts`.
  it('keeps a leading dot', () => {
    expect(safeName('.plan')).toBe('.plan')
  })
})

describe('containment', () => {
  it('detects a folder inside itself', () => {
    expect(isSelfOrDescendant('areas', 'areas')).toBe(true)
    expect(isSelfOrDescendant('areas', 'areas/health')).toBe(true)
    expect(isSelfOrDescendant('areas', 'other')).toBe(false)
    // A prefix is not a parent: the separator must be there.
    expect(isSelfOrDescendant('areas', 'areas-other')).toBe(false)
  })
})

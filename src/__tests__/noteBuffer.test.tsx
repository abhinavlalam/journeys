/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { disk, fsModule, resetFakeVault, vaultFile } from './fakeVault'

/**
 * What happens to typing that cannot be written. A failed save used to be said and
 * then forgotten: the flush after it reported success, so a quit went ahead and the
 * typing was lost, though the quit is meant to stay when a note could not be saved.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())

const { useNoteBuffer } = await import('../useNoteBuffer')

const note = vaultFile('roadmap.md')

async function opened() {
  const setError = vi.fn()
  const { result } = renderHook(() => useNoteBuffer({ vaultPath: '/v', refresh: async () => null, setError }))
  await act(() => result.current.openNote(note))
  return { buffer: () => result.current, setError }
}

beforeEach(() => {
  resetFakeVault()
  disk.write('/v/roadmap.md', 'one\n')
})

describe('a save that fails', () => {
  it('stays queued, and the flush says so rather than reporting success', async () => {
    const { buffer, setError } = await opened()
    disk.forbid('/v/roadmap.md', 'refused')
    act(() => buffer().handleEditorChange('two\n'))
    await expect(buffer().flushPendingSave()).rejects.toThrow(/refused/)
    expect(setError.mock.calls.at(-1)?.[0]).toMatch(/Could not save roadmap\.md: .*refused/)
    // Still queued: a second flush tries it again.
    await expect(buffer().flushPendingSave()).rejects.toThrow(/refused/)
    // Once the disk takes it, the typing lands.
    disk.clear()
    disk.write('/v/roadmap.md', 'one\n')
    await act(() => buffer().flushPendingSave())
    expect(disk.read('/v/roadmap.md')).toBe('two\n')
  })

  it('is not the note deleted elsewhere: the typing is written', async () => {
    const { buffer } = await opened()
    disk.delete('/v/roadmap.md')
    act(() => buffer().handleEditorChange('typed\n'))
    await act(() => buffer().flushPendingSave())
    expect(disk.read('/v/roadmap.md')).toBe('typed\n')
  })
})

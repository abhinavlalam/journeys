/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { disk, fsModule, resetFakeVault } from './fakeVault'
import { readVault } from '../vault'
import { useVaultTexts } from '../useVaultTexts'

/**
 * Every return to the window read every note, and after the Mac slept, with Drive slow
 * to answer, that took 22 seconds and held up opening today's page. A read now takes a
 * note again only when its size or modified time has changed.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())

afterEach(cleanup)
beforeEach(() => resetFakeVault())

/** Held, as the app's settings are: a new `[]` each render is a new graph each render. */
const hides: string[] = []
const types = {}
const liveText = { current: null }
const onError = () => {}

async function texts() {
  const root = await readVault('/v')
  const hook = renderHook(() =>
    useVaultTexts({ root, graphHides: hides, dailyFolder: 'Daily', vaultPath: '/v', openPath: null, viewOpen: false, liveVersion: 0, liveText, types, onError })
  )
  await waitFor(() => expect(hook.result.current.graph).not.toBeNull())
  return hook
}

const spies = fsModule()
const reads = () => spies.readTextFile.mock.calls.map(([path]) => String(path))
const returnToWindow = () => act(async () => void window.dispatchEvent(new Event('focus')))

describe('reading the vault again', () => {
  it('reads nothing on a return when nothing changed, and keeps every view as it was', async () => {
    const { result } = await texts()
    const graph = result.current.graph
    spies.readTextFile.mockClear()
    await returnToWindow()
    await waitFor(() => expect(result.current.reading).toBe(false))
    expect(reads()).toEqual([])
    expect(result.current.graph).toBe(graph)
  })

  it('reads only the note that changed', async () => {
    const { result } = await texts()
    spies.readTextFile.mockClear()
    disk.write('/v/inbox.md', '# Inbox\n\nA line about #harbour.\n')
    await returnToWindow()
    await waitFor(() => expect(result.current.tags.map((one) => one.name)).toContain('harbour'))
    expect(reads()).toEqual(['/v/inbox.md'])
  })

  /** Kept as empty, a note Drive could not hand over stayed empty until it was next written. */
  it('tries a note that could not be read again, rather than keeping it empty', async () => {
    disk.write('/v/inbox.md', '# Inbox\n\nA line about #harbour.\n')
    disk.corrupt('/v/inbox.md')
    const { result } = await texts()
    expect(result.current.tags.map((one) => one.name)).not.toContain('harbour')
    // Readable again, as a placeholder becomes once Drive has the file.
    disk.delete('/v/inbox.md')
    disk.write('/v/inbox.md', '# Inbox\n\nA line about #harbour.\n')
    await returnToWindow()
    await waitFor(() => expect(result.current.tags.map((one) => one.name)).toContain('harbour'))
  })
})

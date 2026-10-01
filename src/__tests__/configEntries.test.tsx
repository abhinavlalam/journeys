/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { disk, fsModule, resetFakeVault } from './fakeVault'
import { readEntries, withEntry } from '../configEntries'

/** A `.config` file of entries, which people may edit by hand. */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())

describe('an entries file', () => {
  it('merges into an entry, keeping what it does not know, sorted', () => {
    expect(withEntry('{ "zeta": { "x": 1 }, "amount": { "note": "mine" } }', 'amount', { type: 'number' })).toBe(
      `${JSON.stringify({ amount: { note: 'mine', type: 'number' }, zeta: { x: 1 } }, null, 2)}\n`
    )
  })

  /** An entry that is not an object is replaced: spread, `"number"` became {0: 'n', …}. */
  it('replaces an entry that is not an object', () => {
    expect(JSON.parse(withEntry('{ "amount": "number" }', 'amount', { type: 'number' })!)).toEqual({ amount: { type: 'number' } })
    expect(readEntries('{ "amount": "number", "merchant": { "type": "backlink" } }')).toEqual({ merchant: { type: 'backlink' } })
  })

  it('refuses a file that is not JSON, and reads an empty one as none', () => {
    expect(withEntry('{ half', 'amount', { type: 'number' })).toBeNull()
    expect(readEntries('{ half')).toBeNull()
    expect(readEntries('')).toEqual({})
  })
})

describe('reading one in the app', () => {
  beforeEach(() => resetFakeVault())

  /** A broken file read as no entries at all, and nothing was said. Said once, not on every focus. */
  it('says a file that is not JSON, once', async () => {
    const { useConfigEntries } = await import('../useConfigEntries')
    disk.write('/v/.config/tags.json', '{ half')
    const onError = vi.fn()
    const { result } = renderHook(() => useConfigEntries('/v', 'tags.json', onError))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('tags.json could not be read as JSON, so it was left alone.'))
    act(() => void window.dispatchEvent(new Event('focus')))
    await new Promise((settle) => setTimeout(settle, 50))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(result.current.entries).toEqual({})
  })
})

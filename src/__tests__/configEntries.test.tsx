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

  /** New entries for the same text rebuilt the graph and the property lists on every return. */
  it('keeps the same entries over a focus that finds the file as it was, and takes a change', async () => {
    const { useConfigEntries } = await import('../useConfigEntries')
    disk.write('/v/.config/properties.json', '{ "water": { "type": "number" } }')
    const { result } = renderHook(() => useConfigEntries('/v', 'properties.json', () => {}))
    await waitFor(() => expect(result.current.entries).toEqual({ water: { type: 'number' } }))
    const before = result.current.entries
    act(() => void window.dispatchEvent(new Event('focus')))
    await new Promise((settle) => setTimeout(settle, 50))
    expect(result.current.entries).toBe(before)

    disk.write('/v/.config/properties.json', '{ "water": { "type": "date" } }')
    act(() => void window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(result.current.entries).toEqual({ water: { type: 'date' } }))

    // After a write of its own, a pull putting the text it had before back is a change.
    const unwritten = disk.read('/v/.config/properties.json')!
    await act(() => result.current.write('water', { type: 'url' }))
    expect(result.current.entries).toEqual({ water: { type: 'url' } })
    disk.write('/v/.config/properties.json', unwritten)
    act(() => void window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(result.current.entries).toEqual({ water: { type: 'date' } }))
  })
})

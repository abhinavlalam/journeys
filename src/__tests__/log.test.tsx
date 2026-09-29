/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * **What the app says** is shown at the bottom of the window for a while — it
 * stayed until dismissed, over sync rounds that had since gone through — and every
 * message is kept in the Log, an application of its own, for the window's life.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

afterEach(cleanup)

describe('what the app says', () => {
  afterEach(() => vi.useRealTimers())

  it('is shown a while, still said until put away, and kept', async () => {
    const { useLog, SHOWN_MS } = await import('../useLog')
    vi.useFakeTimers()
    const { result } = renderHook(() => useLog())
    act(() => result.current.say('The sync failed.'))
    expect(result.current.shown?.text).toBe('The sync failed.')
    act(() => vi.advanceTimersByTime(SHOWN_MS))
    expect(result.current.shown).toBeNull()
    // Still said, for the screen with no Log to look in, until it is put away.
    expect(result.current.said?.text).toBe('The sync failed.')
    act(() => result.current.say(null))
    expect([result.current.said, result.current.items.map((one) => one.text)]).toEqual([null, ['The sync failed.']])
  })
})

describe('the Log', () => {
  beforeEach(() => {
    resetFakeVault()
    rememberVault('/v')
  })

  it('lists what the app said, as it was shown at the bottom of the window', async () => {
    disk.corrupt('/v/roadmap.md')
    const { default: App } = await import('../App')
    render(<App />)
    await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
    fireEvent.click(screen.getByText('roadmap'))
    const said = await waitFor(() => screen.getByRole('alert').querySelector('span')!.textContent!)
    fireEvent.click(screen.getByLabelText('Log'))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .log-text')!.textContent).toBe(said))
  })
})

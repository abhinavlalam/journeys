/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { disk, fsModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * Opening a note must not write to it. This file mounts the real editor
 * and checks the bytes on disk: open a note, wait out autosave, and the
 * file must be identical. One case, since a real mount takes seconds.
 *
 * The old WYSIWYG editor added a paragraph to any document not ending in
 * one, which fired the change listener on mount and saved a regenerated
 * copy: bullets changed, lists loosened, the mtime moved. Nothing parses
 * and regenerates a note now; this catches the next thing that tries.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

afterEach(cleanup)

beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
})

describe('opening a note', () => {
  it('does not rewrite one whose last block is a list', { timeout: 40000 }, async () => {
    const original = disk.read('/v/standup.md')!
    // The default vault's `standup.md` has exactly this shape: prose, then a list.
    expect(original.trimEnd().endsWith('- reviewed the editor')).toBe(true)

    const { default: App } = await import('../App')
    const { getByText } = render(<App />)

    await waitFor(() => expect(getByText('standup')).toBeTruthy(), { timeout: 10000 })
    getByText('standup').click()

    // `.cm-content` means the real editor is mounted, not the stub.

    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy(), {
      timeout: 20000,
    })

    // Autosave's 800ms plus a margin, so "nothing was written" is a fact.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    expect(disk.read('/v/standup.md')).toBe(original)
  })
})

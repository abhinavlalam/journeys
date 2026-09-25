/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { disk, fsModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * **Opening a note must not write to it.**
 *
 * The one file that mounts the **real** editor rather than the textarea stub, and
 * the one that asserts the *bytes* on disk: a note is opened, autosave's window is
 * waited out, and the file has to be byte-identical. Deliberately one case — a
 * real mount is seconds, not milliseconds.
 *
 * The fault it was written for: the previous note pane was a WYSIWYG that appended
 * a paragraph to any document not ending in one, which fired the change listener on
 * mount and saved a re-serialised copy. Bullets changed character, tight lists went
 * loose, and the mtime moved — from *reading* a note. Nothing here parses and
 * regenerates a note now (CLAUDE.md), so that particular fault cannot recur, and
 * this is the guard that would catch the next thing to try it.
 *
 * `matchMedia` is shimmed below, for the real component.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

/**
 * jsdom has no `matchMedia` at all, and CodeMirror's `DOMObserver` calls
 * `matchMedia('print').addListener(...)` in its constructor — so `new EditorView`
 * throws before the editor exists. `addListener` is the deprecated spelling and the
 * one CodeMirror uses; both are here so nothing else has to guess which.
 */
Object.defineProperty(globalThis, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (media: string) => ({
    media,
    matches: false,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

/** jsdom implements no layout and `Range.getClientRects` is missing outright, which
    `prosemirror-virtual-cursor` throws on. One zero-width rect gets past it; no
    assertion here touches a coordinate. See `linkPicker.test.tsx`. */
Range.prototype.getClientRects = () =>
  [{ top: 0, bottom: 14, left: 0, right: 0, width: 0, height: 14 }] as unknown as DOMRectList

afterEach(cleanup)

beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
})

describe('opening a note', () => {
  it('does not rewrite one whose last block is a list', { timeout: 40000 }, async () => {
    const original = disk.read('/v/standup.md')!
    // The default folder's `standup.md` is exactly this shape — prose, then a list.
    expect(original.trimEnd().endsWith('- reviewed the editor')).toBe(true)

    const { default: App } = await import('../App')
    const { getByText } = render(<App />)

    await waitFor(() => expect(getByText('standup')).toBeTruthy(), { timeout: 10000 })
    getByText('standup').click()

    // `.cm-content` is the real editor, mounted: the point of this file is that the
    // assertion below is about a *real* mount and not about a stub.

    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy(), {
      timeout: 20000,
    })

    // Autosave's 800ms plus a margin, so "nothing was written" is a fact rather
    // than a race won.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    expect(disk.read('/v/standup.md')).toBe(original)
  })
})

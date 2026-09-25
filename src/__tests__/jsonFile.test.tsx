/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * A JSON file kept **with** the notes: in the tree, and open in the same pane.
 *
 * **Typing saves it**, like a note: it is a file of the user's, kept as they type,
 * and nothing here parses it before writing. `.config/settings.json` is the one
 * file with a Save, because saving *that* reconfigures the app —
 * `settingsFile.test.tsx` covers it.
 *
 * It is not a note, though, and the rest of the tests here are about that
 * difference. Every piece of note machinery writes YAML frontmatter into the file
 * it acts on — an `icon:`, a `path:` — and frontmatter in a JSON file is a JSON
 * file that no longer parses. So the icon picker is not offered, the `+` is not
 * offered, a move writes no property, and a rename keeps the extension.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

/**
 * The JSON pane is the **real** editor now — the same `EditorHost` a note gets —
 * so these mount CodeMirror, and CodeMirror needs two things jsdom does not have.
 * `matchMedia` is called by `DOMObserver`'s constructor, so `new EditorView` throws
 * without it; `Range.getClientRects` is missing outright. Neither is a layout: no
 * assertion below touches a coordinate.
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

Range.prototype.getClientRects = () =>
  [{ top: 0, bottom: 14, left: 0, right: 0, width: 0, height: 14 }] as unknown as DOMRectList

/** The mounted view for a pane, and the way a test types into it: a transaction,
 *  which is what a keystroke becomes anyway. */
function editor(label: string): EditorView {
  const content = screen.getByLabelText(label)
  const view = EditorView.findFromDOM(content.closest('.cm-editor') as HTMLElement)
  expect(view).toBeTruthy()
  return view!
}

/** A transaction is what a keystroke becomes anyway — but it is dispatched from
 *  outside React, so the state it sets through the change listener has to be
 *  flushed before the next click can see it. */
function type(label: string, text: string) {
  const view = editor(label)
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  })
}

const shown = (label: string) => editor(label).state.doc.toString()

const PRETEND = '{\n  "sizes": [1, 2, 3],\n  "of": "a fictional export"\n}\n'

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  disk.write('/v/sizes.json', PRETEND)
  rememberVault('/v')
})

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

const tree = () => within(document.querySelector('.file-list')!)
const row = () => tree().getByText('sizes.json')
const LABEL = 'sizes.json source'
const field = () => screen.getByLabelText(LABEL)

describe('a JSON file in the vault', () => {
  // With its extension: `sizes.json` and a note called `sizes` are two rows, and a
  // name stripped of `.json` would make them one word twice.
  it('is in the tree, under its whole name', async () => {
    await openApp()
    expect(row()).toBeTruthy()
  })

  it('opens in the reading pane, as its own bytes', async () => {
    await openApp()
    fireEvent.click(row())
    await waitFor(() => expect(field()).toBeTruthy())
    expect(shown(LABEL)).toBe(PRETEND)
    // The markdown editor is not what opened.
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  // No Save and no parse: this is the user's file. Autosave's own 800ms is what
  // the wait below is for, so "it was written" is a fact and not a race won.
  it('is written as it is typed, verbatim, like a note', async () => {
    await openApp()
    fireEvent.click(row())
    await waitFor(() => expect(field()).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()

    const edited = '{ "sizes": [4], "of": "a fictional export" }'
    type(LABEL, edited)
    await waitFor(() => expect(disk.read('/v/sizes.json')).toBe(edited))
  })

  /** Half a JSON file of your own is your business, exactly as half a sentence is.
   *  The app reads none of this file, so there is nothing for it to protect. */
  it('saves what you typed even when it is not valid JSON yet', async () => {
    await openApp()
    fireEvent.click(row())
    await waitFor(() => expect(field()).toBeTruthy())
    type(LABEL, '{ "sizes": [')
    await waitFor(() => expect(disk.read('/v/sizes.json')).toBe('{ "sizes": ['))
  })

})

describe('the note machinery keeps off it', () => {
  it('offers no icon and no note inside it', async () => {
    await openApp()
    expect(screen.queryByLabelText('Icon for sizes.json')).toBeNull()
    expect(screen.queryByLabelText('New note in sizes.json')).toBeNull()
    // A note's row has both.
    expect(screen.getByLabelText('Icon for roadmap')).toBeTruthy()
    expect(screen.getByLabelText('New note in roadmap')).toBeTruthy()
  })

  it('keeps its extension when renamed', async () => {
    await openApp()
    fireEvent.doubleClick(row())
    const input = screen.getByDisplayValue('sizes.json')
    fireEvent.change(input, { target: { value: 'shirt sizes' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(disk.has('/v/shirt sizes.json')).toBe(true))
    expect(disk.read('/v/shirt sizes.json')).toBe(PRETEND)
    expect(disk.has('/v/shirt sizes.md')).toBe(false)
  })

  /** The one that would have corrupted a file: every move rewrites the `path:`
   *  property of what it moved, and that property is YAML. */
  it('is moved without a property being written into it', async () => {
    await openApp()
    const { moveFile } = await import('../vault')
    const moved = await moveFile(
      { path: 'sizes.json', absolutePath: '/v/sizes.json', name: 'sizes.json' },
      '/v',
      'Ideas'
    )
    const { writePathProperty } = await import('../vault')
    await writePathProperty([moved])
    expect(disk.read('/v/Ideas/sizes.json')).toBe(PRETEND)
  })
})

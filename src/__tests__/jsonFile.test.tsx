/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'

/**
 * A JSON file kept with the notes: in the tree, and open in the same pane.
 * Typing saves it, like a note, and nothing parses it first.
 * `.config/settings.json` is the one file with a Save (`settingsFile.test.tsx`).
 *
 * It is not a note, and most of these tests are about that. Note code
 * writes properties (`icon`, `path`) into the file it acts on, and
 * that would break a JSON file. So there is no icon picker and no
 * `+`, a move writes no property, and a rename keeps the extension.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

/**
 * The mounted view for a pane, and how a test types into it: a
 * transaction, which is what a key becomes.
 */
function editor(label: string): EditorView {
  const content = screen.getByLabelText(label)
  const view = EditorView.findFromDOM(content.closest('.cm-editor') as HTMLElement)
  expect(view).toBeTruthy()
  return view!
}

/**
 * A transaction dispatched from outside React, so the state it
 * sets must be flushed before the next click sees it.
 */
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


const tree = () => within(document.querySelector('.file-list')!)
const row = () => tree().getByText('sizes.json')
const LABEL = 'sizes.json source'
const field = () => screen.getByLabelText(LABEL)

describe('a JSON file in the vault', () => {
  // With its extension: `sizes.json` and a note called `sizes` are two rows.
  it('is in the tree, under its whole name', async () => {
    await openApp()
    expect(row()).toBeTruthy()
  })

  it('opens in the reading pane, as its own bytes', async () => {
    await openApp()
    fireEvent.click(row())
    await waitFor(() => expect(field()).toBeTruthy())
    expect(shown(LABEL)).toBe(PRETEND)
    // Not the markdown editor.
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  // No Save and no parse: this is the owner's file. The wait
  // covers autosave's 800ms, so "it was written" is a fact.
  it('is written as it is typed, verbatim, like a note', async () => {
    await openApp()
    fireEvent.click(row())
    await waitFor(() => expect(field()).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()

    const edited = '{ "sizes": [4], "of": "a fictional export" }'
    type(LABEL, edited)
    await waitFor(() => expect(disk.read('/v/sizes.json')).toBe(edited))
  })

  /**
   * Half a JSON file of your own is your business, as half a
   * sentence is. The app reads none of this file.
   */
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

  /**
   * The one that would have corrupted a file: every move
   * rewrites the moved note's `path` property, and that is YAML.
   */
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

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { disk, fsModule, openApp, rememberVault, resetFakeVault } from './fakeVault'

/**
 * Tabs with the real editor under them. Other tab tests use a textarea; these
 * mount CodeMirror to check that a hidden tab keeps its editor and text, that
 * switching away writes it, and that coming back shows what it held.
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
  disk.write('/v/alpha.md', 'alpha text\n')
  disk.write('/v/beta.md', 'beta text\n')
})


const sidebar = () => within(document.querySelector('.sidebar')!)
/** The focused pane's title; there is one per pane. */
const title = () =>
  document.querySelector('.viewer[data-focused="true"]:not([hidden]) .viewer-title')?.textContent ?? null

/** The editor shown, and its text. */
function view(): EditorView {
  const host = document.querySelector(
    '.viewer[data-focused="true"]:not([hidden]) .markdown-editor .cm-editor'
  ) as HTMLElement | null
  expect(host).toBeTruthy()
  return EditorView.findFromDOM(host!)!
}
const shown = () => view().state.doc.toString()

function type(text: string) {
  const v = view()
  act(() => {
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
  })
}

async function open(name: string) {
  fireEvent.click(sidebar().getByText(name))
  await waitFor(() => expect(title()).toBe(name))
  await waitFor(() =>
    expect(
      document.querySelector('.viewer[data-focused="true"]:not([hidden]) .markdown-editor .cm-editor')
    ).toBeTruthy()
  )
}

/**
 * A daily note opens at its end, where the next line goes; any
 * other note below its title.
 */
describe('where the caret starts', () => {
  it('is the end of a daily note, and the top of any other', { timeout: 40000 }, async () => {
    const today = 'icon:: sun\n\n# Monday\n\n08:10 woke\n09:00 #event Standup\n'
    disk.write('/v/Daily/2026-09-28.md', today)
    await openApp()
    fireEvent.click(sidebar().getByText('Daily'))
    await open('2026-09-28')
    await waitFor(() => expect(shown()).toBe(today))
    expect(view().state.selection.main.head).toBe(today.length)

    await open('alpha')
    await waitFor(() => expect(shown()).toBe('alpha text\n'))
    expect(view().state.selection.main.head).toBe(0)
  })
})

/**
 * A tab keeps its undo: its editor stays mounted while hidden,
 * as a terminal's shell does.
 */
describe('undo across a tab switch', () => {
  it('takes back what was typed before the switch', { timeout: 40000 }, async () => {
    await openApp()
    await open('alpha')
    await waitFor(() => expect(shown()).toBe('alpha text\n'))
    type('alpha, edited\n')
    await open('beta')
    await waitFor(() => expect(shown()).toBe('beta text\n'))
    fireEvent.mouseDown(screen.getByRole('tab', { name: /alpha/ }))
    await waitFor(() => expect(shown()).toBe('alpha, edited\n'))

    // Mod-z through the real keymap: ⌘ where CodeMirror sees a Mac, Ctrl elsewhere.
    const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
    fireEvent.keyDown(view().contentDOM, { key: 'z', ...mod })
    expect(shown()).toBe('alpha text\n')
  })
})

describe('a buffer that outlives its editor', () => {
  it('hands the text back when the tab returns, and writes it as the tab leaves', { timeout: 40000 }, async () => {
    await openApp()
    await open('alpha')
    await waitFor(() => expect(shown()).toBe('alpha text\n'))
    type('alpha, edited\n')

    // Away before autosave's 800ms: the write goes out now.
    await open('beta')
    await waitFor(() => expect(disk.read('/v/alpha.md')).toBe('alpha, edited\n'))
    await waitFor(() => expect(shown()).toBe('beta text\n'))

    // And back: the tab shows the text it held, not the first open's.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /alpha/ }))
    await waitFor(() => expect(title()).toBe('alpha'))
    await waitFor(() => expect(shown()).toBe('alpha, edited\n'))
  })

  it('closes the tab of a deleted note wherever it is, and the pane with it', { timeout: 40000 }, async () => {
    await openApp()
    await open('alpha')
    fireEvent.click(screen.getByLabelText('Split right'))
    await waitFor(() => expect(document.querySelectorAll('.pane-group')).toHaveLength(2))
    await open('beta')
    // Delete alpha, open in the other pane, from its row's menu.
    fireEvent.contextMenu(sidebar().getByText('alpha'))
    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(disk.has('/v/alpha.md')).toBe(false))
    await waitFor(() => expect(document.querySelectorAll('.pane-group')).toHaveLength(1))
    expect(screen.queryByRole('tab', { name: /alpha/ })).toBeNull()
    expect(title()).toBe('beta')
  })

  it('renames from the title in one pane while another pane holds a note', { timeout: 40000 }, async () => {
    disk.write('/v/beta.md', 'see [[alpha]]\n')
    await openApp()
    await open('beta')
    fireEvent.click(screen.getByLabelText('Split right'))
    await waitFor(() => expect(document.querySelectorAll('.pane-group')).toHaveLength(2))
    await open('alpha')
    fireEvent.click(document.querySelectorAll('.viewer:not([hidden]) .viewer-title')[1] as HTMLElement)
    const field = screen.getByLabelText('Note name') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'gamma' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(disk.has('/v/gamma.md')).toBe(true))
    // The tab followed the note, and the link in the other pane's note followed too.
    await waitFor(() => expect(screen.getByRole('tab', { name: /gamma/ })).toBeTruthy())
    expect(screen.queryByRole('tab', { name: /^alpha/ })).toBeNull()
    await waitFor(() => expect(disk.read('/v/beta.md')).toBe('see [[gamma]]\n'))
  })
})

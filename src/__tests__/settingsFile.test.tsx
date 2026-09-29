/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'
import { DEFAULT_SETTINGS, parseSettings } from '../settings'
import { SETTINGS_FILE } from '../vaultModel'
import { CONFIG_DIR } from '../vault'

/**
 * `.config/settings.json` edited in the pane. The pane shows the
 * file, and saving goes through the same `parseSettings` as launch,
 * so what the app will not keep is shown back as it was written.
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
 * sets must be flushed before the next click can see it.
 */
function type(label: string, text: string) {
  const view = editor(label)
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  })
}

const shown = (label: string) => editor(label).state.doc.toString()

const CONFIG = `/v/${CONFIG_DIR}/${SETTINGS_FILE}`

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
})


const LABEL = `${SETTINGS_FILE} source`
const field = () => screen.getByLabelText(LABEL)
/** Through Actions → Config, where `.config`'s files are listed. */
const clickRow = async () => {
  // Groups are shut on arrival, as the tree's folders are.
  fireEvent.click(screen.getByLabelText('Expand all actions'))
  const row = await waitFor(() => {
    const found = [...document.querySelectorAll('.sidebar .row-name')].find(
      (name) => name.textContent === SETTINGS_FILE
    )
    expect(found).toBeTruthy()
    return found as HTMLElement
  })
  fireEvent.click(row)
}
const openFile = async () => {
  await clickRow()
  await waitFor(() => expect(field()).toBeTruthy())
}

describe('the pane', () => {
  it('shows the bytes on disk, not the settings in force', async () => {
    // A hand edit the app has not read yet: exactly when someone opens this.
    disk.write(CONFIG, '{\n  "proseSize": 21,\n  "note": "written by hand"\n}\n')
    await openApp()
    await openFile()
    expect(shown(LABEL)).toContain('"note": "written by hand"')
  })

  // Opened over the settings in force instead, its Save wrote them over the file.
  it('does not open a file it cannot read for editing', async () => {
    disk.write(CONFIG, '{\n  "proseSize": 21\n}\n')
    disk.corrupt(CONFIG)
    await openApp()
    await clickRow()
    await screen.findByText(/could not be read, so it has not been opened/)
    expect(screen.queryByLabelText(LABEL)).toBeNull()
    expect(disk.read(CONFIG)).toBe('{\n  "proseSize": 21\n}\n')
  })

  it('stands where the note does, and gives the pane back', async () => {
    await openApp()
    await openFile()
    expect(screen.queryByTestId('editor')).toBeNull()

    // Back to Notes for the tree: opening the file leaves the
    // pane on Actions, where its row is.
    fireEvent.click(await waitFor(() => screen.getByText('roadmap')))
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())
    expect(screen.queryByLabelText(`${SETTINGS_FILE} source`)).toBeNull()
  })
})

describe('saving', () => {
  it('applies the settings and rewrites the file', async () => {
    await openApp()
    await waitFor(() => expect(disk.has(CONFIG)).toBe(true))
    await openFile()

    const edited = { ...DEFAULT_SETTINGS, proseSize: 19, scheme: 'moss' as const }
    type(LABEL, JSON.stringify(edited, null, 2))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // On the page through `applySettings`: the setting reaching
    // the window, not just the state.
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--fs-prose')).toBe('19px')
    )
    // And on disk, after the write's own delay.
    await waitFor(() => expect(parseSettings(disk.read(CONFIG)!).proseSize).toBe(19))
    expect(parseSettings(disk.read(CONFIG)!).scheme).toBe('moss')
  })

  /** A key the app does not keep visibly goes: the pane shows back what it wrote. */
  it('shows back what it kept', async () => {
    await openApp()
    await openFile()
    type(LABEL, JSON.stringify({ ...DEFAULT_SETTINGS, invented: 'nonsense' }, null, 2))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(shown(LABEL)).not.toContain('invented'))
    expect(parseSettings(shown(LABEL))).toEqual(DEFAULT_SETTINGS)
  })

  it('refuses broken JSON, and writes nothing', async () => {
    await openApp()
    await waitFor(() => expect(disk.has(CONFIG)).toBe(true))
    await openFile()
    const before = disk.read(CONFIG)

    type(LABEL, '{ "proseSize": 19,,, }')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByRole('alert').textContent).toMatch(/JSON/i)
    // Still the typed text, so the edit is not lost with the error.
    expect(shown(LABEL)).toBe('{ "proseSize": 19,,, }')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(disk.read(CONFIG)).toBe(before)
  })

  /**
   * The binding is `Mod-s`, which CodeMirror reads per platform: ⌘ on macOS, Ctrl here
   * because jsdom's userAgent is not a Mac. A `metaKey` keydown does nothing in jsdom.
   */
  it('saves on the save chord as well', async () => {
    await openApp()
    await openFile()
    type(LABEL, JSON.stringify({ ...DEFAULT_SETTINGS, lineHeight: 1.6 }, null, 2))
    fireEvent.keyDown(field(), { key: 's', ctrlKey: true })
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--line-height-prose')).toBe('1.6')
    )
  })

  it('offers nothing to save until something is typed', async () => {
    await openApp()
    await openFile()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    type(LABEL, shown(LABEL) + '\n')
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
  })
})

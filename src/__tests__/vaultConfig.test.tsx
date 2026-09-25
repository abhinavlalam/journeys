/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'
import { CONFIG_DIR } from '../vault'
import { DEFAULT_SETTINGS, parseSettings } from '../settings'
import { SETTINGS_FILE } from '../vaultModel'

/**
 * **A vault carries its own settings**, in `.config/settings.json` at its root.
 *
 * The folder is created the first time the app opens a vault, and read every time
 * after — so the theme, the typography, the shortcuts and the daily-notes folder
 * travel with the folder of notes rather than living in this machine's browser
 * storage. `localStorage` keeps the last applied set for the window before a vault
 * is open, which is why both are checked below.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

/** Built from the two names the app uses, so a rename of either is caught here. */
const CONFIG = `/v/${CONFIG_DIR}/${SETTINGS_FILE}`

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
})

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

describe('a vault with no config', () => {
  it('is given one, holding the settings in force', async () => {
    expect(disk.has(CONFIG)).toBe(false)
    await openApp()
    await waitFor(() => expect(disk.has(CONFIG)).toBe(true))
    // Readable as settings, and pretty-printed with a trailing newline: a person
    // may open this file.
    const written = disk.read(CONFIG)!
    expect(written.endsWith('}\n')).toBe(true)
    expect(written).toContain('\n  "mode"')
    expect(parseSettings(written)).toEqual(DEFAULT_SETTINGS)
  })

  // The dot is what keeps it out of the app that wrote it.
  it('does not show the folder in the tree', async () => {
    await openApp()
    await waitFor(() => expect(disk.has(CONFIG)).toBe(true))
    const tree = within(document.querySelector('.file-list')!)
    expect(tree.queryByText(CONFIG_DIR)).toBeNull()
    expect(tree.queryByText('config')).toBeNull()
  })
})

describe('a vault that has one', () => {
  it('is what dresses the window, over anything this machine remembers', async () => {
    localStorage.setItem('journeys:settings', JSON.stringify({ ...DEFAULT_SETTINGS, proseSize: 15 }))
    disk.write(CONFIG, JSON.stringify({ ...DEFAULT_SETTINGS, proseSize: 21, scheme: 'moss' }))
    await openApp()

    // `--fs-prose` is what `applySettings` writes, so this is the setting reaching
    // the page and not just the state.
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--fs-prose')).toBe('21px')
    )
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByRole('button', { name: 'Moss' }).getAttribute('aria-pressed')).toBe('true')
    // And the next launch's first paint, before any vault is open, matches it.
    expect(parseSettings(localStorage.getItem('journeys:settings')).proseSize).toBe(21)
  })

  /** Nonsense reads as the defaults — but the bytes are left alone, because a file
   *  someone is part way through editing by hand must not be overwritten. */
  it('falls back to the defaults without touching a file it cannot read', async () => {
    disk.write(CONFIG, '{ this is not json')
    await openApp()
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--fs-prose')).toBe(
        `${DEFAULT_SETTINGS.proseSize}px`
      )
    )
    expect(disk.read(CONFIG)).toBe('{ this is not json')
  })
})

describe('a setting changed in the panel', () => {
  it('reaches the vault’s file', async () => {
    await openApp()
    await waitFor(() => expect(disk.has(CONFIG)).toBe(true))
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByRole('button', { name: 'Ember' }))
    await waitFor(() => expect(parseSettings(disk.read(CONFIG)!).scheme).toBe('ember'))
  })
})

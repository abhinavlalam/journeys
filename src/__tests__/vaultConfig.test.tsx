/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'
import { CONFIG_DIR } from '../vault'
import { DEFAULT_SETTINGS, parseSettings } from '../settings'
import { SETTINGS_FILE } from '../vaultModel'
import { localDateStamp } from '../clock'

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
const picked = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: picked, confirm: vi.fn(async () => true) }))
const fetched = vi.hoisted(() => vi.fn(async (_url: string) => ''))
vi.mock('../calendarFeed', () => ({ fetchFeed: (url: string) => fetched(url) }))

/** Built from the two names the app uses, so a rename of either is caught here. */
const CONFIG = `/v/${CONFIG_DIR}/${SETTINGS_FILE}`
const OTHER = `/w/${CONFIG_DIR}/${SETTINGS_FILE}`

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  picked.mockResolvedValue(null)
  fetched.mockClear()
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

/**
 * **A vault's calendars and hidden folders are its own.** The settings in force
 * were carried into a vault with no file of its own, secret calendar addresses
 * and all, to be committed to that vault's remote; and until a second vault's
 * file was read, the first one's calendar was synced into its daily notes.
 */
describe('a second vault', () => {
  const FEED = 'https://calendar.example/ical/abc/basic.ics'
  const day = localDateStamp().replace(/-/g, '')
  beforeEach(() => {
    fetched.mockResolvedValue(
      ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:s1', `DTSTART:${day}T093000`, 'SUMMARY:Standup', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
    )
    disk.write(
      CONFIG,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        proseSize: 21,
        graphHides: ['Archive'],
        calendarFeeds: [{ name: 'Work', url: FEED }],
      })
    )
    disk.write('/w/other.md', '# Other\n')
  })

  async function switchTo(path: string) {
    picked.mockResolvedValue(path)
    fireEvent.click(document.querySelector('.vault-name')!)
    await waitFor(() => expect(screen.getByText('other')).toBeTruthy())
  }

  it('is given the settings in force, less the first one’s calendars and hidden folders', async () => {
    await openApp()
    await waitFor(() => expect(fetched).toHaveBeenCalledWith(FEED))
    await switchTo('/w')
    await waitFor(() => expect(disk.has(OTHER)).toBe(true))
    const written = parseSettings(disk.read(OTHER)!)
    expect(written.proseSize).toBe(21)
    expect(written.calendarFeeds).toEqual([])
    expect(written.graphHides).toEqual([])
    // Nor is a calendar's secret address kept outside the vault it belongs to.
    expect(localStorage.getItem('journeys:settings')).not.toContain(FEED)
  })

  it('does not have the first one’s calendar synced into it', async () => {
    disk.write(OTHER, JSON.stringify(DEFAULT_SETTINGS))
    await openApp()
    await waitFor(() => expect(disk.read(`/v/Daily/${localDateStamp()}.md`)).toContain('Standup'))
    fetched.mockClear()
    await switchTo('/w')
    // Long enough for a sync to fetch and write, which in the fake disk is a few ticks.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(fetched).not.toHaveBeenCalled()
    expect(disk.has(`/w/Daily/${localDateStamp()}.md`)).toBe(false)
  })
})

/**
 * **A config file that is there and cannot be read is not absent.** Read as absent,
 * `settings.json` was written over with the settings in force, and
 * `collections.json` — which the calendar asks for `--event` before it syncs — with
 * that one declaration and none of the vault's others.
 */
describe('a config file that cannot be read', () => {
  const COLLECTIONS = `/v/${CONFIG_DIR}/actions/collections.json`

  it('is said, and settings.json is not written over', async () => {
    const mine = JSON.stringify({ ...DEFAULT_SETTINGS, proseSize: 21 })
    disk.write(CONFIG, mine)
    disk.corrupt(CONFIG)
    await openApp()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(SETTINGS_FILE))
    expect(disk.read(CONFIG)).toBe(mine)
  })

  it('is said, and collections.json keeps every declaration', async () => {
    const declared = JSON.stringify({ expense: { structure: '--expense amount::<<>>', fields: ['amount'] } })
    disk.write(COLLECTIONS, declared)
    disk.corrupt(COLLECTIONS)
    disk.write(
      CONFIG,
      JSON.stringify({ ...DEFAULT_SETTINGS, calendarFeeds: [{ name: 'Work', url: 'https://calendar.example/ical/abc/basic.ics' }] })
    )
    await openApp()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be read'))
    expect(disk.read(COLLECTIONS)).toBe(declared)
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

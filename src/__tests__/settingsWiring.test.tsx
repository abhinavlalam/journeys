/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  disk,
  fsModule,
  markdownEditorModule,
  rememberVault,
  resetFakeVault,
} from './fakeVault'
import { localDateStamp } from '../clock'
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from '../settings'

/**
 * The wiring: settings in `App.tsx`, and the two shortcuts reading them.
 * `settings.test.ts` covers what a setting is and `settings-panel.test.tsx` what
 * the panel draws; this covers the seams where the app might use a stale copy:
 * - the window listener is registered once, so a combo read from
 *   its first render would be frozen at launch;
 * - `ensureDailyNote` once had its own `'Daily'`, whatever the setting said;
 * - the panel is modal, so a shortcut firing under it acts on a note no
 *   one is looking at, and firing the action being rebound is worse.
 *
 * The editor is a textarea stub here; the editor's own key is
 * tested with the real editor in `markdownEditor.test.tsx`.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

/**
 * jsdom has no `matchMedia`, and `mode: 'system'` subscribes to it.
 * What is tested here is whether `App`'s effect returns the teardown.
 */
function stubMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>()
  const mql = {
    matches: dark,
    addEventListener: (_type: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => void listeners.delete(fn),
  }
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => mql,
  })
  return {
    get listenerCount() {
      return listeners.size
    },
  }
}

afterEach(() => {
  cleanup()
  const el = document.documentElement
  el.removeAttribute('data-theme')
  el.removeAttribute('data-scheme')
  el.removeAttribute('style')
  Reflect.deleteProperty(globalThis, 'matchMedia')
})

beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
})

/** Settings on disk before the app reads them. */
function remember(settings: Partial<Settings>) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }))
}

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(row('roadmap')).toBeTruthy())
}

const row = (name: string) => within(document.querySelector('.file-list')!).getByText(name)
/** The Settings button in the sidebar. */
const gear = () => within(document.querySelector('.sidebar')!).getByLabelText('Settings')
const dialog = () => document.querySelector('.settings-dialog')
const today = () => localDateStamp()

/**
 * Long enough that "nothing was written" is a fact, not a race
 * won: every step of `mutate` is a microtask on the fake disk.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('settings reaching the app', () => {
  it('opens today’s page on the combo the settings name, and not on the default', async () => {
    remember({
      shortcuts: { openToday: 'mod+alt+j', insertTime: 'mod+shift+t' },
    })
    await openApp()

    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })
    await settle()
    expect(disk.has('/v/Daily')).toBe(false)

    fireEvent.keyDown(window, { key: 'j', metaKey: true, altKey: true })
    await waitFor(() => expect(disk.has(`/v/Daily/${today()}.md`)).toBe(true))
    // Opened, not just created: the shortcut goes through `openNote` either way.
    await waitFor(() => expect(row(today())).toBeTruthy())
  })

  /**
   * The same combo arriving after launch, which a seeded `localStorage`
   * cannot test. The listener is registered once, so a combo read from
   * that render would ignore rebinds until restart. It reads from a ref.
   */
  it('follows a rebind made in the panel, with no relaunch', async () => {
    await openApp()
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    await waitFor(() => expect(dialog()).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }))
    fireEvent.click(screen.getByRole('button', { name: "Open today's page" }))
    fireEvent.keyDown(dialog()!, { key: 'j', metaKey: true, altKey: true })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: "Open today's page" }).textContent).toBe('⌥⌘J')
    )

    fireEvent.keyDown(dialog()!, { key: 'Escape' })
    await waitFor(() => expect(dialog()).toBeNull())

    // The combo it launched with is no longer the shortcut.
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })
    await settle()
    expect(disk.has('/v/Daily')).toBe(false)

    fireEvent.keyDown(window, { key: 'j', metaKey: true, altKey: true })
    await waitFor(() => expect(disk.has(`/v/Daily/${today()}.md`)).toBe(true))
  })

  it('creates today’s page in the folder the settings name', async () => {
    remember({ dailyFolder: 'Logbook' })
    await openApp()

    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })

    await waitFor(() => expect(disk.has(`/v/Logbook/${today()}.md`)).toBe(true))
    expect(disk.has('/v/Daily')).toBe(false)
    // A container of dated notes, not a note with children, as with `Daily/`.
    expect(disk.has(`/v/Logbook/Logbook.md`)).toBe(false)
    await waitFor(() => expect(row(today())).toBeTruthy())
  })

  it('opens the panel from the gear and from ⌘,', async () => {
    await openApp()
    expect(dialog()).toBeNull()

    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())

    // The panel's own Escape, so the next case starts closed.
    fireEvent.keyDown(dialog()!, { key: 'Escape' })
    await waitFor(() => expect(dialog()).toBeNull())

    fireEvent.keyDown(window, { key: ',', metaKey: true })
    await waitFor(() => expect(dialog()).toBeTruthy())
  })

  it('leaves the app’s own shortcuts inert while the panel is open', async () => {
    await openApp()
    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())

    // On the dialog, where a real key lands (the panel has focus). The
    // panel does not stop keys it has no use for, so only `App`'s own
    // guard refuses it. Then on `window`, the same refusal directly.
    fireEvent.keyDown(dialog()!, { key: 'O', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })
    await settle()
    expect(disk.has('/v/Daily')).toBe(false)
    // Still up: nothing behind the dialog moved, and the dialog stayed open.
    expect(dialog()).toBeTruthy()

    // ⌘, does not toggle either; suppressing it keeps capturing
    // a rebind from acting on the combo.
    fireEvent.keyDown(dialog()!, { key: ',', metaKey: true })
    await settle()
    expect(dialog()).toBeTruthy()
  })

  it('applies a change from the panel and remembers it', async () => {
    await openApp()
    // Nothing stored until something changes: writing the defaults at
    // launch would freeze them for anyone who never opens the panel.
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull()
    expect(document.documentElement.getAttribute('data-scheme')).toBe('slate')

    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Moss' }))

    await waitFor(() => expect(document.documentElement.getAttribute('data-scheme')).toBe('moss'))
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).scheme).toBe('moss')
  })

  /**
   * A face chosen after launch: only a change during the session
   * shows the panel's value reaching the page's `--font-prose`.
   */
  it('sends a chosen face to --font-prose, and stores the id and not the stack', async () => {
    await openApp()
    const html = document.documentElement
    expect(html.style.getPropertyValue('--font-prose')).toBe('var(--font-sans), sans-serif')

    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Typography' }))
    fireEvent.change(screen.getByLabelText('Face'), { target: { value: 'charter' } })

    await waitFor(() =>
      expect(html.style.getPropertyValue('--font-prose')).toBe('Charter, var(--font-serif), serif')
    )
    // The id, so a change to the stack reaches someone who already chose the face.
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).fontFamily).toBe('charter')
  })

  /**
   * The row spacing is a token written inline on <html>, which is how it outranks
   * `.file-list button`. Only a change during the session shows the write happening.
   */
  it('sends a gap change to the pane it belongs to', async () => {
    await openApp()
    const html = document.documentElement
    expect(html.style.getPropertyValue('--line-gap')).toBe('calc(0 * var(--line-height-prose) * 1em)')

    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Typography' }))
    fireEvent.change(screen.getByLabelText('Lines'), { target: { value: '0.25' } })

    // `--line-gap` is the note's, below each line; `--row-gap`
    // is the panes' rows. Moving one must not move the other.
    await waitFor(() => expect(html.style.getPropertyValue('--line-gap')).toBe('calc(0.25 * var(--line-height-prose) * 1em)'))
    expect(html.style.getPropertyValue('--row-gap')).toBe('calc(0 * var(--row-h))')
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).lineSpacing).toBe(0.25)
  })

  it('sends a line-height change to the document, with no relaunch', async () => {
    await openApp()
    const html = document.documentElement
    expect(html.style.getPropertyValue('--line-height-prose')).toBe('1.85')

    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Typography' }))
    fireEvent.change(screen.getByLabelText('Line height'), { target: { value: '1.5' } })

    // One token for both panes: a tree row is a line of the note tall.
    await waitFor(() => expect(html.style.getPropertyValue('--line-height-prose')).toBe('1.5'))
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).lineHeight).toBe(1.5)
  })

  /** The vault's agent edits `settings.json` too; read only at open, its change waited for a relaunch. */
  it('takes a change made to settings.json outside the app on a return to the window', async () => {
    await openApp()
    const html = document.documentElement
    await waitFor(() => expect(disk.read('/v/.config/settings.json')).toBeTruthy())
    expect(html.style.getPropertyValue('--line-height-prose')).toBe('1.85')
    const file = JSON.parse(disk.read('/v/.config/settings.json')!)
    disk.write('/v/.config/settings.json', JSON.stringify({ ...file, lineHeight: 1.5 }))
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(html.style.getPropertyValue('--line-height-prose')).toBe('1.5'))
    // A file broken outside is said once, however often the window comes back.
    disk.write('/v/.config/settings.json', '{ not json')
    fireEvent(window, new Event('focus'))
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
    expect(html.style.getPropertyValue('--line-height-prose')).toBe('1.5')
  })

  /**
   * `applySettingsLive` returns a teardown because `mode: 'system'` listens
   * to the OS. Dropping it (`useEffect(() => { applySettingsLive(s) },
   * [s])`, the braces being the difference) leaves a live listener per
   * change, each writing `data-theme` from stale settings.
   */
  it('keeps exactly one OS-theme listener across a change', async () => {
    const media = stubMatchMedia(true)
    remember({ mode: 'system' })
    await openApp()
    expect(media.listenerCount).toBe(1)

    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Moss' }))
    await waitFor(() => expect(document.documentElement.getAttribute('data-scheme')).toBe('moss'))
    fireEvent.click(screen.getByRole('button', { name: 'Ember' }))
    await waitFor(() => expect(document.documentElement.getAttribute('data-scheme')).toBe('ember'))

    expect(media.listenerCount).toBe(1)
  })
})

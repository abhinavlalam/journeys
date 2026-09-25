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
 *
 * `settings.test.ts` owns what a setting *is* and `settings-panel.test.tsx` owns
 * what the panel renders; neither can see the seams this file is about, and every
 * one of them is a seam where the value the app uses is a stale copy:
 *
 * - the window listener is registered once with `[]` deps, so a combo it reads
 *   from that render's closure is frozen at launch;
 * - `ensureDailyNote` used to close over its own `'Daily'`, so the setting could
 *   be anything and the folder would still be `Daily/`;
 * - the panel is modal, so an app shortcut that still fires under it acts on the
 *   note nobody is looking at — and firing the action you are mid-rebind is worse.
 *
 * `Editor` is stubbed as a textarea here; the editor-scope combo needs a real
 * Milkdown and lives in `insertTime.test.tsx`.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

/** jsdom has no `matchMedia`, and `mode: 'system'` subscribes to it. `settings.ts`
 *  is tested against its own copy of this; what is under test here is whether
 *  `App`'s effect returns the teardown it is handed. */
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

/** Settings on disk before the app reads them, which is the only way in: `App`
 *  initialises from `loadSettings()`. */
function remember(settings: Partial<Settings>) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }))
}

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(row('roadmap')).toBeTruthy())
}

const row = (name: string) => within(document.querySelector('.file-list')!).getByText(name)
/** In the footer with the graph and Configure actions — the app's own three
 *  controls — rather than in the header with what changes the vault. */
const gear = () => within(document.querySelector('.sidebar')!).getByLabelText('Settings')
const dialog = () => document.querySelector('.settings-dialog')
const today = () => localDateStamp()

/** Long enough that "nothing was written" is a fact and not a race won: every step
 *  of `mutate` is a microtask on the fake disk. */
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
    // Opened, not merely created — the shortcut goes through `openNote` either way.
    await waitFor(() => expect(row(today())).toBeTruthy())
  })

  /**
   * The same combo, but arriving *after* launch — which is the half a seeded
   * `localStorage` cannot test. The window listener is registered once with `[]`
   * deps, so a combo read from that render's closure holds whatever was stored at
   * launch and a rebind does nothing until the app is restarted. Reading it from a
   * ref is what this pins.
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

    // The combo it was launched with is not the shortcut any more.
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
    // A container of dated notes, not a note with children — as with `Daily/`.
    expect(disk.has(`/v/Logbook/Logbook.md`)).toBe(false)
    await waitFor(() => expect(row(today())).toBeTruthy())
  })

  it('opens the panel from the gear and from ⌘,', async () => {
    await openApp()
    expect(dialog()).toBeNull()

    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())

    // The panel's own Escape, so the next case starts from closed.
    fireEvent.keyDown(dialog()!, { key: 'Escape' })
    await waitFor(() => expect(dialog()).toBeNull())

    fireEvent.keyDown(window, { key: ',', metaKey: true })
    await waitFor(() => expect(dialog()).toBeTruthy())
  })

  it('leaves the app’s own shortcuts inert while the panel is open', async () => {
    await openApp()
    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())

    // On the dialog, because that is where a real keystroke lands — the panel has
    // focus. The panel does not stop a key it has no use for, so the event reaches
    // `window` and only `App`'s own guard can refuse it. Then on `window` itself,
    // which is the same refusal with nothing in between.
    fireEvent.keyDown(dialog()!, { key: 'O', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })
    await settle()
    expect(disk.has('/v/Daily')).toBe(false)
    // Still up: nothing behind the dialog moved, and the dialog did not close.
    expect(dialog()).toBeTruthy()

    // ⌘, does not toggle either. It is suppressed with the rest, which is what
    // keeps *capturing* a rebind from acting on the combo being captured.
    fireEvent.keyDown(dialog()!, { key: ',', metaKey: true })
    await settle()
    expect(dialog()).toBeTruthy()
  })

  it('applies a change from the panel and remembers it', async () => {
    await openApp()
    // Nothing stored until something changes: a copy of the defaults written at
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
   * A face chosen after launch, which is the half a seeded store cannot show:
   * `--font-prose` is written from `Settings`, and only a change made in the
   * session proves the panel's value is what reaches the page.
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
    // The id, so a change to the stack reaches a user who already chose the face.
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).fontFamily).toBe('charter')
  })

  /**
   * The sidebar's row spacing is a *token*, not a class, and it is written inline
   * on <html> with the other four — which is the only way it can outrank
   * `.file-list button`'s (0,1,1). A seeded store cannot see this: the first
   * render already holds the stored value however it is read. Changing it mid
   * session is what shows the write happening.
   */
  it('sends a gap change to the pane it belongs to', async () => {
    await openApp()
    const html = document.documentElement
    expect(html.style.getPropertyValue('--line-gap')).toBe('0px')

    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Typography' }))
    fireEvent.change(screen.getByLabelText('Lines'), { target: { value: '6' } })

    // `--line-gap` is the note's, below each of its lines; `--row-gap` is the
    // panes' rows. Moving one must not move the other — they were one slider.
    await waitFor(() => expect(html.style.getPropertyValue('--line-gap')).toBe('6px'))
    expect(html.style.getPropertyValue('--row-gap')).toBe('0px')
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).lineGap).toBe(6)
  })

  it('sends a line-height change to the document, with no relaunch', async () => {
    await openApp()
    const html = document.documentElement
    expect(html.style.getPropertyValue('--line-height-prose')).toBe('1.85')

    fireEvent.click(gear())
    await waitFor(() => expect(dialog()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Typography' }))
    fireEvent.change(screen.getByLabelText('Line height'), { target: { value: '1.5' } })

    // One token, both panes: a tree row's height is a line of the note.
    await waitFor(() => expect(html.style.getPropertyValue('--line-height-prose')).toBe('1.5'))
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).lineHeight).toBe(1.5)
  })

  /**
   * `applySettingsLive` returns a teardown because `mode: 'system'` subscribes to
   * the OS. Dropping it — `useEffect(() => { applySettingsLive(s) }, [s])`, the
   * braces being the whole difference — leaves one live listener per change, all
   * of them writing `data-theme` from a stale `Settings`.
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

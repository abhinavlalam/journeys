/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, rememberVault, resetFakeVault } from './fakeVault'
import { localDateStamp } from '../clock'
import { readProperty } from '../properties'

/**
 * **What a new note is given the moment it exists**, whichever way it was made.
 *
 * `inheritIcons` was a bulk write at the moment a folder's icon is *set*, and
 * nothing after it: a note made later came out bare, which is how a vault ended up
 * with `Airport/Lakeside Terminal 1` wearing the folder's rocket and
 * `Airport/Harbour City Terminal 1`, made a week later by following a link,
 * wearing nothing. That file had no `path:` either — the link's creation path wrote
 * neither — which is the second half of the same bug.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

/**
 * **The real editor**, because a link is only a thing to press when it is drawn:
 * following one to a note that is not there yet is the creation path this is about,
 * and the stub is a textarea. CodeMirror needs two things jsdom has not — neither
 * is a layout, and no assertion below touches a coordinate.
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

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  // A folder with an icon of its own, nested where the vault this came from keeps
  // it, and a note that links into it by the folder's *name* — the link the report
  // was about: `[[Airport/Harbour City Terminal 1]]` from a daily page,
  // whose head `Airport` resolves to `Entities/Airport` (CLAUDE.md, "a path link's
  // head is a name too").
  disk.write('/v/Entities/Airport/Airport.md', '---\nicon: rocket\n---\n')
  disk.write('/v/Entities/Airport/Lakeside.md', '# Lakeside\n')
  disk.write('/v/roadmap.md', 'taxi to [[Airport/Harbour City Terminal 1]]\n')
})

async function openApp(settings?: Record<string, unknown>) {
  if (settings) disk.write('/v/.config/settings.json', JSON.stringify(settings))
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

const sidebar = () => within(document.querySelector('.sidebar')!)
const tree = () => within(document.querySelector('.pane-section .file-list') as HTMLElement)

/** Open the note carrying the link to a page nobody has written yet. */
async function openTheLinkingNote() {
  fireEvent.click(tree().getByText('roadmap'))
  await waitFor(() => expect(document.querySelector('.cm-md-link')).toBeTruthy())
}

/** Open a folder, so its rows and its `+` are on screen. */
async function openFolder(name: string) {
  fireEvent.click(tree().getByText(name))
  await waitFor(() => expect(sidebar().getByLabelText(`New note in ${name}`)).toBeTruthy())
}

/** A name typed into the folder's own `+`. */
async function makeNoteIn(folder: string, name: string) {
  const plus = sidebar().getByLabelText(`New note in ${folder}`)
  fireEvent.mouseDown(plus)
  fireEvent.click(plus)
  const field = await screen.findByPlaceholderText('Note title…')
  fireEvent.change(field, { target: { value: name } })
  fireEvent.keyDown(field, { key: 'Enter' })
}

describe('a note made in a folder that has an icon', () => {
  it('takes it when the name is typed', { timeout: 40000 }, async () => {
    await openApp()
    await openFolder('Entities')
    await openFolder('Airport')
    await makeNoteIn('Airport', 'Harbour')

    await waitFor(() =>
      expect(readProperty(disk.read('/v/Entities/Airport/Harbour.md') ?? '', 'icon')).toBe('rocket')
    )
    // And it still says where it is.
    expect(readProperty(disk.read('/v/Entities/Airport/Harbour.md') ?? '', 'path')).toBe('Entities/Airport/Harbour')
  })

  /** The path that wrote nothing at all: a link followed to a note that is not
   *  there yet makes one, and it was the one note in the vault with no `path:`. */
  it('takes it when a link is followed to make it', { timeout: 40000 }, async () => {
    await openApp()
    await openTheLinkingNote()
    // A press, not a click: live preview replaces the span between the two, so the
    // browser never generates a click at all — see CLAUDE.md.
    fireEvent.mouseDown(document.querySelector('.cm-md-link')!)

    const made = '/v/Entities/Airport/Harbour City Terminal 1.md'
    // This path wrote *nothing* before: no icon, and no `path:` either.
    await waitFor(() => expect(readProperty(disk.read(made) ?? '', 'icon')).toBe('rocket'))
    expect(readProperty(disk.read(made) ?? '', 'path')).toBe('Entities/Airport/Harbour City Terminal 1')
  })

  it('does not, when the setting is off', { timeout: 40000 }, async () => {
    await openApp({ inheritIcons: false })
    await openFolder('Entities')
    await openFolder('Airport')
    await makeNoteIn('Airport', 'Chennai')

    await waitFor(() => expect(disk.read('/v/Entities/Airport/Chennai.md')).toContain('path:'))
    expect(disk.read('/v/Entities/Airport/Chennai.md')).not.toContain('icon:')
  })

  it('has nothing to take from a folder with no icon', { timeout: 40000 }, async () => {
    disk.write('/v/Plans/Plans.md', '# Plans\n')
    await openApp()
    await openFolder('Plans')
    await makeNoteIn('Plans', 'Q4')
    await waitFor(() => expect(disk.read('/v/Plans/Q4.md')).toContain('path:'))
    expect(disk.read('/v/Plans/Q4.md')).not.toContain('icon:')
  })
})

describe('today’s page', () => {
  /** ⌘⇧O makes a note *for* you: it takes the folder's icon, and no `path:` block
   *  — the app's own words at the top of a page nobody asked it to start. */
  it('takes the daily folder’s icon, and nothing else', async () => {
    disk.write('/v/Daily/Daily.md', '---\nicon: calendar\n---\n')
    await openApp()
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })
    const day = localDateStamp()
    await waitFor(() => expect(readProperty(disk.read(`/v/Daily/${day}.md`) ?? '', 'icon')).toBe('calendar'))
    expect(disk.read(`/v/Daily/${day}.md`)).not.toContain('path:')
  })
})

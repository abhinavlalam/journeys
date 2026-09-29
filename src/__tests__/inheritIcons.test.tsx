/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, openApp, rememberVault, resetFakeVault } from './fakeVault'
import { localDateStamp } from '../clock'
import { readProperty } from '../properties'

/**
 * What a new note is given the moment it exists, however it was made. The folder icon
 * used to be written only when set, so a note made later came out bare:
 * `Airport/Lakeside Terminal 1` had the folder's rocket and `Airport/Harbour City
 * Terminal 1`, made later by following a link, had nothing, and no `path` either.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

/**
 * The real editor, since a link can only be pressed when drawn, and following one
 * to a missing note is the creation path here. No assertion touches a coordinate.
 */
afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  // A folder with its own icon, nested, and a note linking into it by the folder's
  // name: `[[Airport/Harbour City Terminal 1]]` from a daily page, whose head
  // `Airport` resolves to `Entities/Airport` (a path link's head is a name too).
  disk.write('/v/Entities/Airport/Airport.md', '---\nicon: rocket\n---\n')
  disk.write('/v/Entities/Airport/Lakeside.md', '# Lakeside\n')
  disk.write('/v/roadmap.md', 'taxi to [[Airport/Harbour City Terminal 1]]\n')
})


const sidebar = () => within(document.querySelector('.sidebar')!)
const tree = () => within(document.querySelector('.pane-section .file-list') as HTMLElement)

/** Open the note with the link to a page not written yet. */
async function openTheLinkingNote() {
  fireEvent.click(tree().getByText('roadmap'))
  await waitFor(() => expect(document.querySelector('.cm-md-link')).toBeTruthy())
}

/** Open a folder, so its rows and `+` are on screen. */
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

  /**
   * The path that wrote nothing: following a link to a missing
   * note makes one, and it was the one note without a `path`.
   */
  it('takes it when a link is followed to make it', { timeout: 40000 }, async () => {
    await openApp()
    await openTheLinkingNote()
    // A press, not a click: live preview replaces the span in
    // between, so no click fires.
    fireEvent.mouseDown(document.querySelector('.cm-md-link')!)

    const made = '/v/Entities/Airport/Harbour City Terminal 1.md'
    // This path used to write nothing: no icon and no `path`.
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
  /**
   * ⌘⇧O makes a note for you: it takes the folder's icon, but no `path` block,
   * which would be the app's words at the top of a page no one asked it to start.
   */
  it('takes the daily folder’s icon, and nothing else', async () => {
    disk.write('/v/Daily/Daily.md', '---\nicon: calendar\n---\n')
    await openApp()
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })
    const day = localDateStamp()
    await waitFor(() => expect(readProperty(disk.read(`/v/Daily/${day}.md`) ?? '', 'icon')).toBe('calendar'))
    expect(disk.read(`/v/Daily/${day}.md`)).not.toContain('path:')
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'

/**
 * Searching from the left pane. Matching is tested in `search.test.ts`;
 * this is the wiring: where the button is, that the field replaces the
 * tree only once something is typed, and that a result opens its note.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

/**
 * The results list, once it is there. `waitFor` retries only when its
 * callback throws; a callback returning `querySelector(...)!` never failed,
 * so it resolved with `null` at once and the next line threw under load.
 */
function hitList(): HTMLElement {
  const found = document.querySelector('.sidebar-search-hits')
  expect(found).toBeTruthy()
  return found as HTMLElement
}

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
})


const field = () => screen.getByLabelText('Search notes') as HTMLInputElement
/** A tree row: the section's own list stays while a query replaces its rows. */
const tree = () => document.querySelector('.pane-section li.note-row')

describe('the search button', () => {
  // The controls under the vault's name: one set for both sections, search first.
  it('is first in the row of controls, left of the collapse pair', async () => {
    await openApp()
    const controls = document.querySelector('.pane-section .folder-header .folder-actions')!
    expect(
      [...controls.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Search in notes', 'Collapse all notes', 'Expand all notes', 'New note', 'New locked note'])
  })

  it('opens a field without taking the tree off the screen', async () => {
    await openApp()
    expect(screen.queryByLabelText('Search notes')).toBeNull()
    fireEvent.click(screen.getByLabelText('Search in notes'))
    expect(field()).toBeTruthy()
    // Open and empty: the vault stays until the first letter.
    expect(tree()).toBeTruthy()
  })
})

describe('a query', () => {
  it('shows the notes that carry it, with the line it was found on', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Search in notes'))
    fireEvent.change(field(), { target: { value: 'messenger' } })

    const hits = await waitFor(() => hitList())
    expect(within(hits as HTMLElement).getByText('pingbird')).toBeTruthy()
    expect(within(hits as HTMLElement).getByText('What the messenger app got right.')).toBeTruthy()
    // The results take the tree's place while there is something to show.
    expect(tree()).toBeNull()
  })

  it('opens the note a result names', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Search in notes'))
    fireEvent.change(field(), { target: { value: 'messenger' } })
    const hit = await waitFor(() => screen.getByText('pingbird'))
    fireEvent.click(hit)
    await waitFor(() =>
      expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe(
        disk.read('/v/Ideas/pingbird.md')
      )
    )
  })

  it('says so when nothing carries it', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Search in notes'))
    fireEvent.change(field(), { target: { value: 'nothing in this vault says this' } })
    expect(await waitFor(() => screen.getByText('No note says that.'))).toBeTruthy()
    expect(tree()).toBeNull()
  })

  /** A stale query behind a shut field would hide notes for no visible reason. */
  it('is cleared when Escape closes the field', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Search in notes'))
    fireEvent.change(field(), { target: { value: 'messenger' } })
    await waitFor(() => expect(tree()).toBeNull())
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(screen.queryByLabelText('Search notes')).toBeNull()
    expect(tree()).toBeTruthy()
    // And reopening starts empty.
    fireEvent.click(screen.getByLabelText('Search in notes'))
    expect(field().value).toBe('')
  })

  /**
   * Leaving the field also closes it: an idle box should not hold the tree off screen.
   */
  it('closes when the field loses the keyboard', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Search in notes'))
    fireEvent.change(field(), { target: { value: 'messenger' } })
    await waitFor(() => expect(tree()).toBeNull())

    fireEvent.blur(field())
    expect(screen.queryByLabelText('Search notes')).toBeNull()
    expect(tree()).toBeTruthy()
  })

  /**
   * A click on a result must not race the close. The field closes on
   * blur, and a click in the list blurred it first, so the row unmounted
   * before the click landed. The list refuses the focus change instead.
   */
  it('keeps the keyboard in the field when a result is clicked', async () => {
    disk.write('/v/roadmap.md', '# Roadmap\n\nmessenger work\n')
    await openApp()
    fireEvent.click(screen.getByLabelText('Search in notes'))
    fireEvent.change(field(), { target: { value: 'messenger' } })
    const hits = await waitFor(() => hitList())

    const down = fireEvent.mouseDown(hits)
    // `fireEvent` returns false when a handler called `preventDefault`.
    expect(down).toBe(false)

    fireEvent.click(within(hits as HTMLElement).getByText('roadmap'))
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toContain('messenger work')
  })
})

/**
 * One field at a time: search and `+` open the same box in the
 * same place, and clicking one then the other once stacked both.
 */
describe('the two fields', () => {
  const nameField = () => screen.queryByPlaceholderText('Note title…')

  it('are the same element, so the two read as one thing', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Search in notes'))
    expect(field().className).toContain('rename-input')

    fireEvent.blur(field())
    fireEvent.click(screen.getByLabelText('New note'))
    expect(nameField()!.className).toContain('rename-input')
  })

  it('replace each other rather than stacking up', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Search in notes'))
    fireEvent.click(screen.getByLabelText('New note'))
    expect(screen.queryByLabelText('Search notes')).toBeNull()
    expect(nameField()).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Search in notes'))
    expect(nameField()).toBeNull()
    expect(field()).toBeTruthy()
  })

  it('leaves nothing behind when the name field is abandoned', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('New note'))
    fireEvent.change(nameField()!, { target: { value: 'not this one' } })
    fireEvent.blur(nameField()!)

    expect(nameField()).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(disk.has('/v/not this one.md')).toBe(false)
  })
})

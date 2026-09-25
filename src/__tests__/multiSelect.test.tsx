/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * **Picking rows in the left pane, to act on them together.** Picking is not
 * opening — that is the whole ask — so these watch two things at once: what the
 * rows say, and that nothing was opened. `picking.test.ts` holds the model.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  disk.write('/v/alpha.md', '# alpha\n')
  disk.write('/v/beta.md', '# beta\n')
  disk.write('/v/gamma.md', '# gamma\n')
  vi.mocked(confirm).mockClear()
  vi.mocked(confirm).mockResolvedValue(true)
})

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

const sidebar = () => within(document.querySelector('.sidebar')!)
const row = (name: string) => sidebar().getByText(name).closest('button')!
const pickedNames = () =>
  [...document.querySelectorAll('.file-row.picked .row-name')].map((el) => el.textContent)
const tabs = () => [...document.querySelectorAll('[role="tab"] .tab-name')].map((el) => el.textContent)

describe('picking rows', () => {
  it('adds a row on ⌘-click without opening it', async () => {
    await openApp()
    fireEvent.click(row('alpha'), { metaKey: true })
    fireEvent.click(row('beta'), { metaKey: true })
    await waitFor(() => expect(pickedNames()).toEqual(['alpha', 'beta']))
    // Nothing opened: twenty notes picked to delete are not twenty tabs.
    expect(tabs()).toEqual([])
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  it('takes the range on ⇧-click, in the order the tree draws', async () => {
    await openApp()
    fireEvent.click(row('alpha'), { metaKey: true })
    fireEvent.click(row('roadmap'), { shiftKey: true })
    // alpha, beta, gamma, inbox, roadmap at the root — the range is what lies between.
    await waitFor(() => expect(pickedNames()).toEqual(['alpha', 'beta', 'gamma', 'inbox', 'roadmap']))
    expect(tabs()).toEqual([])
  })

  it('opens on a plain click, and that note becomes the whole set', async () => {
    await openApp()
    fireEvent.click(row('alpha'), { metaKey: true })
    fireEvent.click(row('beta'), { metaKey: true })
    await waitFor(() => expect(pickedNames()).toHaveLength(2))

    fireEvent.click(row('gamma'))
    await waitFor(() => expect(tabs()).toEqual(['gamma']))
    expect(pickedNames()).toEqual(['gamma'])
  })
})

describe('deleting a set', () => {
  it('asks once and deletes every picked note', async () => {
    await openApp()
    fireEvent.click(row('alpha'), { metaKey: true })
    fireEvent.click(row('beta'), { metaKey: true })
    fireEvent.click(row('gamma'), { metaKey: true })
    await waitFor(() => expect(pickedNames()).toHaveLength(3))

    fireEvent.contextMenu(row('beta'))
    fireEvent.click(screen.getByText('Delete 3 notes'))

    await waitFor(() => expect(disk.has('/v/alpha.md')).toBe(false))
    expect(disk.has('/v/beta.md')).toBe(false)
    expect(disk.has('/v/gamma.md')).toBe(false)
    // One question for the set, not one per note.
    expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1)
    // The rows are gone, and so is the pick that named them.
    await waitFor(() => expect(sidebar().queryByText('alpha')).toBeNull())
    expect(pickedNames()).toEqual([])
    // What was not picked is untouched.
    expect(disk.has('/v/roadmap.md')).toBe(true)
  })

  it('closes the tab of a picked note that was open', async () => {
    await openApp()
    fireEvent.click(row('alpha'))
    await waitFor(() => expect(tabs()).toEqual(['alpha']))
    // The open note is already the set, so ⌘-click on another adds to it.
    fireEvent.click(row('beta'), { metaKey: true })
    await waitFor(() => expect(pickedNames()).toEqual(['alpha', 'beta']))

    fireEvent.contextMenu(row('alpha'))
    fireEvent.click(screen.getByText('Delete 2 notes'))
    await waitFor(() => expect(tabs()).toEqual([]))
    expect(disk.has('/v/alpha.md')).toBe(false)
  })

  /** One row is one row: the menu it had before picking existed. */
  it('offers the single note’s own menu when nothing else is picked', async () => {
    await openApp()
    fireEvent.click(row('alpha'), { metaKey: true })
    await waitFor(() => expect(pickedNames()).toEqual(['alpha']))
    fireEvent.contextMenu(row('alpha'))
    expect(screen.getByText('Delete')).toBeTruthy()
    expect(screen.getByText('Rename')).toBeTruthy()
  })
})

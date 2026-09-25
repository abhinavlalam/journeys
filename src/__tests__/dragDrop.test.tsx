/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * Dragging a note or a folder to a new home.
 *
 * **Reported from the running app: a note dragged out of a folder could not be
 * dropped at the top of the vault.** Every folder row was a drop target and the
 * root was not one, so there was nowhere for it to land — and nothing here drove a
 * drag, which is why it went unseen.
 *
 * The drop is dispatched directly with a crafted `dataTransfer`: jsdom has no drag
 * of its own, and what these are about is the handler and the move it performs,
 * not the browser's gesture.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

const FILE_MIME = 'application/x-journeys-file'
const FOLDER_MIME = 'application/x-journeys-folder'

/** What a row puts on the drag: the payload, and — for a folder — its path as a
 *  MIME suffix, because `dragover` may read the type list and nothing else. */
const carrying = (mime: string, payload: unknown, marker?: string) => ({
  types: marker ? [mime, `${mime}+${marker}`] : [mime],
  getData: (asked: string) => (asked === mime ? JSON.stringify(payload) : ''),
})

const file = (path: string) => ({
  path,
  absolutePath: `/v/${path}`,
  name: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
})

const folder = (path: string) => ({
  path,
  absolutePath: `/v/${path}`,
  name: path.split('/').pop() ?? path,
  folders: [],
  files: [],
})

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

const tree = () => document.querySelector('.file-list') as HTMLElement
const rowFor = (name: string) =>
  within(tree()).getByText(name).closest('.folder-header, button') as HTMLElement

describe('dropping on the root', () => {
  it('moves a note out of a folder and up to the top', async () => {
    await openApp()
    fireEvent.drop(tree(), { dataTransfer: carrying(FILE_MIME, file('Ideas/pingbird.md')) })

    await waitFor(() => expect(disk.has('/v/pingbird.md')).toBe(true))
    expect(disk.has('/v/Ideas/pingbird.md')).toBe(false)
    // The bytes are the note's own; the move rewrites only its `path:`.
    expect(disk.read('/v/pingbird.md')).toContain('# Pingbird')
  })

  it('moves a nested note — a folder and its own note — up to the top', async () => {
    disk.write('/v/Areas/Northwind/Northwind.md', '# Northwind\n')
    disk.write('/v/Areas/Northwind/plan.md', '# Plan\n')
    await openApp()

    fireEvent.drop(tree(), {
      dataTransfer: carrying(FOLDER_MIME, folder('Areas/Northwind'), 'areas/northwind'),
    })

    await waitFor(() => expect(disk.has('/v/Northwind/Northwind.md')).toBe(true))
    /**
     * Everything inside came along, **and says where it now is**: a folder that
     * moves rewrites the `path:` of every note under it.
     *
     * This asserted `'# Plan\n'` — the child untouched — which was the bug and not
     * the design. `renameFolder` and `moveFolder` hand back `{...folder, path}`,
     * whose children still carry the paths they had before the move, so
     * `writePathProperty` was handed a note that was no longer there and wrote
     * nothing. `mutate` passes the walked tree now, and `relocateFolder` reads the
     * folder out of that.
     */
    expect(disk.read('/v/Northwind/plan.md')).toBe(
      '---\npath: Northwind/plan\n---\n\n# Plan\n'
    )
    expect(disk.has('/v/Areas/Northwind')).toBe(false)
  })

  it('says so while a drag is over it', async () => {
    await openApp()
    fireEvent.dragOver(tree(), { dataTransfer: carrying(FILE_MIME, file('Ideas/pingbird.md')) })
    expect(tree().classList.contains('drag-over')).toBe(true)
    fireEvent.dragLeave(tree())
    expect(tree().classList.contains('drag-over')).toBe(false)
  })
})

/**
 * **A note dropped on a plain note goes inside it, and the plain note becomes a
 * nested one.** It took files from outside first and refused the vault's own notes,
 * on the grounds that a note dragged onto a note had no meaning yet. Asked for as
 * "I want to be able to move notes under any other note; a note should just
 * automatically convert." The conversion and the move are one mutation, so the tree
 * is never drawn with the target converted and the note still outside it.
 */
describe('dropping on a plain note', () => {
  const noteRow = (name: string) => within(tree()).getByText(name).closest('button') as HTMLElement

  it('converts the note and files the dropped note inside it', async () => {
    await openApp()
    fireEvent.drop(noteRow('roadmap'), {
      dataTransfer: carrying(FILE_MIME, file('inbox.md'), 'inbox.md'),
    })
    // `roadmap` is a folder with its own note now, and `inbox` is in it.
    await waitFor(() => expect(disk.has('/v/roadmap/inbox.md')).toBe(true))
    expect(disk.has('/v/roadmap/roadmap.md')).toBe(true)
    expect(disk.has('/v/roadmap.md')).toBe(false)
    expect(disk.has('/v/inbox.md')).toBe(false)
    // Both know where they are: the target through `convertNote`, the dragged note
    // through the same relocate every other move uses.
    expect(disk.read('/v/roadmap/roadmap.md')).toContain('path: roadmap')
    expect(disk.read('/v/roadmap/inbox.md')).toContain('path: roadmap/inbox')
  })

  it('takes a nested note too, whole', async () => {
    await openApp()
    fireEvent.drop(noteRow('roadmap'), {
      dataTransfer: carrying(FOLDER_MIME, folder('Ideas'), 'ideas'),
    })
    await waitFor(() => expect(disk.has('/v/roadmap/Ideas/Ideas.md')).toBe(true))
    expect(disk.has('/v/roadmap/Ideas/pingbird.md')).toBe(true)
    expect(disk.has('/v/Ideas/Ideas.md')).toBe(false)
  })

  /** A note cannot be dropped on itself. Refused at `dragover`, so the row does not
   *  light up for a drop it would not take — the path rides on the drag as a type
   *  suffix, since the payload is unreadable until the drop. */
  it('refuses the note the drag started on', async () => {
    await openApp()
    const row = noteRow('roadmap')
    const self = carrying(FILE_MIME, file('roadmap.md'), 'roadmap.md')
    fireEvent.dragOver(row, { dataTransfer: self })
    expect(row.classList.contains('drag-over')).toBe(false)
    fireEvent.drop(row, { dataTransfer: self })
    // Nothing moved and nothing converted.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(disk.has('/v/roadmap.md')).toBe(true)
    expect(disk.has('/v/roadmap/roadmap.md')).toBe(false)
  })
})

describe('dropping on a folder', () => {
  it('moves a note into it', async () => {
    await openApp()
    fireEvent.drop(rowFor('Ideas'), { dataTransfer: carrying(FILE_MIME, file('roadmap.md')) })
    await waitFor(() => expect(disk.has('/v/Ideas/roadmap.md')).toBe(true))
    expect(disk.has('/v/roadmap.md')).toBe(false)
  })

  /** A folder cannot be dropped into itself or its own subtree: the move would be
   *  a folder trying to contain itself, and the vault refuses it anyway. */
  it('refuses its own subtree', async () => {
    disk.write('/v/Areas/Health/Health.md', '# Health\n')
    await openApp()
    fireEvent.click(within(tree()).getByLabelText('Expand Areas'))

    fireEvent.drop(rowFor('Health'), {
      dataTransfer: carrying(FOLDER_MIME, folder('Areas'), 'areas'),
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(disk.has('/v/Areas/Health/Areas')).toBe(false)
    expect(disk.has('/v/Areas/Health/Health.md')).toBe(true)
  })
})

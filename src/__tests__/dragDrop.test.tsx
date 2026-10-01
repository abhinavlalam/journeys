/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault, vaultFile as file } from './fakeVault'
import { readProperty } from '../properties'

/**
 * Dragging a note or a folder to a new place. A note dragged out of a folder
 * could not be dropped at the top of the vault: every folder row was a drop
 * target and the root was not. The drop is dispatched directly with a made-up
 * `dataTransfer`, since jsdom has no drag; these test the handler and the move.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

const FILE_MIME = 'application/x-journeys-file'
const FOLDER_MIME = 'application/x-journeys-folder'

/**
 * What a row puts on the drag: the payload and, for a folder, its path
 * as a MIME suffix, since `dragover` can read only the type list.
 */
const carrying = (mime: string, payload: unknown, marker?: string) => ({
  types: marker ? [mime, `${mime}+${marker}`] : [mime],
  getData: (asked: string) => (asked === mime ? JSON.stringify(payload) : ''),
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


const tree = () => document.querySelector('.file-list') as HTMLElement
const rowFor = (name: string) =>
  within(tree()).getByText(name).closest('.folder-header, button') as HTMLElement

describe('dropping on the root', () => {
  it('moves a note out of a folder and up to the top', async () => {
    await openApp()
    fireEvent.drop(tree(), { dataTransfer: carrying(FILE_MIME, file('Ideas/pingbird.md')) })

    await waitFor(() => expect(disk.has('/v/pingbird.md')).toBe(true))
    expect(disk.has('/v/Ideas/pingbird.md')).toBe(false)
    // The note's bytes are its own; the move rewrites only its `path`.
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
     * Everything inside came along and says where it is: a folder move rewrites
     * the `path` of every note under it. `renameFolder` and `moveFolder` return
     * the folder with its children's old paths, so `mutate` passes the walked
     * tree and `relocateFolder` reads the folder from that.
     */
    expect(disk.read('/v/Northwind/plan.md')).toBe('path:: Northwind/plan\n\n# Plan\n')
    expect(disk.has('/v/Areas/Northwind')).toBe(false)
  })

  /** A drop where it already is moves nothing, and writes nothing: a `path::` once went
   *  into every note under a folder dropped back onto its own place, dailies included. */
  it('writes nothing for a drop where the note or folder already is', async () => {
    disk.write('/v/Daily/2026-09-01.md', 'the day\n')
    await openApp()
    const before = disk.read('/v/roadmap.md')
    fireEvent.drop(tree(), { dataTransfer: carrying(FILE_MIME, file('roadmap.md')) })
    fireEvent.drop(tree(), { dataTransfer: carrying(FOLDER_MIME, folder('Daily'), 'daily') })
    await new Promise((settle) => setTimeout(settle, 300))
    expect(disk.read('/v/Daily/2026-09-01.md')).toBe('the day\n')
    expect(disk.read('/v/roadmap.md')).toBe(before)
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
 * A note dropped on a plain note goes inside it, and the plain note becomes nested.
 * The conversion and the move are one change, so the tree is never drawn half done.
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
    // Both know where they are: the target through `convertNote`,
    // the dragged note through the usual relocate.
    expect(readProperty(disk.read('/v/roadmap/roadmap.md') ?? '', 'path')).toBe('roadmap')
    expect(readProperty(disk.read('/v/roadmap/inbox.md') ?? '', 'path')).toBe('roadmap/inbox')
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

  /**
   * A note cannot be dropped on itself. Refused at `dragover`,
   * so the row does not light up; the path rides as a type
   * suffix since the payload is unreadable until the drop.
   */
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

  /** A folder cannot be dropped into itself or its subtree. */
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

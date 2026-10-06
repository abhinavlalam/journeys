/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'
import { readProperty } from '../properties'

/**
 * A vault is a folder of files, and the tree shows them: PDFs, photos and exports sit
 * beside the notes. The pane shows what it can and says when it cannot. `files.test.ts`
 * covers what a file is and how a delimited one is coloured; this drives the app.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))
// A CSV's editor is the real CodeMirror, which jsdom cannot lay
// out. What a CSV tab is comes from the model.
vi.mock('../SourceEditor', () => ({
  SourceEditor: ({ kind, initialText }: { kind: string; initialText: string }) => (
    <div data-testid={kind}>{initialText}</div>
  ),
}))

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  disk.write('/v/deck.pdf', '%PDF-1.7 pretend')
  disk.write('/v/whiteboard.png', 'pretend pixels')
  disk.write('/v/spend.csv', 'day,amount\n2026-09-18,480\n')
  disk.write('/v/archive.zip', 'pretend')
})


const sidebar = () => within(document.querySelector('.sidebar')!)
const title = () => document.querySelector('.viewer:not([hidden]) .viewer-title')?.textContent ?? null
const tabs = () => [...document.querySelectorAll('[role="tab"] .tab-name')].map((el) => el.textContent)

describe('the tree', () => {
  it('lists every file, extension and all', async () => {
    await openApp()
    for (const name of ['deck.pdf', 'whiteboard.png', 'spend.csv', 'archive.zip']) {
      expect(sidebar().getByText(name), name).toBeTruthy()
    }
  })
})

describe('the reading pane', () => {
  it('shows an image, and writes nothing', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('whiteboard.png'))
    await waitFor(() => expect(title()).toBe('whiteboard.png'))
    const image = document.querySelector('img.file-image') as HTMLImageElement
    expect(image).toBeTruthy()
    expect(image.getAttribute('src')).toContain('whiteboard.png')
    // No editor and no buffer: the bytes stay as they were.
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(disk.read('/v/whiteboard.png')).toBe('pretend pixels')
  })

  it('shows a PDF in a frame of its own', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('deck.pdf'))
    await waitFor(() => expect(title()).toBe('deck.pdf'))
    const frame = document.querySelector('iframe.file-frame') as HTMLIFrameElement
    expect(frame).toBeTruthy()
    expect(frame.getAttribute('src')).toContain('deck.pdf')
  })

  it('says so for a file it has nothing to say about, and offers Finder', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('archive.zip'))
    await waitFor(() => expect(title()).toBe('archive.zip'))
    expect(screen.getByText(/archive\.zip is not a kind of file this app shows/)).toBeTruthy()
    expect(screen.getByText('Reveal in Finder')).toBeTruthy()
  })

  it('opens a CSV as its own text, in the editor that colours its columns', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('spend.csv'))
    await waitFor(() => expect(title()).toBe('spend.csv'))
    await waitFor(() => expect(screen.getByTestId('csv').textContent).toBe('day,amount\n2026-09-18,480\n'))
  })

  /** A file tab is a tab: it sits beside the notes and follows its file. */
  it('opens beside a note, and closes when the file is deleted', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('roadmap'))
    await waitFor(() => expect(tabs()).toEqual(['roadmap']))
    fireEvent.click(sidebar().getByText('deck.pdf'))
    await waitFor(() => expect(tabs()).toEqual(['roadmap', 'deck.pdf']))

    fireEvent.contextMenu(sidebar().getByText('deck.pdf'))
    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(disk.has('/v/deck.pdf')).toBe(false))
    await waitFor(() => expect(tabs()).toEqual(['roadmap']))
  })
})

/**
 * A file moves the way a note does: the same drag, targets and
 * `moveFile`. Only a note's own parts (its `path` and links) are
 * rewritten, and only for files that have them.
 */
describe('moving a file that is not a note', () => {
  const FILE_MIME = 'application/x-journeys-file'
  const tree = () => document.querySelector('.pane-section .file-list') as HTMLElement
  const rowFor = (name: string) =>
    [...tree().querySelectorAll('.folder-header')].find((row) => row.textContent?.startsWith(name))!

  it('drags into a folder, keeping its bytes and its name', async () => {
    await openApp()
    const carried = {
      path: 'deck.pdf',
      absolutePath: '/v/deck.pdf',
      name: 'deck.pdf',
    }
    fireEvent.drop(rowFor('Ideas'), {
      dataTransfer: {
        types: [FILE_MIME],
        getData: (asked: string) => (asked === FILE_MIME ? JSON.stringify(carried) : ''),
      },
    })
    await waitFor(() => expect(disk.has('/v/Ideas/deck.pdf')).toBe(true))
    expect(disk.has('/v/deck.pdf')).toBe(false)
    // Its bytes are its own: a move writes no `path` into a file that is not a note.
    expect(disk.read('/v/Ideas/deck.pdf')).toBe('%PDF-1.7 pretend')
  })
})

/**
 * A file dragged in from outside is filed where it is dropped. The webview's default is
 * to open a dropped file in place of the app, so a PDF that missed the left pane
 * replaced everything. Now nothing outside a drop target acts, and a target copies.
 */
describe('a file dragged in from outside', () => {
  const dropping = (...files: File[]) => ({
    types: ['Files'],
    files,
    getData: () => '',
  })
  const tree = () => document.querySelector('.pane-section .file-list') as HTMLElement
  const rowFor = (name: string) =>
    [...tree().querySelectorAll('.folder-header')].find((row) => row.textContent?.startsWith(name))!

  it('copies it into the folder it was dropped on', async () => {
    await openApp()
    fireEvent.drop(rowFor('Ideas'), {
      dataTransfer: dropping(new File(['%PDF pretend'], 'lease.pdf', { type: 'application/pdf' })),
    })
    await waitFor(() => expect(disk.read('/v/Ideas/lease.pdf')).toBe('%PDF pretend'))
    // And it is a row, once its folder is open.
    fireEvent.click(within(tree()).getByText('Ideas'))
    await waitFor(() => expect(within(tree()).getByText('lease.pdf')).toBeTruthy())
  })

  it('copies several onto the vault itself', async () => {
    await openApp()
    fireEvent.drop(tree(), {
      dataTransfer: dropping(
        new File(['one'], 'a.png', { type: 'image/png' }),
        new File(['two'], 'b.png', { type: 'image/png' })
      ),
    })
    await waitFor(() => expect(disk.read('/v/a.png')).toBe('one'))
    expect(disk.read('/v/b.png')).toBe('two')
  })

  /**
   * A failed copy is not one that was already there. When both were one list and every
   * write was refused, the app said "already in the vault" for files it never wrote.
   */
  it('says a refused copy failed, and does not claim the file is there', async () => {
    await openApp()
    disk.forbid('/v/', 'no writing here')
    fireEvent.drop(tree(), {
      dataTransfer: dropping(new File(['pixels'], 'new.png', { type: 'image/png' })),
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not copy new.png'))
    expect(screen.getByRole('alert').textContent).not.toContain('already here')
    expect(disk.has('/v/new.png')).toBe(false)
  })

  /**
   * Never over an existing file: a same-named file is reported
   * and the one on disk is left alone.
   */
  it('refuses to copy over a file already there, and says which', async () => {
    await openApp()
    fireEvent.drop(tree(), {
      dataTransfer: dropping(new File(['different'], 'deck.pdf', { type: 'application/pdf' })),
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('deck.pdf'))
    expect(disk.read('/v/deck.pdf')).toBe('%PDF-1.7 pretend')
  })
})

/**
 * A file dropped on a plain note gives that note children: the note
 * becomes a folder with its own note, as the row's `+` does for a typed
 * name. A PDF dropped on a note once landed at the top of the vault.
 */
describe('a file dropped on a note', () => {
  const dropping = (...files: File[]) => ({ types: ['Files'], files, getData: () => '' })
  const tree = () => document.querySelector('.pane-section .file-list') as HTMLElement
  const rowFor = (name: string) =>
    within(tree()).getByText(name).closest('button') as HTMLElement

  it('makes it a nested note and puts the file inside', async () => {
    await openApp()
    fireEvent.drop(rowFor('roadmap'), {
      dataTransfer: dropping(new File(['%PDF plan'], 'plan.pdf', { type: 'application/pdf' })),
    })

    // The note became a folder with its own note inside…
    await waitFor(() => expect(disk.has('/v/roadmap/roadmap.md')).toBe(true))
    expect(disk.has('/v/roadmap.md')).toBe(false)
    // …and the file is in there with it.
    expect(disk.read('/v/roadmap/plan.pdf')).toBe('%PDF plan')
    // The moved note knows where it is now.
    expect(readProperty(disk.read('/v/roadmap/roadmap.md') ?? '', 'path')).toBe('roadmap')
  })

  /**
   * And the tab follows it. Converting a note moved the buffer
   * but left the tab on a missing file.
   */
  it('carries the open tab with it', async () => {
    await openApp()
    fireEvent.click(within(tree()).getByText('roadmap'))
    await waitFor(() => expect(tabs()).toEqual(['roadmap']))

    fireEvent.drop(rowFor('roadmap'), {
      dataTransfer: dropping(new File(['%PDF plan'], 'plan.pdf', { type: 'application/pdf' })),
    })
    await waitFor(() => expect(disk.has('/v/roadmap/roadmap.md')).toBe(true))
    // One tab, still open, still the same note, at its new path.
    expect(tabs()).toEqual(['roadmap'])
    expect(screen.getByRole('tab', { name: /roadmap/ }).getAttribute('title')).toBe(
      'roadmap/roadmap.md'
    )
  })

  /**
   * A file that is not a note cannot hold one: the drop falls
   * through to the tree, the vault itself.
   */
  it('falls through to the vault when the row is not a note', async () => {
    await openApp()
    fireEvent.drop(rowFor('deck.pdf'), {
      dataTransfer: dropping(new File(['pixels'], 'scan.png', { type: 'image/png' })),
    })
    await waitFor(() => expect(disk.read('/v/scan.png')).toBe('pixels'))
    expect(disk.has('/v/deck/scan.png')).toBe(false)
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FolderTree } from '../FolderTree'
import type { VaultFolder } from '../vaultModel'
import { vaultFile as file } from './fakeVault'

/**
 * Rename in place from a row. File and folder rows share `useRename`.
 * What must hold: blur commits here (create rows cancel), the field
 * opens prefilled and selected, and Escape drops the edit.
 */

const projects: VaultFolder = {
  path: 'Notes/Projects',
  absolutePath: '/v/Notes/Projects',
  name: 'Projects',
  folders: [],
  files: [],
}

const root: VaultFolder = {
  path: 'Notes',
  absolutePath: '/v/Notes',
  name: 'Notes',
  folders: [projects],
  files: [file('Notes/inbox.md')],
}

const handlers = {
  onSetFolderIcon: vi.fn(),
  onSetFileIcon: vi.fn(),
  onSelectFile: vi.fn(),
  onDeletePicked: vi.fn(),
  onImportFiles: vi.fn(),
  onImportFilesInside: vi.fn(),
  onAdoptFile: vi.fn(),
  onAdoptFolder: vi.fn(),
  onNewNote: vi.fn(),
  onSelectFolderNote: vi.fn(),
  onMoveFile: vi.fn(),
  onMoveFolder: vi.fn(),
  onRenameFile: vi.fn(),
  onRenameFolder: vi.fn(),
  onNewNoteInside: vi.fn(),
  onDeleteFile: vi.fn(),
  onDeleteFolder: vi.fn(),
  onReveal: vi.fn(),
  onToggleFolder: vi.fn(),
}

function tree() {
  render(
    <ul>
      <FolderTree
        folder={root}
        depth={0}
        create={null}
        unlock={null}
        selectedPath={null}
        openFolders={new Set<string>()}
        icons={{}}
        {...handlers}
        picked={new Set<string>()}
        where="tree"
      />
    </ul>
  )
}

const input = () => document.querySelector('.rename-input') as HTMLInputElement

afterEach(cleanup)
beforeEach(() => {
  for (const fn of Object.values(handlers)) fn.mockClear()
})

describe('renaming a file row', () => {
  it('opens prefilled on double-click and commits on blur', () => {
    tree()
    fireEvent.doubleClick(screen.getByText('inbox'))

    expect(input().value).toBe('inbox')
    // Prefilled with the whole name selected, so typing replaces it.
    expect(input().selectionStart).toBe(0)
    expect(input().selectionEnd).toBe('inbox'.length)

    fireEvent.change(input(), { target: { value: '  reading list  ' } })
    fireEvent.blur(input())

    // Trimmed, and the row is back.
    expect(handlers.onRenameFile).toHaveBeenCalledWith(root.files[0], 'reading list')
    expect(screen.getByText('inbox')).toBeTruthy()
  })

  it('commits on Enter', () => {
    tree()
    fireEvent.doubleClick(screen.getByText('inbox'))
    fireEvent.change(input(), { target: { value: 'reading' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(handlers.onRenameFile).toHaveBeenCalledWith(root.files[0], 'reading')
  })

  it('throws the edit away on Escape', () => {
    tree()
    fireEvent.doubleClick(screen.getByText('inbox'))
    fireEvent.change(input(), { target: { value: 'reading' } })
    fireEvent.keyDown(input(), { key: 'Escape' })

    expect(handlers.onRenameFile).not.toHaveBeenCalled()
    expect(screen.getByText('inbox')).toBeTruthy()

    // And the next rename starts from the name on disk, not the abandoned draft.
    fireEvent.doubleClick(screen.getByText('inbox'))
    expect(input().value).toBe('inbox')
  })

  it('writes nothing for a blank or unchanged name', () => {
    tree()
    fireEvent.doubleClick(screen.getByText('inbox'))
    fireEvent.change(input(), { target: { value: '   ' } })
    fireEvent.blur(input())
    expect(handlers.onRenameFile).not.toHaveBeenCalled()

    fireEvent.doubleClick(screen.getByText('inbox'))
    fireEvent.blur(input())
    expect(handlers.onRenameFile).not.toHaveBeenCalled()
  })
})

/**
 * A double click on a nested note renamed for a moment and then gave up,
 * and the folder flickered. The browser sends click, click, dblclick, so
 * the second click is part of the rename and does nothing, while the
 * first still opens (waiting for a second would slow every note).
 */
describe('a double click on a row that also acts on one', () => {
  /** click, click, dblclick: the sequence a browser sends, `detail` and all. */
  function doubleClick(target: HTMLElement) {
    fireEvent.click(target, { detail: 1 })
    fireEvent.click(target, { detail: 2 })
    fireEvent.doubleClick(target, { detail: 2 })
  }

  it('opens and toggles a folder row once, not twice', () => {
    tree()
    doubleClick(screen.getByText('Projects'))

    expect(handlers.onSelectFolderNote).toHaveBeenCalledTimes(1)
    expect(handlers.onToggleFolder).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('Projects')
  })

  it('opens a file row once', () => {
    tree()
    doubleClick(screen.getByText('inbox'))

    expect(handlers.onSelectFile).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('inbox')
  })
})

describe('renaming a folder row', () => {
  it('keeps its own class, which the sheet styles separately', () => {
    tree()
    fireEvent.doubleClick(screen.getByText('Projects'))

    // `rename-in-row` is on every rename, keeping the row's
    // height; the folder's own class comes with it, for the width.
    expect(input().className).toBe('rename-input rename-in-row folder-rename-input')
    fireEvent.change(input(), { target: { value: 'Work' } })
    fireEvent.blur(input())
    expect(handlers.onRenameFolder).toHaveBeenCalledWith(projects, 'Work')
  })
})

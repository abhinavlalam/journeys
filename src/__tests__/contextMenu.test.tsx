/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FolderTree } from '../FolderTree'
import type { VaultFile, VaultFolder } from '../vaultModel'

/**
 * The right-click menu, driven from the tree. `useContextMenu` owns the
 * position, the `preventDefault` and the node; `ContextMenu` the clamp
 * and both ways of closing. Pinned: the position, the clamp inside the
 * window, Escape, click-away, and one menu after a second right-click.
 */
const file = (name: string): VaultFile => ({
  path: `${name}.md`,
  absolutePath: `/v/${name}.md`,
  name,
})

const ideas: VaultFolder = {
  path: 'Ideas',
  absolutePath: '/v/Ideas',
  name: 'Ideas',
  folders: [],
  files: [file('Ideas/pingbird')],
  note: file('Ideas/Ideas'),
}

const root: VaultFolder = {
  path: '',
  absolutePath: '/v',
  name: 'v',
  folders: [ideas],
  files: [file('roadmap'), file('inbox')],
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
  onSelectFolderNote: vi.fn(),
  onNewNote: vi.fn(),
  onMoveFile: vi.fn(),
  onMoveFolder: vi.fn(),
  onRenameFile: vi.fn(),
  onRenameFolder: vi.fn(),
  onNewNoteInside: vi.fn(),
  onDeleteFile: vi.fn(),
  onDeleteFolder: vi.fn(),
  onReveal: vi.fn(),
}

function tree(icons: Record<string, string> = {}) {
  render(
    <ul className="file-list">
      <FolderTree
        folder={root}
        depth={0}
        create={null}
        unlock={null}
        selectedPath={null}
        openFolders={new Set()}
        onToggleFolder={vi.fn()}
        icons={icons}
        {...handlers}
        picked={new Set<string>()}
        where="tree"
      />
    </ul>
  )
}

const row = (name: string) => screen.getByText(name)
const menus = () => document.querySelectorAll('.context-menu')

afterEach(() => {
  cleanup()
  for (const handler of Object.values(handlers)) handler.mockClear()
})

describe('a row context menu', () => {
  it('opens where the click was, and takes the gesture from the OS', () => {
    tree()
    // `fireEvent` returns false when the event was cancelled: the
    // `preventDefault` that keeps the webview's own menu away.
    expect(fireEvent.contextMenu(row('roadmap'), { clientX: 40, clientY: 60 })).toBe(false)

    const menu = document.querySelector('.context-menu') as HTMLElement
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('60px')
    expect(screen.getByText('Rename')).toBeTruthy()
    expect(screen.getByText('Delete')).toBeTruthy()
  })

  // Why ContextMenu measures itself in a layout effect: a right-click
  // near the sidebar's bottom put Delete off-screen. jsdom reports a
  // zero box, so the clamp lands on the margin alone.
  it('is pulled back inside the window', () => {
    tree()
    fireEvent.contextMenu(row('roadmap'), { clientX: 5000, clientY: 5000 })

    const menu = document.querySelector('.context-menu') as HTMLElement
    expect(menu.style.top).toBe(`${window.innerHeight - 8}px`)
    expect(menu.style.left).toBe(`${window.innerWidth - 8}px`)
  })

  it('closes on Escape', () => {
    tree()
    fireEvent.contextMenu(row('roadmap'))
    expect(menus()).toHaveLength(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(menus()).toHaveLength(0)
  })

  it('closes on a click away', () => {
    tree()
    fireEvent.contextMenu(row('roadmap'))
    fireEvent.mouseDown(document.body)
    expect(menus()).toHaveLength(0)
  })

  it('closes when its own item is chosen, and acts on the row it belongs to', () => {
    tree()
    fireEvent.contextMenu(row('inbox'))
    fireEvent.click(screen.getByText('Delete'))

    expect(menus()).toHaveLength(0)
    expect(handlers.onDeleteFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'inbox.md' }))
  })

  /**
   * Finder needs an absolute path; the tree's path is vault-relative
   * and would resolve against the process's working folder.
   */
  it('reveals a note by its absolute path', () => {
    tree()
    fireEvent.contextMenu(row('roadmap'))
    fireEvent.click(screen.getByText('Reveal in Finder'))
    expect(menus()).toHaveLength(0)
    expect(handlers.onReveal).toHaveBeenCalledWith('/v/roadmap.md')
  })

  // A nested note's row stands for the folder, so that is revealed: it holds
  // the note and its children, and a folder note never typed in has no file.
  it('reveals a nested note by its folder', () => {
    tree()
    fireEvent.contextMenu(row('Ideas'))
    fireEvent.click(screen.getByText('Reveal in Finder'))
    expect(handlers.onReveal).toHaveBeenCalledWith('/v/Ideas')
  })

  // Each row owns its menu, so two could be open. The right
  // button's mousedown reaches the open menu's click-away first,
  // which keeps it to one, so the mousedown is fired here too.
  it('leaves one menu when a second row is right-clicked', () => {
    tree()
    fireEvent.contextMenu(row('roadmap'))
    fireEvent.mouseDown(row('inbox'), { button: 2 })
    fireEvent.contextMenu(row('inbox'))
    expect(menus()).toHaveLength(1)
  })
})


/**
 * A right-click must not start a drag. WebKit starts one on a right
 * press over a `draggable` element (Chrome and jsdom do not), and
 * the list under the pointer kept its drop wash. The guard reads
 * the button on `mousedown`, so the test presses before it drags.
 */
describe('a drag', () => {
  const dataTransfer = () => ({
    setData: vi.fn(),
    setDragImage: vi.fn(),
    effectAllowed: '',
    types: [] as string[],
  })

  it('is refused when it did not start on the primary button', () => {
    tree()
    const dragged = screen.getByText('roadmap').closest('button')!
    const transfer = dataTransfer()
    fireEvent.mouseDown(dragged, { button: 2 })
    const started = fireEvent.dragStart(dragged, { dataTransfer: transfer })
    // Refused on the way out: nothing is carried and the event is cancelled.
    expect(transfer.setData).not.toHaveBeenCalled()
    expect(started).toBe(false)
  })

  it('is allowed on the primary button', () => {
    tree()
    const dragged = screen.getByText('roadmap').closest('button')!
    const transfer = dataTransfer()
    fireEvent.mouseDown(dragged, { button: 0 })
    fireEvent.dragStart(dragged, { dataTransfer: transfer })
    expect(transfer.setData).toHaveBeenCalled()
  })
})

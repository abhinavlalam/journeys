/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FolderTree } from '../FolderTree'
import type { VaultFile, VaultFolder } from '../vaultModel'

/**
 * The right-click menu, driven from the tree — its only caller.
 *
 * `useContextMenu` owns the position state, the `preventDefault` and the node, and
 * `ContextMenu` owns the clamp and both ways of closing. What is pinned here is
 * everything a hand-rolled copy of that gets subtly wrong: the position, the clamp
 * back inside the window, Escape, click-away, and that a second right-click leaves
 * one menu rather than two.
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
    // fireEvent returns false when the event was cancelled — the preventDefault
    // that stops the webview's own menu appearing over ours.
    expect(fireEvent.contextMenu(row('roadmap'), { clientX: 40, clientY: 60 })).toBe(false)

    const menu = document.querySelector('.context-menu') as HTMLElement
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('60px')
    expect(screen.getByText('Rename')).toBeTruthy()
    expect(screen.getByText('Delete')).toBeTruthy()
  })

  // The reason ContextMenu measures itself in a layout effect: right-clicking a
  // note near the bottom of the sidebar put Delete off-screen. jsdom reports a
  // zero-sized box, so the clamp lands on the margin alone — still the arithmetic.
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
   * Finder wants a path, and an *absolute* one — the tree's `path` is relative to
   * the vault and would resolve against whatever the process's working directory
   * happens to be. Both row kinds hand over the one thing they have in common.
   */
  it('reveals a note by its absolute path', () => {
    tree()
    fireEvent.contextMenu(row('roadmap'))
    fireEvent.click(screen.getByText('Reveal in Finder'))
    expect(menus()).toHaveLength(0)
    expect(handlers.onReveal).toHaveBeenCalledWith('/v/roadmap.md')
  })

  // A nested note's row stands for the folder, so that is what is revealed: it
  // holds the note *and* its children, and a folder note nobody has typed in has no
  // file to select.
  it('reveals a nested note by its folder', () => {
    tree()
    fireEvent.contextMenu(row('Ideas'))
    fireEvent.click(screen.getByText('Reveal in Finder'))
    expect(handlers.onReveal).toHaveBeenCalledWith('/v/Ideas')
  })

  // Each row owns its own menu, so two could in principle stand open at once. The
  // right button's mousedown reaches the open menu's click-away listener first,
  // which is what keeps it to one — and is why the mousedown is fired here too.
  it('leaves one menu when a second row is right-clicked', () => {
    tree()
    fireEvent.contextMenu(row('roadmap'))
    fireEvent.mouseDown(row('inbox'), { button: 2 })
    fireEvent.contextMenu(row('inbox'))
    expect(menus()).toHaveLength(1)
  })
})


/**
 * **A right-click must not start a drag.** WebKit begins a drag session when the
 * right button is pressed on a `draggable` element — Chrome and jsdom decline it —
 * so in the app a right-click on a note started a drag nothing finished: the list
 * under the pointer took the drop wash and kept it, a blue outline across the whole
 * left pane. The guard is the button read on `mousedown`, which is the only place
 * it can be read, so the test presses before it drags.
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
    // Refused on the way out: nothing is carried, and the event is cancelled.
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

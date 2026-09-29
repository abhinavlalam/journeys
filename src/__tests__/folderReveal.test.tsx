/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { FolderTree } from '../FolderTree'
import { collectFolders, existingNotesIn } from '../links'
import { claimsIcon, resolveNoteIcon } from '../icons'
import { useEffect } from 'react'
import { useFolderOpenState } from '../useFolderOpenState'
import { knownPath } from '../vaultModel'
import type { VaultFolder } from '../vaultModel'
import { stepIn } from '../rows'
import { vaultFile as file } from './fakeVault'

/**
 * A folder shut by hand must open when the selection lands inside it. Collapsing
 * `Notes/Projects` and then jumping to a note under it opened the note in a tab
 * while the tree showed no selected row, because hand-closed folders were only
 * cleared on a vault change. Driven through the real `useFolderOpenState`.
 */

const deep: VaultFolder = {
  path: 'Notes/Projects/deep',
  absolutePath: '/v/Notes/Projects/deep',
  name: 'deep',
  folders: [],
  files: [file('Notes/Projects/deep/plan.md')],
}

const projects: VaultFolder = {
  path: 'Notes/Projects',
  absolutePath: '/v/Notes/Projects',
  name: 'Projects',
  folders: [deep],
  files: [],
}

/**
 * A second folder beside `Projects`: what is open in one stays
 * open when the selection lands in the other.
 */
const archive: VaultFolder = {
  path: 'Notes/Archive',
  absolutePath: '/v/Notes/Archive',
  name: 'Archive',
  folders: [],
  files: [file('Notes/Archive/old.md')],
}

const root: VaultFolder = {
  path: 'Notes',
  absolutePath: '/v/Notes',
  name: 'Notes',
  folders: [projects, archive],
  files: [file('Notes/other.md')],
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
}

function Tree({
  selectedPath,
  icons = {},
}: {
  selectedPath: string | null
  icons?: Record<string, string>
}) {
  const { open, toggle, reveal, setAll } = useFolderOpenState('/v')
  // Revealing writes: the app calls this as a note opens, and the folders
  // above it go into the same set a chevron writes to, so they stay open.
  useEffect(() => {
    if (selectedPath) reveal(knownPath(selectedPath))
  }, [selectedPath, reveal])
  return (
    <>
      {/* The header's one button, both ways. */}
      <button onClick={() => setAll(collectFolders(root), false)}>collapse all</button>
      <button onClick={() => setAll(collectFolders(root), true)}>expand all</button>
      <ul>
        <FolderTree
          folder={root}
          depth={0}
          create={null}
          unlock={null}
          selectedPath={selectedPath}
          openFolders={open}
          onToggleFolder={toggle}
          icons={icons}
          {...handlers}
        picked={new Set<string>()}
        where="tree"
        />
      </ul>
    </>
  )
}

/**
 * What is open stays open. Expanding one folder and clicking another
 * collapsed the first, because a folder opened by the selection shut when
 * the selection moved. There is one reason now, and revealing writes to it.
 */
describe('two folders', () => {
  it('both stay open, whichever the selection is in', () => {
    render(<Tree selectedPath={null} />)
    fireEvent.click(chevron('Projects'))
    fireEvent.click(chevron('Archive'))
    expect(chevron('Projects').getAttribute('aria-label')).toBe('Collapse Projects')
    expect(chevron('Archive').getAttribute('aria-label')).toBe('Collapse Archive')

    // A note opens inside one of them: the other is untouched.
    cleanup()
    render(<Tree selectedPath="Notes/Projects/plan.md" />)
    expect(chevron('Projects').getAttribute('aria-label')).toBe('Collapse Projects')
    expect(chevron('Archive').getAttribute('aria-label')).toBe('Collapse Archive')

    // And moving the selection out leaves it open.
    cleanup()
    render(<Tree selectedPath="Notes/Archive/old.md" />)
    expect(chevron('Projects').getAttribute('aria-label')).toBe('Collapse Projects')
    expect(chevron('Archive').getAttribute('aria-label')).toBe('Collapse Archive')
  })
})

const chevron = (name: string) =>
  screen.getByLabelText(new RegExp(`^(Collapse|Expand) ${name}$`))

const store = new Map<string, string>()

afterEach(cleanup)

beforeEach(() => {
  store.clear()
  // Node 26 ships a gated `localStorage` global that hides jsdom's.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    },
  })
})

const PLAN = 'Notes/Projects/deep/plan.md'

describe('a selection landing inside a collapsed folder', () => {
  it('reveals the folder holding it, and a click still shuts it', () => {
    const { rerender } = render(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()

    fireEvent.click(chevron('Projects'))
    expect(screen.queryByText('plan')).toBeNull()

    // Away, then back: a search hit or a backlink.
    rerender(<Tree selectedPath="Notes/other.md" />)
    expect(screen.queryByText('plan')).toBeNull()

    rerender(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()

    // The reveal does not outrank the owner: openness recomputed
    // from the selection each render made the chevron do nothing.
    fireEvent.click(chevron('Projects'))
    expect(screen.queryByText('plan')).toBeNull()
  })

  it('stays shut across a re-render that changes no selection', () => {
    const { rerender } = render(<Tree selectedPath={PLAN} />)
    fireEvent.click(chevron('Projects'))
    expect(screen.queryByText('plan')).toBeNull()

    rerender(<Tree selectedPath={PLAN} />)
    expect(screen.queryByText('plan')).toBeNull()
  })

  it('reveals a folder that was never opened in the first place', () => {
    // Collapsed is the default, so this half always worked; the fix must not cost it.
    const { rerender } = render(<Tree selectedPath={null} />)
    expect(screen.queryByText('plan')).toBeNull()

    rerender(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()
  })
})

/**
 * Shutting or opening the whole tree from one button: one write to
 * one set, so an empty set is a shut tree. The reveal must still
 * reopen a branch when a note in it is next opened (the last test).
 */
describe('collapse all and expand all', () => {
  it('shuts every folder, the one holding the selection included', () => {
    render(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()

    fireEvent.click(screen.getByText('collapse all'))
    expect(screen.queryByText('deep')).toBeNull()
    expect(screen.queryByText('plan')).toBeNull()

    // Shut, not stuck: the chevrons still work after.
    fireEvent.click(chevron('Projects'))
    expect(screen.getByText('deep')).toBeTruthy()
  })

  it('opens every folder, however deep', () => {
    render(<Tree selectedPath={null} />)
    expect(screen.queryByText('plan')).toBeNull()

    fireEvent.click(screen.getByText('expand all'))
    expect(screen.getByText('deep')).toBeTruthy()
    expect(screen.getByText('plan')).toBeTruthy()
  })

  it('leaves a later selection able to reveal where it lives', () => {
    const { rerender } = render(<Tree selectedPath={PLAN} />)
    fireEvent.click(screen.getByText('collapse all'))
    expect(screen.queryByText('plan')).toBeNull()

    // Away, then back, as in the reveal tests above.
    rerender(<Tree selectedPath="Notes/other.md" />)
    rerender(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()
  })
})

/**
 * A note and a sibling folder at the same depth start at the same column. A
 * folder row has a `.folder-chevron` before its name and a file row had
 * nothing, so the file's text began a chevron's width left. Now a leaf row
 * carries the same boxes, an empty `.folder-chevron` and a `.row-body`,
 * sharing the classes and padding. jsdom lays nothing out, so this checks
 * the boxes and classes; the geometry was measured in Chrome.
 */
describe('the chevron column', () => {
  const padOf = (el: Element) => (el as HTMLElement).style.paddingLeft

  it('gives a leaf row the same boxes a folder row has', () => {
    render(<Tree selectedPath={null} />)
    const fileRow = screen.getByText('other').closest('li')!
    const folderRow = screen.getByText('Projects').closest('.folder-header')!

    // Same depth, so the same step; that part was never the bug.
    expect(padOf(fileRow)).toBe(padOf(folderRow))

    // A folder's chevron is a button; a leaf's is an empty span
    // of the same class, so one width serves both.
    expect(folderRow.querySelector('button.folder-chevron')).toBeTruthy()
    const button = screen.getByText('other').closest('button')!
    const chevron = button.firstElementChild!
    expect(chevron.className).toBe('folder-chevron')
    expect(chevron.tagName).toBe('SPAN')
    expect(chevron.textContent).toBe('')
    // Decoration only: nothing announces it.
    expect(chevron.getAttribute('aria-hidden')).toBe('true')

    // The rest of the row sits in a body sharing its padding
    // with the folder's toggle, so the names line up.
    expect(button.querySelector('.row-body > .row-name')).toBeTruthy()
    expect(folderRow.querySelector('.folder-toggle > .row-name')).toBeTruthy()
  })

  it('keeps the step at depth, not per row kind', () => {
    render(<Tree selectedPath={PLAN} />)
    // `Notes/Projects/deep/plan.md`: two folders below the tree's root.
    expect(padOf(screen.getByText('plan').closest('li')!)).toBe(stepIn(2))
    expect(padOf(screen.getByText('deep').closest('.folder-header')!)).toBe(stepIn(1))
  })
})

/**
 * Clicking a folder's name toggles it, and the second click is the test. The
 * name also opens the folder's own note, inside the folder, and openness
 * derived from the selection could not be toggled. `toggleSelf` drops the
 * reveal in the same gesture and passes `onToggleFolder` the state on screen.
 */
describe("a click on a folder's name", () => {
  const name = (text: string) => screen.getByText(text).closest('button')!

  it('expands, and a second click collapses', () => {
    // `selectedPath` as App would pass it after
    // `onSelectFolderNote`: the folder's own note.
    const { rerender } = render(<Tree selectedPath={null} />)
    expect(screen.queryByText('deep')).toBeNull()

    fireEvent.click(name('Projects'))
    rerender(<Tree selectedPath="Notes/Projects/Projects.md" />)
    expect(screen.getByText('deep')).toBeTruthy()

    fireEvent.click(name('Projects'))
    expect(screen.queryByText('deep')).toBeNull()

    // And a third opens it again, rather than latching shut.
    fireEvent.click(name('Projects'))
    expect(screen.getByText('deep')).toBeTruthy()
  })

  it('still opens the folder note on every click, collapsing included', () => {
    render(<Tree selectedPath={null} />)
    handlers.onSelectFolderNote.mockClear()

    fireEvent.click(name('Projects'))
    fireEvent.click(name('Projects'))

    // Two clicks, two opens: the toggle is in addition to opening the note.
    expect(handlers.onSelectFolderNote).toHaveBeenCalledTimes(2)
  })
})

/**
 * One click, not two or three. Clicking a folder's name selects its
 * own note, and when openness came from the selection that click
 * reopened the folder it had just closed. `reveal` skips the folder a
 * note belongs to, and openness is a set, so one click is one answer.
 */
describe('collapsing a folder that is open because of what is selected', () => {


  /**
   * No case here for collapsing on the first click: two attempts both passed
   * with the old reveal condition back, so neither proved anything. The
   * reported symptom (sometimes two or three clicks) is not yet reproduced.
   */

  it('still reveals when the selection moves to a note inside it', () => {
    // What the fix must keep: a note opened from elsewhere still
    // opens the folders above it.
    const { rerender } = render(<Tree selectedPath={null} />)
    expect(screen.queryByText('plan')).toBeNull()
    rerender(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()
  })
})

/**
 * A nested note's icon, chosen from the glyph and stored in the
 * note. The icon sits inside the button that opens the note, and
 * only `stopPropagation` keeps the two apart.
 */
describe('the icon on a nested note', () => {
  it('opens a picker without opening the note', () => {
    render(<Tree selectedPath={null} />)
    // `handlers` is shared and never reset, so the count below is only this click.
    handlers.onSelectFolderNote.mockClear()
    fireEvent.click(screen.getByLabelText('Icon for Projects'))

    expect(document.querySelector('.context-menu')).toBeTruthy()
    // The click stopped at the icon; the note behind it did not open.
    expect(handlers.onSelectFolderNote).not.toHaveBeenCalled()
  })

  it('reports the chosen icon key for the folder, not its path', () => {
    render(<Tree selectedPath={null} />)
    handlers.onSetFolderIcon.mockClear()
    fireEvent.click(screen.getByLabelText('Icon for Projects'))
    fireEvent.click(within(document.querySelector('.context-menu')!).getByLabelText('Book'))

    expect(handlers.onSetFolderIcon).toHaveBeenCalledTimes(1)
    const [folder, icon] = handlers.onSetFolderIcon.mock.calls[0]
    expect(folder.path).toBe('Notes/Projects')
    // The key, not a glyph: it goes into the note as plain text.
    expect(icon).toBe('book')
  })

  it('draws the icon it was given in place of the outline glyph', () => {
    render(<Tree selectedPath={null} icons={{ 'Notes/Projects/Projects.md': 'book' }} />)
    expect(screen.getByLabelText('Icon for Projects').querySelector('svg')).toBeTruthy()
  })

  it('falls back to text for a key it does not know, so an emoji still shows', () => {
    // Set before the drawn set existed, or typed into the properties by hand.
    render(<Tree selectedPath={null} icons={{ 'Notes/Projects/Projects.md': '📚' }} />)
    expect(screen.getByLabelText('Icon for Projects').textContent).toBe('📚')
  })

  it('offers Remove only once one is set', () => {
    render(<Tree selectedPath={null} />)
    fireEvent.click(screen.getByLabelText('Icon for Projects'))
    expect(within(document.querySelector('.context-menu')!).queryByText('Remove icon')).toBeNull()
    cleanup()

    render(<Tree selectedPath={null} icons={{ 'Notes/Projects/Projects.md': 'book' }} />)
    fireEvent.click(screen.getByLabelText('Icon for Projects'))
    expect(within(document.querySelector('.context-menu')!).getByText('Remove icon')).toBeTruthy()
  })
})

/**
 * An icon spreads down a folder by being written into the notes inside it, never
 * worked out while the tree draws. The icon once sat only in the top folder's
 * note, and every note under it drew an icon its own text did not mention.
 */
describe('an icon passing down a folder', () => {
  it('draws only what the note itself carries', () => {
    expect(resolveNoteIcon('Notes/Projects', { 'Notes/Notes.md': 'book' })).toBeUndefined()
    expect(resolveNoteIcon('Notes/Projects', { 'Notes/Projects/Projects.md': 'book' })).toBe('book')
  })

  it('claims a note with no icon, and one still carrying the folder’s old one', () => {
    expect(claimsIcon(undefined, undefined, 'book')).toBe(true)
    expect(claimsIcon('book', 'book', 'target')).toBe(true)
    // Someone chose this one; the folder does not take it.
    expect(claimsIcon('star', 'book', 'target')).toBe(false)
  })

  it('takes back only what it gave, when the folder’s icon is removed', () => {
    expect(claimsIcon('book', 'book', null)).toBe(true)
    // Writing no icon to a note with none is a write for nothing.
    expect(claimsIcon(undefined, 'book', null)).toBe(false)
  })

  it('leaves out a folder note that has not been written yet', () => {
    // `Projects` and `deep` have no note on disk here. A bulk write naming
    // either would create the file the first key is meant to create.
    expect(existingNotesIn(root).map((note) => note.path)).toEqual([
      'Notes/other.md',
      'Notes/Projects/deep/plan.md',
      'Notes/Archive/old.md',
    ])
  })
})

/**
 * Every note's icon is the scheme's colour whether or not it holds others:
 * `.folder-icon` paints it, and the glyph has no class of its own. The
 * arrow says a note has something inside, and only such a note gets one.
 */
describe('a nested page against a plain page', () => {
  it('draws both glyphs the same and gives only one an arrow', () => {
    render(
      <Tree
        selectedPath={null}
        icons={{ 'Notes/Projects/Projects.md': 'book', 'Notes/other.md': 'book' }}
      />
    )
    const glyph = (label: string) =>
      screen.getByLabelText(label).querySelector('svg')!.getAttribute('class')
    expect(glyph('Icon for Projects')).toBe(glyph('Icon for other'))

    const row = (name: string) => screen.getByText(name).closest('li')!
    expect(row('Projects').querySelector('button.folder-chevron')).toBeTruthy()
    expect(row('other').querySelector('button.folder-chevron')).toBeNull()
  })

  it('gives a plain page an icon of its own, keyed by its own path', () => {
    render(<Tree selectedPath={null} icons={{ 'Notes/other.md': 'star' }} />)
    handlers.onSetFileIcon.mockClear()
    fireEvent.click(screen.getByLabelText('Icon for other'))
    fireEvent.click(within(document.querySelector('.context-menu')!).getByLabelText('Goal'))

    const [file, icon] = handlers.onSetFileIcon.mock.calls[0]
    expect(file.path).toBe('Notes/other.md')
    expect(icon).toBe('target')
  })


})

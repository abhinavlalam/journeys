/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { FolderTree } from '../FolderTree'
import { collectFolders, existingNotesIn } from '../links'
import { claimsIcon, resolveNoteIcon } from '../icons'
import { useEffect } from 'react'
import { useFolderOpenState } from '../useFolderOpenState'
import { knownPath } from '../vaultModel'
import type { VaultFile, VaultFolder } from '../vaultModel'
import { stepIn } from '../rows'

/**
 * A folder shut by hand still has to open when the selection lands inside it.
 *
 * The reported bug: collapse `Notes/Projects`, then ⌘K to a note under it. The note
 * opened and took a tab while the tree showed no selected row and `Projects` stayed
 * shut — the sidebar read as if nothing had happened, because the set of explicitly
 * closed folders was only ever cleared on a vault change.
 *
 * Driven through the real `useFolderOpenState`, since the bug lives in the handshake
 * between that state and what the row derives from the selection.
 */
const file = (path: string): VaultFile => ({
  path,
  absolutePath: `/v/${path}`,
  name: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
})

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

/** A second folder beside `Projects`: what is open in one has to stay open when
 *  the selection lands in the other. */
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
  // **Revealing writes.** The app calls this as a note opens; the folders above it
  // go into the same set a chevron writes to, which is why they stay open when the
  // selection moves on.
  useEffect(() => {
    if (selectedPath) reveal(knownPath(selectedPath))
  }, [selectedPath, reveal])
  return (
    <>
      {/* The header's one button, in the two directions it has. */}
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
 * **What is open stays open.** Reported from the running app: expand one folder,
 * click another, and the first collapsed.
 *
 * The cause was two reasons for a folder to be open — this set, and a per-row flag
 * for the branch holding the selected note. A folder opened *by the selection* shut
 * the moment the selection moved, which is what clicking another folder does. There
 * is one reason now, and revealing writes to it.
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

    // And moving the selection out of it leaves it open, which is the report.
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
  // Node 26 ships a gated `localStorage` global that shadows jsdom's.
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

    // Away, then back — a search hit or a backlink.
    rerender(<Tree selectedPath="Notes/other.md" />)
    expect(screen.queryByText('plan')).toBeNull()

    rerender(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()

    // The reveal is a convenience and does not outrank the user: openness derived
    // from the selection each render is the trap — the click lands, the value
    // recomputes, and the chevron does nothing.
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
    // Collapsed is the default, so this half always worked — it is the half the
    // fix must not cost.
    const { rerender } = render(<Tree selectedPath={null} />)
    expect(screen.queryByText('plan')).toBeNull()

    rerender(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()
  })
})

/**
 * Shutting or opening the whole tree from one button.
 *
 * Both directions are one write to the one set, which is what makes collapse
 * simple: an empty set *is* a shut tree. It used to leave the branch holding the
 * selected note standing, because that branch was open for a reason the button
 * could not reach. What must not break is the reveal itself — the last test here —
 * which opens that branch again the next time a note in it is opened.
 */
describe('collapse all and expand all', () => {
  it('shuts every folder, the one holding the selection included', () => {
    render(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()

    fireEvent.click(screen.getByText('collapse all'))
    expect(screen.queryByText('deep')).toBeNull()
    expect(screen.queryByText('plan')).toBeNull()

    // Shut, not stuck: the chevrons still work afterwards.
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

    // Away, then back — a search hit or a backlink, as in the reveal tests above.
    rerender(<Tree selectedPath="Notes/other.md" />)
    rerender(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()
  })
})

/**
 * A note and a sibling folder at the same depth start at the same column.
 *
 * Reported from the running app: in the Folders tab a note sat further left than a
 * folder beside it. Both rows take `paddingLeft: stepIn(depth)`, but a folder row also
 * carries a `.folder-chevron` button ahead of its name and a file row carried
 * nothing — so the file's text began a chevron's width to the left.
 *
 * The fix is that a leaf row carries the **same boxes** a folder row does: an empty
 * `.folder-chevron` and a `.row-body`, sharing the classes and therefore the
 * padding. A reserve of its own — `.row-chevron-gap`, `chevron + 0.25rem` wide —
 * came before this, and it was out by the header's gap plus the toggle's padding,
 * and went out again every time one of those moved. Measured in Chrome at the time:
 * a leaf's name sat 8px right of a folder's.
 *
 * jsdom lays nothing out, so this asserts the boxes and the classes they share —
 * never rendered geometry. The geometry was measured in a real engine, which is the
 * only place it can be.
 */
describe('the chevron column', () => {
  const padOf = (el: Element) => (el as HTMLElement).style.paddingLeft

  it('gives a leaf row the same boxes a folder row has', () => {
    render(<Tree selectedPath={null} />)
    const fileRow = screen.getByText('other').closest('li')!
    const folderRow = screen.getByText('Projects').closest('.folder-header')!

    // Same depth, so the same step — that part was never the bug.
    expect(padOf(fileRow)).toBe(padOf(folderRow))

    // A folder's chevron is a button; a leaf's is an empty span of the same class,
    // so one width declaration serves both.
    expect(folderRow.querySelector('button.folder-chevron')).toBeTruthy()
    const button = screen.getByText('other').closest('button')!
    const chevron = button.firstElementChild!
    expect(chevron.className).toBe('folder-chevron')
    expect(chevron.tagName).toBe('SPAN')
    expect(chevron.textContent).toBe('')
    // And it is decoration: nothing announces it.
    expect(chevron.getAttribute('aria-hidden')).toBe('true')

    // The rest of the row sits in a body that shares its padding with the folder's
    // toggle, which is what makes the two names land together.
    expect(button.querySelector('.row-body > .row-name')).toBeTruthy()
    expect(folderRow.querySelector('.folder-toggle > .row-name')).toBeTruthy()
  })

  it('keeps the step at depth, not per row kind', () => {
    render(<Tree selectedPath={PLAN} />)
    // Notes/Projects/deep/plan.md — two folders down from the tree's root.
    expect(padOf(screen.getByText('plan').closest('li')!)).toBe(stepIn(2))
    expect(padOf(screen.getByText('deep').closest('.folder-header')!)).toBe(stepIn(1))
  })
})

/**
 * Clicking a folder's name toggles it, and the second click is the whole test.
 *
 * Reported from the running app: "clicking a nested folder expands the folder,
 * reclicking it should collapse it." The trap is that the name also opens the
 * folder's *own* note — which lives inside the folder — so the click that expands
 * also puts the selection on the folder's selected path, and openness derived from
 * that path cannot be toggled: the second click lands, `onSelectedPath` recomputes
 * true, and the row re-renders open.
 *
 * `toggleSelf` is what makes it work: it drops the reveal in the same gesture and
 * hands `onToggleFolder` the state actually on screen.
 */
describe("a click on a folder's name", () => {
  const name = (text: string) => screen.getByText(text).closest('button')!

  it('expands, and a second click collapses', () => {
    // `selectedPath` is what App would pass once `onSelectFolderNote` has run: the
    // folder's own note, inside the folder.
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

    // Two clicks, two opens: the toggle is additional to opening the note, not
    // instead of it.
    expect(handlers.onSelectFolderNote).toHaveBeenCalledTimes(2)
  })
})

/**
 * One click, not two or three.
 *
 * A folder's own note lives at `folder.path/name.md`, and clicking the folder's
 * name selects exactly that note. When openness was *derived* from the selection,
 * that click re-opened the folder after the same click had closed it — and a second
 * click worked, because by then the selection had not moved. `reveal` skips the
 * folder a note is the note *of* for this reason, and openness is a set rather than
 * a derivation, so one click is one answer.
 */
describe('collapsing a folder that is open because of what is selected', () => {


  /**
   * There is no case here for "collapses on the first click", and that is
   * deliberate. Two attempts at one both passed with the reveal condition put back
   * the way it was, so neither was evidence of anything. The reported symptom —
   * needing two or three clicks, sometimes — is real and is not yet reproduced.
   */

  it('still reveals when the selection moves to a note inside it', () => {
    // The half the fix must not cost: a note opened from elsewhere still opens the
    // folders above it.
    const { rerender } = render(<Tree selectedPath={null} />)
    expect(screen.queryByText('plan')).toBeNull()
    rerender(<Tree selectedPath={PLAN} />)
    expect(screen.getByText('plan')).toBeTruthy()
  })
})

/**
 * A nested note's icon: chosen from the glyph itself, stored in the note.
 *
 * The icon sits *inside* the button that opens the note, so the two gestures are
 * only kept apart by `stopPropagation` — which is what these pin.
 */
describe('the icon on a nested note', () => {
  it('opens a picker without opening the note', () => {
    render(<Tree selectedPath={null} />)
    // `handlers` is shared by every case in this file and never reset, so the count
    // below is only about this click.
    handlers.onSelectFolderNote.mockClear()
    fireEvent.click(screen.getByLabelText('Icon for Projects'))

    expect(document.querySelector('.context-menu')).toBeTruthy()
    // The click stopped at the icon; the note behind it was not opened.
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
    // The *key*, not a glyph: it is what goes into the note as plain text.
    expect(icon).toBe('book')
  })

  it('draws the icon it was given in place of the outline glyph', () => {
    render(<Tree selectedPath={null} icons={{ 'Notes/Projects/Projects.md': 'book' }} />)
    expect(screen.getByLabelText('Icon for Projects').querySelector('svg')).toBeTruthy()
  })

  it('falls back to text for a key it does not know, so an emoji still shows', () => {
    // Set before the drawn set existed, or typed into the frontmatter by hand.
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
 * An icon spreads down a folder by being *written* into the notes inside it, never
 * by being derived while the tree draws.
 *
 * Reported from the running app: `icon: calendar` sat in the top folder's note and
 * in no other, so every note under it drew an icon that its own text did not
 * mention. A property the app knows and the file does not is not a property.
 */
describe('an icon passing down a folder', () => {
  it('draws only what the note itself carries', () => {
    expect(resolveNoteIcon('Notes/Projects', { 'Notes/Notes.md': 'book' })).toBeUndefined()
    expect(resolveNoteIcon('Notes/Projects', { 'Notes/Projects/Projects.md': 'book' })).toBe('book')
  })

  it('claims a note with no icon, and one still carrying the folder’s old one', () => {
    expect(claimsIcon(undefined, undefined, 'book')).toBe(true)
    expect(claimsIcon('book', 'book', 'target')).toBe(true)
    // Somebody chose this one. It is not the folder's to take.
    expect(claimsIcon('star', 'book', 'target')).toBe(false)
  })

  it('takes back only what it gave, when the folder’s icon is removed', () => {
    expect(claimsIcon('book', 'book', null)).toBe(true)
    // Rewriting a note with no icon to have no icon is a write for no change.
    expect(claimsIcon(undefined, 'book', null)).toBe(false)
  })

  it('leaves out a folder note that has not been written yet', () => {
    // `Projects` and `deep` have no note on disk in this fixture. Naming either in
    // a bulk write would create the file the first keystroke is supposed to create.
    expect(existingNotesIn(root).map((note) => note.path)).toEqual([
      'Notes/other.md',
      'Notes/Projects/deep/plan.md',
      'Notes/Archive/old.md',
    ])
  })
})

/**
 * **Every note's icon is the scheme's colour**, whether or not the note holds
 * others: `.folder-icon` paints it, so the glyph carries no class of its own and
 * there is nothing here for a row kind to change. What says a note has something
 * inside it is the disclosure arrow, and only a note that has something gets one.
 *
 * The colour went through three positions before this: a tinted plate behind the
 * glyph (grey in every scheme, because it took `currentColor`), then the accent for
 * nested notes against white for plain ones, then this.
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

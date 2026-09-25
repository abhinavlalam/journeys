/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  disk,
  fsModule,
  markdownEditorModule,
  rememberVault,
  resetFakeVault,
} from './fakeVault'
import { localDateStamp } from '../clock'
import { stepIn } from '../rows'

/**
 * The shell end to end: pick a folder, see its notes, open one, edit it, save.
 *
 * These run over `fakeVault`, so the **real** `vault.ts` is underneath — real walk,
 * real rename guards, real case-insensitivity — and every assertion is about the
 * bytes on the fake disk. That is the level the bugs live at: each one below is a
 * write landing in the wrong file, and nothing narrower than the whole App can see
 * a write path go wrong, because the path is spread across the buffer, the debounce
 * and the tree.
 *
 * The editor is stubbed as a textarea: CodeMirror needs a layout jsdom does not
 * have, and what the real editor does on *mount* is a separate bug class with its
 * own file, `openNote.test.tsx`, which mounts it for real.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())

const confirmed = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: confirmed,
}))

/**
 * Autosave's debounce, plus a margin — a **lower** bound, and the reason it is
 * still a number here when the suite's `waitFor` budget is one global setting: the
 * two tests below sleep this long and then assert that nothing was written. Waiting
 * *longer* than the debounce is the whole assertion, so it cannot be delegated to a
 * ceiling that exists to be generous.
 */
const SAVED = 1200

afterEach(cleanup)

beforeEach(() => {
  resetFakeVault()
  confirmed.mockClear()
  confirmed.mockResolvedValue(true)
  rememberVault('/v')
})

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  // The whole App mounts and reads the folder first.
  await waitFor(() => expect(row('roadmap')).toBeTruthy())
}

const editor = () => screen.getByTestId('editor') as HTMLTextAreaElement

/** Scoped to the tree: the open note's name is also the viewer's own heading. */
const row = (name: string) => within(document.querySelector('.file-list')!).getByText(name)
/** Scoped to the header: every folder row carries an add button too. */
const sidebarButton = (label: string) =>
  within(document.querySelector('.sidebar')!).getByLabelText(label)

/** The header's `+` goes straight to a name field: there is one kind of note. */
function sidebarAdd() {
  fireEvent.click(sidebarButton('New note'))
}

async function openTheNote(name: string) {
  fireEvent.click(row(name))
  await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())
}

function type(text: string) {
  fireEvent.change(editor(), { target: { value: text } })
}

describe('the shell', () => {
  it('reopens the last folder and lists its notes as a tree', async () => {
    await openApp()
    expect(row('inbox')).toBeTruthy()
    // A nested folder note renders as the folder's own row, not as a child of it.
    expect(row('Ideas')).toBeTruthy()
    expect(screen.queryByText('pingbird')).toBeNull()

    fireEvent.click(screen.getByLabelText('Expand Ideas'))
    expect(screen.getByText('pingbird')).toBeTruthy()
  })

  /**
   * The whole file, frontmatter included.
   *
   * It used to be split off and held aside, because Crepe would have mangled a block
   * it could not render. The editor is a text editor now, and this app's premise is
   * that the document *is* the file's own text — so hiding the top of it was the one
   * place that premise did not hold. It also made a property the app itself writes
   * invisible in the app: a note's `icon:` was there and could not be seen.
   */
  it('opens the whole note into the editor, frontmatter and all', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Expand Ideas'))
    await openTheNote('pingbird')

    expect(editor().value).toContain('# Pingbird')
    expect(editor().value).toContain('status: draft')
    // Byte for byte, so nothing is reordered or re-spaced on the way in.
    expect(editor().value).toBe(disk.read('/v/Ideas/pingbird.md'))
  })

  it('writes what was typed, and writes the frontmatter back in front of it', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Expand Ideas'))
    await openTheNote('pingbird')

    type(`${editor().value}\nrewritten\n`)

    await waitFor(
      () =>
        expect(disk.read('/v/Ideas/pingbird.md')).toBe(
          '---\nstatus: draft\n---\n\n# Pingbird\n\nWhat the messenger app got right.\n\nrewritten\n'
        )
    )
  })

  /**
   * The editor is keyed on the note's path, so it remounts the moment the open note
   * changes — and the read has to happen *before* that switch, or it remounts
   * holding the previous note's text, which autosave then writes into the new file.
   * This corrupted a file.
   */
  it('never writes one note’s text into another when the selection moves', async () => {
    await openApp()
    await openTheNote('roadmap')
    type('# Roadmap\n\nedited in flight\n')

    // Switched inside the debounce window, so the queued write is still pending.
    await openTheNote('inbox')

    await waitFor(() => expect(disk.read('/v/roadmap.md')).toContain('edited in flight'))
    // The flush landed in roadmap, and inbox is untouched — both halves matter.
    expect(disk.read('/v/inbox.md')).toBe('# Inbox\n\nThings not yet filed anywhere.\n')
    expect(editor().value).toContain('# Inbox')
  })

  /**
   * A folder note is created lazily: browsing would otherwise litter the folder
   * with blank files, and Milkdown can emit a normalised-but-empty document on
   * mount, so "empty" cannot be the trigger to write.
   */
  it('writes nothing for a folder with no note until something is typed in it', async () => {
    disk.mkdir('/v/Empty')
    await openApp()
    await waitFor(() => expect(row('Empty')).toBeTruthy())

    fireEvent.click(row('Empty'))
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())
    type('')
    await new Promise((resolve) => setTimeout(resolve, SAVED))
    expect(disk.has('/v/Empty/Empty.md')).toBe(false)

    type('now it exists\n')
    await waitFor(() => expect(disk.read('/v/Empty/Empty.md')).toBe('now it exists\n'))
    // The tree's shape changed, so the row is a note-bearing folder now.
    await waitFor(() => expect(disk.paths()).toContain('/v/Empty/Empty.md'))
  })

  /**
   * A queued edit is *discarded* on a delete, never flushed — `mutate` flushes, and
   * writing a pending edit would recreate the note just after deleting it.
   */
  it('deletes the open note and does not resurrect it from the pending save', async () => {
    await openApp()
    await openTheNote('roadmap')
    type('# Roadmap\n\nabout to be deleted\n')

    fireEvent.contextMenu(row('roadmap'))
    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(disk.has('/v/roadmap.md')).toBe(false))
    await new Promise((resolve) => setTimeout(resolve, SAVED))
    expect(disk.has('/v/roadmap.md')).toBe(false)
    // Nothing is open, so there is no buffer left holding the deleted text.
    expect(screen.queryByTestId('editor')).toBeNull()
  })

  /**
   * Deleting a folder used to leave the editor mounted under the surviving note's
   * name while still holding the **deleted** note's text — and the next keystroke
   * autosaved that text into the surviving file.
   */
  it('closes a note inside a deleted folder rather than saving it into a survivor', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Expand Ideas'))
    await openTheNote('pingbird')
    expect(editor().value).toContain('# Pingbird')

    fireEvent.contextMenu(row('Ideas'))
    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(disk.has('/v/Ideas')).toBe(false))
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(disk.read('/v/inbox.md')).toBe('# Inbox\n\nThings not yet filed anywhere.\n')
  })

  it('leaves the note alone when the delete is declined', async () => {
    confirmed.mockResolvedValue(false)
    await openApp()

    fireEvent.contextMenu(row('roadmap'))
    fireEvent.click(screen.getByText('Delete'))

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(disk.has('/v/roadmap.md')).toBe(true)
  })

  /**
   * A rename moves the file, so the buffer has to follow it: everything that asks
   * "does the editor hold this note" reads that path, and a stale one means the
   * next write goes to a file that no longer exists.
   */
  it('keeps the open note open across a rename, and writes to the new path', async () => {
    await openApp()
    await openTheNote('roadmap')

    fireEvent.doubleClick(row('roadmap'))
    const input = document.querySelector('input.rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'plan' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(disk.has('/v/plan.md')).toBe(true))
    expect(disk.has('/v/roadmap.md')).toBe(false)

    type('# Plan\n\nafter the rename\n')
    await waitFor(() => expect(disk.read('/v/plan.md')).toContain('after the rename'))
    expect(disk.has('/v/roadmap.md')).toBe(false)
  })

  it('creates a note from the sidebar and opens it', async () => {
    await openApp()
    sidebarAdd()

    const input = document.querySelector('input.rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'fresh' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(disk.has('/v/fresh.md')).toBe(true))
    await waitFor(() => expect(row('fresh')).toBeTruthy())
  })

  it('reports a name it refuses rather than writing it somewhere invisible', async () => {
    await openApp()
    sidebarAdd()

    const input = document.querySelector('input.rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '.plan' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/dot/))
    expect(disk.has('/v/.plan.md')).toBe(false)
  })

  /**
   * A note whose bytes cannot be read must **not** become an empty editable
   * document: the real text is still on disk and one keystroke would autosave the
   * blank one over it.
   */
  it('mounts no editor over a note it could not read', async () => {
    disk.corrupt('/v/roadmap.md')
    await openApp()

    fireEvent.click(row('roadmap'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(disk.read('/v/roadmap.md')).toBe('# Roadmap\n\nThe plan, such as it is.\n')
  })

  /**
   * There is no filesystem watcher — the disk is re-read on window focus. Without
   * it the buffer keeps a stale copy and the next autosave overwrites whatever is
   * now on disk.
   */
  it('picks up an edit made outside the app when the window regains focus', async () => {
    await openApp()
    await openTheNote('roadmap')

    disk.write('/v/roadmap.md', '# Roadmap\n\nwritten by something else\n')
    disk.write('/v/appeared.md', 'created in Finder\n')
    fireEvent.focus(window)

    await waitFor(() => expect(editor().value).toContain('written by something else'))
    // The tree is re-read too, or a note created outside stays invisible for as
    // long as the window keeps focus.
    await waitFor(() => expect(row('appeared')).toBeTruthy())
  })

  /**
   * ⌘⇧O — today's page.
   *
   * `today` is the app's own `localDateStamp`, which has its own test in a fixed
   * zone; asserting it here would only pin the clock twice. What these pin is the
   * wiring: the listener is registered once and the vault path it needs arrives on
   * a *later* render, so a closure-captured path leaves the shortcut doing nothing
   * at all — silently, which is how this went unnoticed twice in v1.
   */
  const today = () => localDateStamp()

  it('creates and opens today’s page on ⌘⇧O, with no folder note beside it', async () => {
    await openApp()
    expect(disk.has('/v/Daily')).toBe(false)

    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })

    await waitFor(() => expect(disk.has(`/v/Daily/${today()}.md`)).toBe(true))
    // `Daily/` holds dated notes; it is a container, not a note with children.
    expect(disk.has('/v/Daily/Daily.md')).toBe(false)
    // Opened, and through the tree's own path — so the row is there and selected.
    await waitFor(() => expect(row(today())).toBeTruthy())
    expect(row(today()).closest('button')?.className).toContain('selected')
    expect(editor().value).toBe('')
  })

  it('opens today’s page as it stands, and flushes the edit it was called over', async () => {
    disk.write(`/v/Daily/${today()}.md`, 'written earlier today\n')
    await openApp()
    await openTheNote('roadmap')
    type('# Roadmap\n\nmid-sentence\n')

    // Inside the autosave window, so the queued write is still pending.
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true })

    await waitFor(() => expect(editor().value).toBe('written earlier today\n'))
    // Neither file gets the other's text: the flush landed in roadmap, and today's
    // page is exactly what was on disk.
    expect(disk.read(`/v/Daily/${today()}.md`)).toBe('written earlier today\n')
    await waitFor(() => expect(disk.read('/v/roadmap.md')).toContain('mid-sentence'))
  })
})

/**
 * A folder's icon, written into the notes inside it.
 *
 * Reported from the running app: `icon: calendar` sat in the top folder's note and
 * in no other, while every note under it drew the icon anyway — inheritance was
 * resolved while the tree drew itself. What the app shows now is what the note
 * says, which means the write has to reach every note it claims.
 */
describe('an icon set on a folder', () => {
  /**
   * The picker on the row's own glyph. Clicking the name opens the note instead.
   *
   * `getByLabelText` for the icons and `getByText` for the rows: the icons are a
   * grid of unlabelled buttons — sixty-three of them as rows would be a menu taller
   * than the window — and their name is the tooltip.
   */
  function pickIcon(rowLabel: string, choice: string) {
    fireEvent.click(screen.getByLabelText(rowLabel))
    const menu = within(document.querySelector('.context-menu')!)
    fireEvent.click(menu.queryByLabelText(choice) ?? menu.getByText(choice))
  }

  it('writes the property into the folder note and the notes inside it', async () => {
    await openApp()
    pickIcon('Icon for Ideas', 'Goal')

    await waitFor(() => expect(disk.read('/v/Ideas/Ideas.md')).toContain('icon: target'))
    const inside = disk.read('/v/Ideas/pingbird.md')!
    expect(inside).toContain('icon: target')
    // Into the block it already had, not in front of it, and its own key survives.
    expect(inside).toContain('status: draft')
    expect(inside.match(/^---/gm)!.length).toBe(2)
    // Outside the folder, untouched.
    expect(disk.read('/v/roadmap.md')).not.toContain('icon:')
  })

  it('leaves a note that has an icon of its own, and takes back only what it gave', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('Expand Ideas'))
    pickIcon('Icon for pingbird', 'Star')
    await waitFor(() => expect(disk.read('/v/Ideas/pingbird.md')).toContain('icon: star'))

    pickIcon('Icon for Ideas', 'Goal')
    await waitFor(() => expect(disk.read('/v/Ideas/Ideas.md')).toContain('icon: target'))
    // Somebody chose this one, so the folder does not overwrite it.
    expect(disk.read('/v/Ideas/pingbird.md')).toContain('icon: star')

    // And removing the folder's icon leaves that choice alone too.
    pickIcon('Icon for Ideas', 'Remove icon')
    await waitFor(() => expect(disk.read('/v/Ideas/Ideas.md')).not.toContain('icon:'))
    expect(disk.read('/v/Ideas/pingbird.md')).toContain('icon: star')
  })
})

/**
 * What links here, at the end of the note.
 *
 * The index was written and tested long before anything rendered it, so what these
 * cover is the wiring: that a full read happens for a note that is merely *open*
 * — the graph pane used to be the only thing that paid for one — and that the
 * section goes away for a note nothing points at.
 */
describe('the backlinks at the end of a note', () => {
  /** By its own heading: a nested note has an *Inside* section in the same footer,
   *  wearing the same class. */
  const section = (title: string) =>
    [...document.querySelectorAll<HTMLElement>('.note-section')].find((el) =>
      el.querySelector('.folder-header')?.textContent?.includes(title)
    ) ?? null
  const backlinks = () => section('Backlinks')

  it('lists the notes linking here, with the line each is written on', async () => {
    disk.write('/v/plans.md', '# Plans\n\nsee [[roadmap]], and [[roadmap|again]]\n')
    disk.write('/v/stray.md', '# Stray\n\nLinks to nothing.\n')
    await openApp()
    await openTheNote('roadmap')

    await waitFor(() => expect(backlinks()).toBeTruthy())
    const shown = within(backlinks()!)
    expect(shown.getByText('plans')).toBeTruthy()
    // Two links on one line: one line to read, and the count says there are two.
    // **A quotation reads as the note reads**: the first link is its name and the
    // second its alias, because a line quoted here showing `[[…]]` is showing bytes
    // where the editor shows a sentence. This asserted the bytes.
    expect(shown.getByText('see roadmap, and again')).toBeTruthy()
    expect(shown.getByText('2')).toBeTruthy()
    expect(shown.queryByText('stray')).toBeNull()

    fireEvent.click(shown.getByText('plans'))
    await waitFor(() => expect(editor().value).toContain('# Plans'))
  })

  /**
   * **A path is not a name here either, and `|!n` asks for the pages above it.**
   * A quoted line showing `[[Ideas/kites]]` puts the folders that find the note
   * into a sentence at the end of every note it points at. It reads as `kites`;
   * `|!2` is how a link whose name is a fragment asks for the page it is under.
   */
  it('shows a path link in a quoted line as its name, and |!n as the last n', async () => {
    disk.write('/v/Ideas/kites.md', '# Kites\n')
    disk.write('/v/plans.md', '# Plans\n\nsee [[Ideas/kites]] and [[Ideas/kites|!2]]\n')
    await openApp()

    // Through the Inside section, which is how a nested note is reached.
    fireEvent.click(row('Ideas'))
    await waitFor(() => expect(section('Inside')).toBeTruthy())
    fireEvent.click(within(section('Inside')!).getByText('kites'))
    await waitFor(() => expect(editor().value).toContain('# Kites'))

    await waitFor(() => expect(backlinks()).toBeTruthy())
    expect(within(backlinks()!).getByText('see kites and Ideas/kites')).toBeTruthy()
  })

  /**
   * **There for every note**, with or without anything in it: a note nothing
   * points at is a fact about the note, and a section that comes and goes is one
   * whose position cannot be learned. Shut when empty, so it costs one row.
   */
  it('is there and empty for a note nothing points at', async () => {
    disk.write('/v/plans.md', '# Plans\n\nsee [[roadmap]]\n')
    await openApp()
    // Through a note that *has* one first, so what is below is a read that ran and
    // found nothing rather than a read that never happened.
    await openTheNote('roadmap')
    await waitFor(() => expect(within(backlinks()!).getByText('plans')).toBeTruthy())

    await openTheNote('inbox')
    await waitFor(() => expect(within(backlinks()!).queryByText('plans')).toBeNull())
    const shown = within(backlinks()!)
    expect(shown.getByText('0')).toBeTruthy()
    // Shut, so the empty line is not under every note in the vault forever.
    expect(shown.queryByText('Nothing links here yet.')).toBeNull()
    fireEvent.click(shown.getByText('Backlinks'))
    expect(shown.getByText('Nothing links here yet.')).toBeTruthy()
  })
})

/**
 * **What is inside a nested note**, in the same footer, above the backlinks.
 *
 * A nested note is a folder plus a same-named note (CLAUDE.md), so "inside" is the
 * children the tree draws under its row — which is what someone reading the note
 * wants a list of, and what the tree shows only while it is expanded.
 */
describe('the inside of a nested note', () => {
  const section = (title: string) =>
    [...document.querySelectorAll<HTMLElement>('.note-section')].find((el) =>
      el.querySelector('.folder-header')?.textContent?.includes(title)
    ) ?? null

  it('lists the notes in it, and opens one', async () => {
    disk.write('/v/Ideas/kites.md', '# Kites\n')
    await openApp()
    fireEvent.click(row('Ideas'))

    await waitFor(() => expect(section('Inside')).toBeTruthy())
    const shown = within(section('Inside')!)
    expect(shown.getByText('pingbird')).toBeTruthy()
    expect(shown.getByText('kites')).toBeTruthy()
    // Its own note is not one of its children.
    expect(shown.queryByText('Ideas')).toBeNull()

    fireEvent.click(shown.getByText('kites'))
    await waitFor(() => expect(editor().value).toContain('# Kites'))
  })

  /**
   * **The left pane's tree, at the end of the note.** The section draws its folder
   * with `FolderTree` — the same component, the same props — so a nested note in
   * there has its own chevron and shows what is inside *it*. The alternative was a
   * flat list of the first level, which is what this had and what the report was
   * about.
   */
  it('expands a nested note inside it, and the level under that', async () => {
    disk.write('/v/Ideas/Deep/Deep.md', '# Deep\n')
    disk.write('/v/Ideas/Deep/Deeper/Deeper.md', '# Deeper\n')
    disk.write('/v/Ideas/Deep/Deeper/leaf.md', '# Leaf\n')
    await openApp()
    fireEvent.click(row('Ideas'))
    await waitFor(() => expect(section('Inside')).toBeTruthy())

    const inside = () => within(section('Inside')!)
    expect(inside().getByText('Deep')).toBeTruthy()
    // Shut to begin with, as a folder in the tree is.
    expect(inside().queryByText('Deeper')).toBeNull()

    fireEvent.click(inside().getByLabelText('Expand Deep'))
    expect(inside().getByText('Deeper')).toBeTruthy()
    fireEvent.click(inside().getByLabelText('Expand Deeper'))
    expect(inside().getByText('leaf')).toBeTruthy()
  })

  /** The three read outward: where the note sits, what it holds, what points at
   *  it. Only the middle one comes and goes. */
  it('sits between the path and the backlinks, and is absent for a plain note', async () => {
    await openApp()
    fireEvent.click(row('Ideas'))
    await waitFor(() => expect(section('Inside')).toBeTruthy())
    expect(
      [...document.querySelectorAll('.note-section')].map((el) =>
        (el.querySelector('.folder-header')?.textContent ?? '').replace(/\d+$/, '')
      )
    ).toEqual(['Path', 'Inside', 'Backlinks'])

    await openTheNote('inbox')
    await waitFor(() => expect(section('Inside')).toBeNull())
    expect(section('Backlinks')).toBeTruthy()
  })
})

/**
 * **Where a note is reached from**, at the end of it beside what it holds and what
 * points at it. The tree answers this only while the branch is expanded, and the
 * title says the name and not the way in.
 *
 * Every step but the first is a **note**, because a folder is one here — so the
 * path is a row you can follow rather than a line of text.
 */
describe('the path at the end of a note', () => {
  const path = () =>
    [...document.querySelectorAll<HTMLElement>('.note-section')]
      .find((el) => el.querySelector('.folder-header')?.textContent?.includes('Path'))!
  /** The steps, and how far each is indented — the descent is the point. */
  const steps = () =>
    [...path().querySelectorAll('.file-list li')].map((li) => [
      li.querySelector('.row-name')?.textContent,
      (li as HTMLElement).style.getPropertyValue('--guide-x'),
    ])
  const expand = (name: string) =>
    fireEvent.click(within(document.querySelector('.file-list')!).getByLabelText(`Expand ${name}`))

  it('names every folder above the note, each a step further in', async () => {
    disk.write('/v/Areas/Plans/Q3.md', '# Q3\n')
    await openApp()
    expand('Areas')
    await waitFor(() => expect(row('Plans')).toBeTruthy())
    expand('Plans')
    await waitFor(() => expect(row('Q3')).toBeTruthy())
    await openTheNote('Q3')

    // **The vault is not a step**: it is where every note in the pane is, so a row
    // saying so says nothing. Each folder sits one indent past the one above it.
    await waitFor(() => expect(steps()).toEqual([['Areas', stepIn(0)], ['Plans', stepIn(1)]]))
  })

  /** **A nested note's trail stops at its parent.** `Areas/Plans/Plans.md` is known
   *  as `Areas/Plans`, so the folder the note *is* is not a step on the way to it. */
  it('stops at the parent for a nested note', async () => {
    disk.write('/v/Areas/Plans/Plans.md', '# Plans\n')
    await openApp()
    expand('Areas')
    await waitFor(() => expect(row('Plans')).toBeTruthy())
    fireEvent.click(row('Plans'))

    await waitFor(() => expect(steps()).toEqual([['Areas', stepIn(0)]]))
  })

  /**
   * A note at the root has no path, so the section is there and shut — one row of
   * cost, the bargain Backlinks makes when nothing links here. The vault itself is
   * not a step: it is where every note in the pane is.
   */
  it('is shut, with nothing in it, for a note at the top of the vault', async () => {
    await openApp()
    await openTheNote('roadmap')
    await waitFor(() => expect(path()).toBeTruthy())
    expect(steps()).toEqual([])
    // Opened by hand it says so rather than showing an empty list.
    fireEvent.click(within(path()).getByText('Path'))
    await waitFor(() => expect(steps()).toEqual([['At the top of the vault.', '']]))
  })

  it('opens the folder note a step names', async () => {
    disk.write('/v/Areas/Areas.md', '# Areas\n')
    disk.write('/v/Areas/Plans/Q3.md', '# Q3\n')
    await openApp()
    expand('Areas')
    await waitFor(() => expect(row('Plans')).toBeTruthy())
    expand('Plans')
    await waitFor(() => expect(row('Q3')).toBeTruthy())
    await openTheNote('Q3')
    await waitFor(() => expect(steps()).toHaveLength(2))

    fireEvent.click(within(path()).getByText('Areas'))
    await waitFor(() =>
      expect(document.querySelector('.viewer-title')!.textContent).toBe('Areas')
    )
  })
})

/**
 * **Every note takes a note inside it**, and one with no folder yet gets one — but
 * only if a name is actually committed. Converting on the click left an empty
 * nested note behind every `+` somebody thought better of: a folder holding
 * nothing but its own note, drawn with an arrow and an accent as though it were
 * full.
 */
describe('a note inside a note', () => {
  it('asks for a name and touches nothing yet', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('New note in roadmap'))

    expect(await waitFor(() => screen.getByPlaceholderText('Note title…'))).toBeTruthy()
    // Nothing on disk: no folder, and the note is where it was.
    expect(disk.has('/v/roadmap')).toBe(false)
    expect(disk.has('/v/roadmap.md')).toBe(true)
  })

  /**
   * **Pressing the same `+` again leaves the field where it is.** It used to throw
   * away what had been typed and open an empty one: the press blurred the open
   * field, which for a create abandons, and the handler then made a fresh one.
   * Reported from the running app as "it closes the input bar and opens it again".
   */
  it('keeps the open field, and what is typed in it, when the + is pressed again', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('New note in roadmap'))
    const field = await waitFor(() => screen.getByPlaceholderText('Note title…'))
    fireEvent.change(field, { target: { value: 'wayf' } })

    // The press the button declines to let the field lose the keyboard over.
    fireEvent.mouseDown(screen.getByLabelText('New note in roadmap'))
    fireEvent.click(screen.getByLabelText('New note in roadmap'))

    const still = screen.getByPlaceholderText('Note title…') as HTMLInputElement
    expect(still).toBe(field)
    expect(still.value).toBe('wayf')
  })

  /** A different row's `+` is a different question, and does move the field. */
  it('moves to the other row when a different + is pressed', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('New note in roadmap'))
    await waitFor(() => expect(screen.getByPlaceholderText('Note title…')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('New note in inbox'))

    const field = screen.getByPlaceholderText('Note title…') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.closest('li')!.previousElementSibling?.textContent).toContain('inbox')
  })

  /**
   * **A queued save follows the file it was queued for.**
   *
   * Found in a review, then reproduced: type into a note, press `+` to give it a
   * child, and `convertToNested` moves the file while a save is still queued for
   * the old path. The buffer moved its `note` and its `loadedPath` and left the
   * queued write pointing where the note used to be. Measured before the fix —
   * `roadmap/roadmap.md` holding the text from *before* the typing, and a stray
   * `roadmap.md` at the root holding the typing itself. Two notes of one name, with
   * the edit in the wrong one.
   *
   * The test must not wait for the debounce, because waiting is what hides it: the
   * existing create tests all let the save land first.
   */
  it('keeps a still-queued edit with the note when it becomes nested', async () => {
    await openApp()
    await openTheNote('roadmap')
    type('# Roadmap\n\nmid-thought')

    // No waiting: the save is queued, not written.
    fireEvent.click(screen.getByLabelText('New note in roadmap'))
    const field = await waitFor(() => screen.getByPlaceholderText('Note title…'))
    fireEvent.change(field, { target: { value: 'q3' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(disk.has('/v/roadmap/q3.md')).toBe(true))
    await waitFor(() => expect(disk.read('/v/roadmap/roadmap.md')).toContain('mid-thought'))
    // And nothing left behind where the note used to be.
    expect(disk.has('/v/roadmap.md')).toBe(false)
  })

  it('leaves the note alone when the name is abandoned', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('New note in roadmap'))
    const field = await waitFor(() => screen.getByPlaceholderText('Note title…'))

    fireEvent.keyDown(field, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByPlaceholderText('Note title…')).toBeNull())
    expect(disk.has('/v/roadmap')).toBe(false)
    expect(disk.paths()).toContain('/v/roadmap.md')
  })

  it('makes the folder on commit, keeps the text, and opens the new note', async () => {
    await openApp()
    await openTheNote('roadmap')
    type('# Roadmap\n\nThe plan, such as it is.\n')
    await waitFor(() => expect(disk.read('/v/roadmap.md')).toContain('such as it is'))

    fireEvent.click(screen.getByLabelText('New note in roadmap'))
    const field = await waitFor(() => screen.getByPlaceholderText('Note title…'))
    fireEvent.change(field, { target: { value: 'Q3' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(disk.has('/v/roadmap/Q3.md')).toBe(true))
    // `roadmap.md` moved into the folder. The move itself rewrites nothing — the
    // body arrives untouched — and then `path:` is written, which is the one thing
    // that does edit the note and the reason this is not a byte-for-byte compare.
    expect(disk.read('/v/roadmap/roadmap.md')).toContain('# Roadmap\n\nThe plan, such as it is.\n')
    // `path: roadmap`, not `roadmap/roadmap`: the note is the row the tree draws,
    // and `roadmap/roadmap` names a page nothing in the app shows.
    expect(disk.read('/v/roadmap/roadmap.md')).toContain('path: roadmap\n')
    expect(disk.has('/v/roadmap.md')).toBe(false)
    // It has something in it now, so it has an arrow.
    await waitFor(() => expect(screen.getByLabelText(/^(Collapse|Expand) roadmap$/)).toBeTruthy())
  })

  it('gives a note with nothing in it no arrow at all', async () => {
    // `Ideas/` holds `pingbird`, so it has one; a folder note on its own does not.
    disk.write('/v/Empty/Empty.md', '# Empty\n')
    await openApp()

    await waitFor(() => expect(row('Empty')).toBeTruthy())
    expect(screen.getByLabelText(/^(Collapse|Expand) Ideas$/)).toBeTruthy()
    expect(screen.queryByLabelText(/^(Collapse|Expand) Empty$/)).toBeNull()
  })
})

/**
 * `path:` — where a note sits, written into the note.
 *
 * The property exists so the file says where it belongs when it is read anywhere
 * else, which means the app has to keep it true: a `path:` naming a place the note
 * is not would be worse than no property. So every operation that moves a note
 * writes it, and a folder writes every note under it.
 */
describe('the path property', () => {
  const pathIn = (file: string) => /^path: (.*)$/m.exec(disk.read(file) ?? '')?.[1]

  it('is written when a note is created', async () => {
    await openApp()
    fireEvent.click(sidebarButton('New note'))
    const field = await waitFor(() => screen.getByPlaceholderText('Note title…'))
    fireEvent.change(field, { target: { value: 'Kickoff' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(disk.has('/v/Kickoff.md')).toBe(true))
    expect(pathIn('/v/Kickoff.md')).toBe('Kickoff')
  })

  it('follows a rename', async () => {
    await openApp()
    fireEvent.doubleClick(row('roadmap'))
    const field = screen.getByDisplayValue('roadmap')
    fireEvent.change(field, { target: { value: 'plan' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(disk.has('/v/plan.md')).toBe(true))
    expect(pathIn('/v/plan.md')).toBe('plan')
  })

  it('follows the note into a folder, and the folder when it moves', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('New note in roadmap'))
    const field = await waitFor(() => screen.getByPlaceholderText('Note title…'))
    fireEvent.change(field, { target: { value: 'Q3' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    // The note that became a folder, and the note that went into it.
    await waitFor(() => expect(pathIn('/v/roadmap/Q3.md')).toBe('roadmap/Q3'))
    // The folder note is known by its folder, which is what the tree calls it.
    expect(pathIn('/v/roadmap/roadmap.md')).toBe('roadmap')
  })
})

/**
 * **A name being typed belongs to the tree it was asked in.** Two panes draw one
 * tree — the left pane's and the *Inside* section at the end of a nested note — and
 * both drew the create field from the same target: two inputs, the second taking
 * the keyboard on mount, and the first cancelling because a create abandons on
 * blur. So pressing `+` on a folder whose own note was open opened a field and
 * threw it away in the same breath. Found while testing something else, from the
 * blur's `relatedTarget`: another `rename-input`.
 */
describe('the create field, with a nested note open', () => {
  it('opens once, in the tree the + was pressed in', async () => {
    disk.write('/v/Notes/kept.md', '# kept\n')
    await openApp()
    const list = () => document.querySelector('.pane-section .file-list') as HTMLElement
    // Clicking the folder's row opens its own note, which draws the second tree.
    fireEvent.click(within(list()).getByText('Notes'))
    await waitFor(() => expect(within(list()).getByText('kept')).toBeTruthy())
    await waitFor(() => expect(document.querySelectorAll('.note-section').length).toBeGreaterThan(0))

    const plus = document.querySelector('[aria-label="New note in Notes"]')!
    fireEvent.mouseDown(plus)
    fireEvent.click(plus)

    const fields = () => document.querySelectorAll('input.rename-input')
    await waitFor(() => expect(fields()).toHaveLength(1))
    // And it stays: nothing else has taken the keyboard from it.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(fields()).toHaveLength(1)
    expect(fields()[0].closest('.sidebar')).toBeTruthy()
  })
})

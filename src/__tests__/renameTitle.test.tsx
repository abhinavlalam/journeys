/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'
import { localDateStamp } from '../clock'
import { readProperty } from '../properties'

/**
 * Renaming a note by its title, with every link to it following; otherwise
 * `[[Roadmap]]` points at a note to be created once `Roadmap.md` is renamed.
 * The rename is the tree's own handler, so this covers the title as a way in
 * and the link rewriting end to end. `links.test.ts` pins the rewriting rule.
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
})

const tree = () => within(document.querySelector('.sidebar .file-list')!)
const viewer = () => within(document.querySelector('.viewer:not([hidden])')!)


/** Opens `name` from the tree and waits for the reading pane to show it. */
async function open(name: string) {
  fireEvent.click(tree().getByText(name))
  await waitFor(() => expect(viewer().getByText(name)).toBeTruthy())
}

/** Types a new name over the title and commits with Enter. */
function renameTo(typed: string) {
  fireEvent.click(document.querySelector('.viewer:not([hidden]) .viewer-title') as HTMLElement)
  const field = screen.getByLabelText('Note name')
  fireEvent.change(field, { target: { value: typed } })
  fireEvent.keyDown(field, { key: 'Enter' })
}

describe('renaming from the title', () => {
  it('renames the file', async () => {
    disk.write('/v/target.md', '# Target\n')
    await openApp()
    await open('target')
    renameTo('quarry')

    await waitFor(() => expect(disk.has('/v/quarry.md')).toBe(true))
    expect(disk.has('/v/target.md')).toBe(false)
    // The title is the new name, and the pane still shows the note.
    await waitFor(() => expect(viewer().getByText('quarry')).toBeTruthy())
  })

  /** A link into the note follows it. */
  it('rewrites the links that pointed at it', async () => {
    disk.write('/v/target.md', '# Target\n')
    disk.write('/v/source.md', '# Source\n\nSee [[target]] and [[target|the detail]].\n')
    disk.write('/v/elsewhere.md', '# Elsewhere\n\nA [named link](target.md) too.\n')
    await openApp()
    await open('target')
    renameTo('quarry')

    await waitFor(() => expect(disk.read('/v/source.md')).toContain('[[quarry]]'))
    // The alias is what the link is called, not the note's name.
    expect(disk.read('/v/source.md')).toContain('[[quarry|the detail]]')
    await waitFor(() => expect(disk.read('/v/elsewhere.md')).toContain('[named link](quarry.md)'))
  })

  /**
   * The editor takes up the `path` the rename wrote. The property block
   * landed on disk while the editor held the text from before it, so
   * the next key saved the old text back and the property was lost.
   */
  it('keeps the path property the rename wrote when typing continues', async () => {
    disk.write('/v/target.md', '# Target\n\nSome body.\n')
    await openApp()
    await open('target')
    renameTo('quarry')
    await waitFor(() => expect(readProperty(disk.read('/v/quarry.md') ?? '', 'path')).toBe('quarry'))

    // The editor holds the note as it is now, property and all.
    const editor = screen.getByTestId('editor') as HTMLTextAreaElement
    await waitFor(() => expect(readProperty(editor.value, 'path')).toBe('quarry'))

    fireEvent.change(editor, { target: { value: `${editor.value}One more line.\n` } })
    await waitFor(() => expect(disk.read('/v/quarry.md')).toContain('One more line.'))
    expect(readProperty(disk.read('/v/quarry.md') ?? '', 'path')).toBe('quarry')
  })

  it('leaves a note that links to something else untouched', async () => {
    const other = '# Other\n\nSee [[roadmap]] and https://example.test/target.\n'
    disk.write('/v/target.md', '# Target\n')
    disk.write('/v/other.md', other)
    await openApp()
    await open('target')
    renameTo('quarry')

    await waitFor(() => expect(disk.has('/v/quarry.md')).toBe(true))
    expect(disk.read('/v/other.md')).toBe(other)
  })

  /**
   * A nested note is its folder: `Areas/Plans/Plans.md` pairs with
   * `Areas/Plans/`, so renaming the file alone would leave a folder with no note.
   * The tree renames such a row by renaming the folder, and so does the title.
   */
  it('renames the folder when the note is a folder’s own', async () => {
    disk.write('/v/Areas/Plans/Plans.md', '---\npath: Areas/Plans\n---\n\n# Plans\n')
    disk.write('/v/Areas/Plans/Q3.md', '---\npath: Areas/Plans\n---\n\n# Q3\n')
    disk.write('/v/index.md', '# Index\n\nSee [[Areas/Plans]] and [[Q3]].\n')
    await openApp()

    fireEvent.click(tree().getByLabelText('Expand Areas'))
    await waitFor(() => expect(tree().getByText('Plans')).toBeTruthy())
    fireEvent.click(tree().getByText('Plans'))
    await waitFor(() => expect(viewer().getByText('Plans')).toBeTruthy())

    renameTo('Roadmaps')

    // The folder, its own note, and the child inside it.
    await waitFor(() => expect(disk.has('/v/Areas/Roadmaps/Roadmaps.md')).toBe(true))
    expect(disk.has('/v/Areas/Roadmaps/Q3.md')).toBe(true)
    expect(disk.has('/v/Areas/Plans/Plans.md')).toBe(false)

    // The path link follows the folder; the child's name did not
    // change, so the link to it stays.
    await waitFor(() => expect(disk.read('/v/index.md')).toContain('[[Areas/Roadmaps]]'))
    expect(disk.read('/v/index.md')).toContain('[[Q3]]')
    // And every note under it says where it is now.
    await waitFor(() => expect(readProperty(disk.read('/v/Areas/Roadmaps/Q3.md') ?? '', 'path')).toBe('Areas/Roadmaps/Q3'))
  })

  it('abandons the rename on Escape, and keeps the name on a no-op', async () => {
    disk.write('/v/target.md', '# Target\n')
    await openApp()
    await open('target')

    fireEvent.click(document.querySelector('.viewer:not([hidden]) .viewer-title') as HTMLElement)
    const field = screen.getByLabelText('Note name')
    fireEvent.change(field, { target: { value: 'quarry' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByLabelText('Note name')).toBeNull()
    expect(disk.has('/v/quarry.md')).toBe(false)
    expect(disk.has('/v/target.md')).toBe(true)

    // Retyping the same name is not a rename, and must not error.
    renameTo('target')
    await waitFor(() => expect(screen.queryByLabelText('Note name')).toBeNull())
    expect(disk.has('/v/target.md')).toBe(true)
  })

  /**
   * The field renames the note it was opened for, or nothing. With the field
   * open and typed into, ⌘⇧O opened the daily note, the field blurred, and
   * the daily note got the other note's new name. The blur is fired by hand
   * here: the worst case, with the field still mounted as the note changes.
   */
  /** Also when the note changes before the typing: each key set the remembered name to the new one. */
  it('abandons the rename when the note changed before it was typed into', async () => {
    const { ViewerHeader } = await import('../ViewerHeader')
    const renamed = vi.fn()
    const { rerender } = render(<ViewerHeader name="target" onRename={renamed} />)
    fireEvent.click(screen.getByText('target'))
    rerender(<ViewerHeader name="elsewhere" onRename={renamed} />)
    const field = screen.getByLabelText('Note name')
    fireEvent.change(field, { target: { value: 'wayfinding' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(renamed).not.toHaveBeenCalled()
  })

  it('abandons the rename when the open note changed underneath it', async () => {
    const today = localDateStamp()
    disk.write('/v/target.md', '# Target\n')
    await openApp()
    await open('target')

    fireEvent.click(document.querySelector('.viewer:not([hidden]) .viewer-title') as HTMLElement)
    const field = screen.getByLabelText('Note name')
    fireEvent.change(field, { target: { value: 'wayfinding' } })

    // Something else opens a note while the field has the keyboard.
    fireEvent.keyDown(window, { key: 'o', metaKey: true, shiftKey: true })
    await waitFor(() => expect(disk.has(`/v/Daily/${today}.md`)).toBe(true))
    fireEvent.blur(field)
    await new Promise((resolve) => setTimeout(resolve, 200))

    // The day's note keeps its name, and nothing is renamed.
    expect(disk.has(`/v/Daily/${today}.md`)).toBe(true)
    expect(disk.has('/v/Daily/wayfinding.md')).toBe(false)
    expect(disk.has('/v/wayfinding.md')).toBe(false)
    expect(disk.has('/v/target.md')).toBe(true)
  })

  /**
   * A JSON file has a name too, but nothing of a note's: no
   * properties, no links, and the title is a label.
   */
  it('offers no rename for a file that is not a note', async () => {
    disk.write('/v/data.json', '{ "a": 1 }\n')
    await openApp()
    await open('data.json')
    expect((document.querySelector('.viewer:not([hidden]) .viewer-title') as HTMLButtonElement).disabled).toBe(true)
  })
})

/**
 * A click anywhere in a backlink opens the note. The lines under the
 * row are most of a backlink on screen, and clicking them did nothing.
 */
describe('a backlink', () => {
  const withBacklink = async () => {
    disk.write('/v/target.md', '# Target\n')
    disk.write('/v/source.md', '# Source\n\nSee [[target]] for the detail.\n')
    await openApp()
    await open('target')
    await waitFor(() => expect(viewer().getByText('source')).toBeTruthy())
  }

  it('opens from its name, in one click', async () => {
    await withBacklink()
    fireEvent.click(viewer().getByText('source'))
    await waitFor(() =>
      expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('source')
    )
  })

  it('opens from the line the link is written on, in one click', async () => {
    await withBacklink()
    fireEvent.click(document.querySelector('.backlink-lines li') as HTMLElement)
    await waitFor(() =>
      expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('source')
    )
  })

  /** Selecting a mention's text does not open anything. */
  it('does not open when the click ends a selection', async () => {
    await withBacklink()
    const line = document.querySelector('.backlink-lines li') as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(line)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    fireEvent.click(line)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('target')
    selection.removeAllRanges()
  })
})

/**
 * A folder rename must not leave a note named after the old name. `followFolder` was a
 * prefix swap, and a folder rename changes its own note's name too: `Plans/Plans.md`
 * became `Roadmaps/Plans.md` in the editor, and the next save created that file.
 */
describe('after a folder note is renamed', () => {
  it('leaves no note behind under the old name', async () => {
    disk.write('/v/Areas/Plans/Plans.md', '# Plans\n')
    disk.write('/v/Areas/Plans/Q3.md', '# Q3\n')
    await openApp()

    fireEvent.click(tree().getByLabelText('Expand Areas'))
    await waitFor(() => expect(tree().getByText('Plans')).toBeTruthy())
    fireEvent.click(tree().getByText('Plans'))
    await waitFor(() => expect(viewer().getByText('Plans')).toBeTruthy())

    renameTo('Roadmaps')
    await waitFor(() => expect(disk.has('/v/Areas/Roadmaps/Roadmaps.md')).toBe(true))

    // The editor holds the note under its new name, so the next typing is saved there.
    const editor = screen.getByTestId('editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '# Roadmaps\n\nStill the same note.\n' } })
    await waitFor(
      () => expect(disk.read('/v/Areas/Roadmaps/Roadmaps.md')).toContain('Still the same note.')
    )
    expect(disk.has('/v/Areas/Roadmaps/Plans.md')).toBe(false)
    expect(disk.has('/v/Areas/Plans/Plans.md')).toBe(false)
    // And the title shows the new name.
    expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('Roadmaps')
  })
})

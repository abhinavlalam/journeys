/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'

/**
 * One row, three places: the tree, the Actions section and the note's end
 * sections all draw `rows.tsx`'s row, with the same boxes in the same
 * order, so their columns line up. jsdom lays nothing out, so this checks
 * the shape; the geometry was measured in Chrome and matched in all three.
 * A section's heading differs on purpose: no icon, one step up, and bold.
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
  disk.write('/v/Areas/Areas.md', '# Areas\n')
  disk.write('/v/Areas/northwind.md', '# Northwind\n')
  disk.write('/v/roadmap.md', '# Roadmap\n\nsee [[Areas]]\n')
  disk.write('/v/.claude/skills/summarise/SKILL.md', '')
})


/** The boxes a row is made of, in order. */
function shapeOf(row: Element): string[] {
  return [...row.querySelectorAll('*')]
    .map((el) => el.className)
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .flatMap((name) => name.split(/\s+/))
    .filter((name) => name.startsWith('folder-') || name.startsWith('row-'))
}

/**
 * The row a name is in, within `root`: `roadmap` is a row in the
 * tree and a backlink at the end of a note.
 */
const rowNamed = (name: string, root: ParentNode = document) => {
  const found = [...root.querySelectorAll('.row-name')].find((el) => el.textContent === name)
  return found?.closest('.folder-header, button.file-row') as HTMLElement
}

/**
 * Click what a pointer would hit: the name inside the button.
 * The `.folder-header` around it is a `<div>`.
 */
const clickRow = (row: HTMLElement) => fireEvent.click(row.querySelector('.row-name')!)

/** Where a row's indent is written: a group's on its header, a leaf's on its `li`. */
const indentOf = (row: HTMLElement) => ({
  li: (row.closest('li') as HTMLElement).style.paddingLeft,
  row: row.style.paddingLeft,
})

describe('a row', () => {
  it('is the same boxes in the same order, wherever it is drawn', async () => {
    await openApp()
    // The tree: a folder row and a leaf row.
    fireEvent.click(within(document.querySelector('.file-list')!).getByLabelText('Expand Areas'))
    await waitFor(() => expect(rowNamed('northwind')).toBeTruthy())
    const treeFolder = shapeOf(rowNamed('Areas'))
    const treeLeaf = shapeOf(rowNamed('northwind'))
    const treeIndents = [indentOf(rowNamed('Areas')), indentOf(rowNamed('northwind'))]

    // A note's own sections, drawing tree rows in the reading pane.
    clickRow(rowNamed('Areas'))
    // The reading pane, not the first section: Inside and Backlinks
    // are two `.note-section`s and the backlink is in the second.
    const sections = await waitFor(() => {
      const found = document.querySelector('.viewer:not([hidden])')
      expect(found!.querySelector('.viewer:not([hidden]) .note-section')).toBeTruthy()
      return found!
    })
    await waitFor(() => expect(rowNamed('roadmap', sections)).toBeTruthy())
    const footerRow = shapeOf(rowNamed('roadmap', sections))

    // The Actions section.
      await waitFor(() => expect(screen.getByText('Skills')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Expand all actions'))
    await waitFor(() => expect(rowNamed('summarise')).toBeTruthy())
    const actionsGroup = shapeOf(rowNamed('Skills'))
    const actionsRow = shapeOf(rowNamed('summarise'))
    const actionsIndents = [indentOf(rowNamed('Skills')), indentOf(rowNamed('summarise'))]

    // A leaf is a leaf in all three panes.
    expect(actionsRow).toEqual(treeLeaf)
    expect(footerRow).toEqual(treeLeaf)
    // The chevron's column is reserved on every one, keeping a
    // leaf's icon under a folder's.
    for (const shape of [treeFolder, treeLeaf, actionsGroup, actionsRow, footerRow]) {
      expect(shape[0]).toBe('folder-chevron')
    }
    // And a group row is a folder row: the same boxes plus its `+`.
    expect(actionsGroup.filter((name) => name !== 'folder-actions')).toEqual(
      treeFolder.filter((name) => name !== 'folder-actions')
    )

    // The same indent on the same box: a group's on its header, never on
    // the `li` holding its list, where every row inside counted it again.
    expect(actionsIndents).toEqual(treeIndents)
    expect(treeIndents[0].li).toBe('')
  })
})

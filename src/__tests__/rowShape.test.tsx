/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * **One row, three places.** The tree, the Actions section and the two sections at
 * the end of a note all draw `rows.tsx`'s row — and the thing that keeps their
 * columns on one x is that they draw the *same boxes in the same order*, not that
 * three sets of numbers happen to agree.
 *
 * jsdom lays nothing out, so this asserts the shape and not the geometry. The
 * geometry was measured in Chrome, at prose 13 / leading 1.5 / gap 5, and every one
 * of the three came out identical: a row's chevron 19.5 wide, its icon at +19.5 and
 * its name at +43.8 from the pane, a child one 16px step further in at +35.5 and
 * +59.8, and every name at weight 400. A section's *heading* is the exception by
 * design: no icon, one step up and 600, because it is a heading rather
 * than a row.
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

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

/** The boxes a row is made of, in order: what the sheet dresses and what puts every
 *  name on one column. */
function shapeOf(row: Element): string[] {
  return [...row.querySelectorAll('*')]
    .map((el) => el.className)
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .flatMap((name) => name.split(/\s+/))
    .filter((name) => name.startsWith('folder-') || name.startsWith('row-'))
}

/** The row a name is in, within `root` — `roadmap` is a row in the tree *and* a
 *  backlink at the end of a note, so the scope is the question. */
const rowNamed = (name: string, root: ParentNode = document) => {
  const found = [...root.querySelectorAll('.row-name')].find((el) => el.textContent === name)
  return found?.closest('.folder-header, button.file-row') as HTMLElement
}

/** Clicking a row means clicking what a pointer would hit: the name, inside the
 *  button. The `.folder-header` around it is a `<div>` and answers to nothing. */
const clickRow = (row: HTMLElement) => fireEvent.click(row.querySelector('.row-name')!)

describe('a row', () => {
  it('is the same boxes in the same order, wherever it is drawn', async () => {
    await openApp()
    // The tree: a folder row and a leaf row.
    fireEvent.click(within(document.querySelector('.file-list')!).getByLabelText('Expand Areas'))
    await waitFor(() => expect(rowNamed('northwind')).toBeTruthy())
    const treeFolder = shapeOf(rowNamed('Areas'))
    const treeLeaf = shapeOf(rowNamed('northwind'))

    // A note's own sections, which draw the tree's rows in the reading pane.
    clickRow(rowNamed('Areas'))
    // The *reading pane*, not the first section: `Inside` and `Backlinks` are two
    // `.note-section`s and a backlink is in the second.
    const sections = await waitFor(() => {
      const found = document.querySelector('.viewer')
      expect(found!.querySelector('.note-section')).toBeTruthy()
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

    // A leaf is a leaf, in all three panes.
    expect(actionsRow).toEqual(treeLeaf)
    expect(footerRow).toEqual(treeLeaf)
    // The chevron's column is reserved on every one of them, which is what keeps a
    // leaf's icon under a folder's.
    for (const shape of [treeFolder, treeLeaf, actionsGroup, actionsRow, footerRow]) {
      expect(shape[0]).toBe('folder-chevron')
    }
    // And a group row is a folder row: the same boxes, plus its own `+`.
    expect(actionsGroup.filter((name) => name !== 'folder-actions')).toEqual(
      treeFolder.filter((name) => name !== 'folder-actions')
    )
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'

/**
 * A tracker's table, edited in place: a value pressed becomes a field, a row is added
 * and taken out, the rows are sorted by a column, and every write is the one row, so
 * the rest of the file stays as it was written.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))
vi.mock('../SourceEditor', () => ({
  SourceEditor: ({ initialText }: { initialText: string }) => <pre data-testid="text">{initialText}</pre>,
}))

const FILE = '/v/Trackers/expenses.csv'
const written = ['day,amount,what', '2026-10-10,480,"lunch, upstairs"', '2026-10-11,  12.5 ,coffee', ''].join('\n')

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  disk.write(FILE, written)
})

const pane = () => within(document.querySelector('.viewer:not([hidden])') as HTMLElement)
const cell = (name: string) => pane().getByRole('button', { name })
/** A table is a file in the tree, opened into the reading pane. */
async function openTable() {
  await openApp()
  fireEvent.click(within(document.querySelector('.sidebar')!).getByText('Trackers'))
  fireEvent.click(await waitFor(() => within(document.querySelector('.sidebar')!).getByText('expenses.csv')))
  await waitFor(() => expect(cell('what, row 1').textContent).toBe('lunch, upstairs'))
}
const typeInto = (name: string, value: string, key = 'Enter') => {
  const field = pane().getByRole('textbox', { name })
  fireEvent.change(field, { target: { value } })
  fireEvent.keyDown(field, { key })
}

describe('a table edited in place', () => {
  it('writes a changed value back into its row alone, and sums a column of numbers', async () => {
    await openTable()
    expect(pane().getByText('492.5')).toBeTruthy()
    fireEvent.click(cell('what, row 2'))
    typeInto('what, row 2', 'the good coffee')
    // The other row keeps its quotes, and this one its padded number.
    await waitFor(() => expect(disk.read(FILE)).toBe(written.replace('coffee', 'the good coffee')))
  })

  it('adds a row once something is typed in it, going on with Tab', async () => {
    await openTable()
    fireEvent.click(pane().getByRole('button', { name: 'Add a row' }))
    typeInto('day, new row', '2026-10-12', 'Tab')
    typeInto('amount, row 3', '90', 'Tab')
    typeInto('what, row 3', 'bus')
    await waitFor(() => expect(disk.read(FILE)).toBe(`${written}2026-10-12,90,bus\n`))
    // Left empty, a new row was never there.
    fireEvent.click(pane().getByRole('button', { name: 'Add a row' }))
    fireEvent.keyDown(pane().getByRole('textbox', { name: 'day, new row' }), { key: 'Enter' })
    await new Promise((settle) => setTimeout(settle, 1000))
    expect(disk.read(FILE)).toBe(`${written}2026-10-12,90,bus\n`)
  })

  it('takes a row out, and sorts the rows shown without touching the file', async () => {
    await openTable()
    fireEvent.click(pane().getByRole('button', { name: 'Sort by amount' }))
    expect(pane().getAllByRole('button', { name: /^what, row/ }).map((one) => one.textContent)).toEqual(['coffee', 'lunch, upstairs'])
    fireEvent.click(pane().getByRole('button', { name: 'Delete row 1' }))
    await waitFor(() => expect(disk.read(FILE)).toBe(written.replace('2026-10-10,480,"lunch, upstairs"\n', '')))
  })

  /** Switched to after an edit, the text editor held the old text, and its first key saved it over the edit. */
  it('shows the text as edited when switched to Text', async () => {
    await openTable()
    fireEvent.click(cell('amount, row 1'))
    typeInto('amount, row 1', '500')
    fireEvent.click(pane().getByRole('button', { name: 'Text' }))
    expect(screen.getByTestId('text').textContent).toBe(written.replace('480', '500'))
  })
})

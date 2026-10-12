/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'
import { localDateStamp, shortDay } from '../clock'

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
  await waitFor(() => expect(cell('What, row 1').textContent).toBe('lunch, upstairs'))
}
const typeInto = (name: string, value: string, key = 'Enter') => {
  const field = pane().getByRole('textbox', { name })
  fireEvent.change(field, { target: { value } })
  fireEvent.keyDown(field, { key })
}

describe('a table edited in place', () => {
  it('writes a changed value back into its row alone', async () => {
    await openTable()
    fireEvent.click(cell('What, row 2'))
    typeInto('What, row 2', 'the good coffee')
    // The other row keeps its quotes, and this one its padded number.
    await waitFor(() => expect(disk.read(FILE)).toBe(written.replace('coffee', 'the good coffee')))
  })

  it('adds a row once something is typed in it, going on with Tab', async () => {
    await openTable()
    fireEvent.click(pane().getByRole('button', { name: 'Add a row' }))
    typeInto('Day, new row', '2026-10-12', 'Tab')
    typeInto('Amount, row 3', '90', 'Tab')
    typeInto('What, row 3', 'bus')
    await waitFor(() => expect(disk.read(FILE)).toBe(`${written}2026-10-12,90,bus\n`))
    // Left empty, a new row was never there.
    fireEvent.click(pane().getByRole('button', { name: 'Add a row' }))
    fireEvent.keyDown(pane().getByRole('textbox', { name: 'Day, new row' }), { key: 'Enter' })
    await new Promise((settle) => setTimeout(settle, 1000))
    expect(disk.read(FILE)).toBe(`${written}2026-10-12,90,bus\n`)
  })

  it('takes a row out, and sorts the rows shown without touching the file', async () => {
    await openTable()
    fireEvent.click(pane().getByRole('button', { name: 'Sort by Amount' }))
    expect(pane().getAllByRole('button', { name: /^What, row/ }).map((one) => one.textContent)).toEqual(['coffee', 'lunch, upstairs'])
    fireEvent.click(pane().getByRole('button', { name: 'Delete row 1' }))
    await waitFor(() => expect(disk.read(FILE)).toBe(written.replace('2026-10-10,480,"lunch, upstairs"\n', '')))
  })

  /** Read as a ledger is; a field takes the value as it is written, which is what is kept. */
  it('shows a number to its column’s decimals and a day in words, and edits each as written', async () => {
    await openTable()
    expect([cell('Amount, row 1').textContent, cell('Amount, row 2').textContent]).toEqual(['480.0', '12.5'])
    expect(cell('Day, row 1').textContent).toBe(shortDay('2026-10-10', localDateStamp()))
    fireEvent.click(cell('Day, row 1'))
    expect((pane().getByRole('textbox', { name: 'Day, row 1' }) as HTMLInputElement).value).toBe('2026-10-10')
    fireEvent.keyDown(pane().getByRole('textbox', { name: 'Day, row 1' }), { key: 'Escape' })
    fireEvent.click(cell('Amount, row 2'))
    expect((pane().getByRole('textbox', { name: 'Amount, row 2' }) as HTMLInputElement).value).toBe('  12.5 ')
  })

  /** A balance adds up to nothing: how a column is totalled is chosen under it, and kept by its name. */
  it('sums a column of numbers until another way is chosen under it, kept in the settings', async () => {
    await openTable()
    const by = () => pane().getByRole('combobox', { name: 'Total of Amount' }) as HTMLSelectElement
    const total = () => [by().value, by().nextElementSibling!.textContent]
    expect(total()).toEqual(['sum', '492.5'])
    fireEvent.change(by(), { target: { value: 'max' } })
    await waitFor(() => expect(total()).toEqual(['max', '480.0']))
    fireEvent.change(by(), { target: { value: 'none' } })
    await waitFor(() => expect(JSON.parse(disk.read('/v/.config/settings.json')!).columnTotals).toEqual({ amount: 'none' }))
    expect(total()).toEqual(['none', ''])
  })

  it('shows the rows a filter passes, in any column or one, and totals what it shows', async () => {
    await openTable()
    const filter = pane().getByRole('textbox', { name: 'Filter' })
    const shown = () => pane().queryAllByRole('button', { name: /^What, row/ }).map((one) => one.textContent)
    const total = () => (pane().getByRole('combobox', { name: 'Total of Amount' }) as HTMLSelectElement).nextElementSibling!.textContent
    fireEvent.change(filter, { target: { value: 'COFFEE' } })
    expect([shown(), total(), pane().getByText('1 of 2 rows')]).toEqual([['coffee'], '12.5', expect.anything()])
    fireEvent.change(pane().getByRole('combobox', { name: 'Filter in' }), { target: { value: '1' } })
    fireEvent.change(filter, { target: { value: '> 100' } })
    expect([shown(), total()]).toEqual([['lunch, upstairs'], '480.0'])
    fireEvent.change(filter, { target: { value: 'tea' } })
    expect(pane().getByText('No row passes the filter.')).toBeTruthy()
    fireEvent.keyDown(filter, { key: 'Escape' })
    expect(shown()).toEqual(['lunch, upstairs', 'coffee'])
    // Nothing the filter does reaches the file.
    expect(disk.read(FILE)).toBe(written)
  })

  /** A `[[link]]` in a value reads as its name and opens; the rest of the cell edits the value as written. */
  it('opens a link in a value, and edits the value around it as written', async () => {
    disk.write(FILE, 'day,amount,what\n2026-10-10,480,[[roadmap]] review lunch\n')
    await openApp()
    fireEvent.click(within(document.querySelector('.sidebar')!).getByText('Trackers'))
    fireEvent.click(await waitFor(() => within(document.querySelector('.sidebar')!).getByText('expenses.csv')))
    const value = await waitFor(() => cell('What, row 1'))
    expect(value.textContent).toBe('roadmap review lunch')
    fireEvent.click(value)
    expect((pane().getByRole('textbox', { name: 'What, row 1' }) as HTMLInputElement).value).toBe('[[roadmap]] review lunch')
    fireEvent.keyDown(pane().getByRole('textbox', { name: 'What, row 1' }), { key: 'Escape' })
    fireEvent.click(within(cell('What, row 1')).getByRole('button', { name: 'roadmap' }))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')?.textContent).toBe('roadmap'))
  })

  /** Switched to after an edit, the text editor held the old text, and its first key saved it over the edit. */
  it('shows the text as edited when switched to Text', async () => {
    await openTable()
    fireEvent.click(cell('Amount, row 1'))
    typeInto('Amount, row 1', '500')
    fireEvent.click(pane().getByRole('button', { name: 'Text' }))
    expect(screen.getByTestId('text').textContent).toBe(written.replace('480', '500'))
  })
})

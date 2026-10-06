/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * A tag's page: its structure (the properties its lines carry, one per
 * row), then its lines as a table of values or as sentences, the tag's
 * choice. Structure and choice are in `.config/tags.json`; each property's
 * type is in `properties.json`, and `number` columns are summed.
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
  disk.write('/v/.config/properties.json', JSON.stringify({ amount: { type: 'number' }, merchant: { type: 'backlink' } }))
  disk.write('/v/.config/tags.json', JSON.stringify({ expense: { properties: ['amount', 'merchant', 'detail'] } }))
  disk.write(
    '/v/Daily/2026-09-24.md',
    [
      '08:40 #expense lunch amount:: 480 at merchant:: [[Harbour Bistro]]',
      '12:00 #expense coffee amount:: 5 detail:: "with Mira Vance" after',
      '',
    ].join('\n')
  )
})

const pane = () => within(document.querySelector('.sidebar')!)
const viewer = () => within(document.querySelector('.viewer:not([hidden])')!)
/** The first section: the structure. The table uses the same names. */
const structure = () => within(document.querySelector('.viewer:not([hidden]) .note-section') as HTMLElement)
const tags = () => JSON.parse(disk.read('/v/.config/tags.json')!).expense.properties

async function openTag() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Expand all actions'))
  await waitFor(() => expect(pane().getByText('expense')).toBeTruthy())
  fireEvent.click(pane().getByText('expense'))
  await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('#expense'))
}

describe('a tag’s page', () => {
  it('lists its properties with their types, and tabulates its lines, summing the numbers', async () => {
    await openTag()
    const rows = () => [...document.querySelectorAll('.line-table tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim())
    )
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(structure().getByText('amount').closest('.note-row')!.textContent).toContain('number')
    expect(structure().getByText('merchant').closest('.note-row')!.textContent).toContain('backlink')
    // The line's own words come after the clock: what each line is about.
    expect(rows()).toEqual([
      ['2026-09-24', '08:40', 'lunch at', '480', 'Harbour Bistro', ''],
      ['2026-09-24', '12:00', 'coffee after', '5', '', 'with Mira Vance'],
    ])
    const sum = [...document.querySelectorAll('.line-sum td')].map((td) => td.textContent)
    expect(sum).toEqual(['sum', '', '', '485', '', ''])
  })

  /** A tag whose subject is prose: without its words, the table listed doses and not what was taken. */
  it('shows each line’s own words, its links by their names, and no column for a tag that has none', async () => {
    disk.write('/v/.config/tags.json', JSON.stringify({ expense: { properties: ['amount'] }, supplement: { properties: ['dose'] } }))
    disk.write(
      '/v/Daily/2026-09-24.md',
      ['08:45 #supplement [[Fish Oil|fish oil]] dose:: "2 tablets"', '- #supplement Vitamin D, with breakfast dose:: 1', '09:00 #expense amount:: 5', ''].join('\n')
    )
    const { default: App } = await import('../App')
    render(<App />)
    await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Expand all actions'))
    fireEvent.click(await waitFor(() => pane().getByText('supplement')))
    const cells = () => [...document.querySelectorAll('.line-table tbody tr')].map((tr) => tr.querySelectorAll('td')[2]?.textContent)
    await waitFor(() => expect(cells()).toEqual(['fish oil', 'Vitamin D, with breakfast']))
    expect(viewer().getByRole('button', { name: 'fish oil' })).toBeTruthy()

    // `#expense` lines are all properties, and their table is as it was.
    fireEvent.click(pane().getByText('expense'))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('#expense'))
    await waitFor(() => expect([...document.querySelectorAll('.viewer:not([hidden]) .line-table th')].map((th) => th.textContent)).toEqual(['note', 'when', 'amount']))
  })

  /** Which properties a day totals is the owner's to choose, on the tag's page. */
  it('chooses what a day totals, and keeps the choice in tags.json', async () => {
    await openTag()
    const row = await waitFor(() => viewer().getByRole('button', { name: 'Stop totalling amount each day' }))
    expect(viewer().queryByRole('button', { name: /totalling merchant/ })).toBeNull()
    fireEvent.click(row)
    const written = () => JSON.parse(disk.read('/v/.config/tags.json')!).expense
    await waitFor(() => expect(written().totals).toEqual([]))
    fireEvent.click(await waitFor(() => viewer().getByRole('button', { name: 'Total amount each day' })))
    await waitFor(() => expect(written().totals).toEqual([{ property: 'amount', by: 'sum', show: 'both' }]))

    // How it is combined, what it is called, where it shows: each kept as set.
    fireEvent.change(await waitFor(() => viewer().getByLabelText('How amount is combined')), { target: { value: 'average' } })
    await waitFor(() => expect(written().totals[0].by).toBe('average'))
    const label = viewer().getByLabelText('What amount’s total is called'.replace('’', "'"))
    fireEvent.change(label, { target: { value: 'spent' } })
    fireEvent.blur(label)
    await waitFor(() => expect(written().totals[0].label).toBe('spent'))
    fireEvent.change(viewer().getByLabelText('Where amount’s total shows'.replace('’', "'")), { target: { value: 'note' } })
    await waitFor(() => expect(written().totals).toEqual([{ property: 'amount', by: 'average', show: 'note', label: 'spent' }]))
  })

  it('keeps the colour chosen for the tag in tags.json', async () => {
    await openTag()
    fireEvent.click(await waitFor(() => viewer().getByRole('button', { name: 'Amber' })))
    await waitFor(() => expect(JSON.parse(disk.read('/v/.config/tags.json')!).expense.color).toBe('amber'))
    await waitFor(() => expect(viewer().getByRole('button', { name: 'Amber' }).getAttribute('aria-pressed')).toBe('true'))
  })

  /** A day written by kind heads its expenses with `#expense` alone, which was a row of empty cells. */
  it('leaves a line of tags alone out of the table, and keeps it in the list', async () => {
    disk.write('/v/Daily/2026-09-25.md', ['#expense', '    09:10 #expense tea amount:: 3', ''].join('\n'))
    await openTag()
    const rows = () => [...document.querySelectorAll('.line-table tbody tr')].map((tr) => tr.querySelector('td + td')?.textContent)
    await waitFor(() => expect(rows()).toEqual(['08:40', '12:00', '09:10']))
    expect(viewer().getByText('3 lines')).toBeTruthy()
    fireEvent.click(viewer().getByRole('button', { name: 'List' }))
    await waitFor(() => expect(viewer().getByText('4 lines')).toBeTruthy())
  })

  it('quotes each line as the note reads it, names and quotes left out', async () => {
    await openTag()
    fireEvent.click(await waitFor(() => viewer().getByRole('button', { name: 'List' })))
    await waitFor(() => expect(viewer().getByText('08:40 #expense lunch 480 at Harbour Bistro')).toBeTruthy())
    expect(viewer().getByText('12:00 #expense coffee 5 with Mira Vance after')).toBeTruthy()
  })

  it('adds a property with its +, and takes one off with its ×', async () => {
    await openTag()
    fireEvent.click(await waitFor(() => viewer().getByLabelText('Add a property')))
    const field = viewer().getByPlaceholderText('Property name…')
    fireEvent.change(field, { target: { value: 'category' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(tags()).toEqual(['amount', 'merchant', 'detail', 'category']))

    // Typed as a line writes it, `name::` is the name; one already there adds nothing.
    fireEvent.click(viewer().getByLabelText('Add a property'))
    fireEvent.change(viewer().getByPlaceholderText('Property name…'), { target: { value: 'venue::' } })
    fireEvent.keyDown(viewer().getByPlaceholderText('Property name…'), { key: 'Enter' })
    await waitFor(() => expect(tags()).toEqual(['amount', 'merchant', 'detail', 'category', 'venue']))
    fireEvent.click(viewer().getByLabelText('Add a property'))
    fireEvent.change(viewer().getByPlaceholderText('Property name…'), { target: { value: 'Amount' } })
    fireEvent.keyDown(viewer().getByPlaceholderText('Property name…'), { key: 'Enter' })

    // An invalid name keeps the field and says why.
    fireEvent.click(viewer().getByLabelText('Add a property'))
    const wrong = viewer().getByPlaceholderText('Property name…')
    // Typed as meant: no autocorrect, no capitals it did not type.
    expect([wrong.getAttribute('autocorrect'), wrong.getAttribute('autocapitalize'), wrong.getAttribute('spellcheck')]).toEqual(['off', 'off', 'false'])
    fireEvent.change(wrong, { target: { value: 'two words' } })
    fireEvent.keyDown(wrong, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText(/two words is not a property name/)).toBeTruthy())
    expect((viewer().getByPlaceholderText('Property name…') as HTMLInputElement).value).toBe('two words')
    fireEvent.keyDown(wrong, { key: 'Escape' })

    fireEvent.click(viewer().getByLabelText('Remove detail'))
    await waitFor(() => expect(tags()).toEqual(['amount', 'merchant', 'category', 'venue']))
  })

  /**
   * A table for a tag with a structure until told otherwise; the choice
   * is kept beside the structure, and the timeline reads it too.
   */
  it('draws its lines as a table or a list, and keeps the choice in tags.json', async () => {
    await openTag()
    const view = (name: string) => viewer().getByRole('button', { name })
    await waitFor(() => expect(document.querySelector('.line-table')).toBeTruthy())
    expect(view('Table').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(view('List'))
    await waitFor(() => expect(JSON.parse(disk.read('/v/.config/tags.json')!).expense).toEqual({ properties: ['amount', 'merchant', 'detail'], view: 'list' }))
    expect(document.querySelector('.line-table')).toBeNull()
    expect(viewer().getByText('08:40 #expense lunch 480 at Harbour Bistro')).toBeTruthy()

    fireEvent.click(view('Table'))
    await waitFor(() => expect(JSON.parse(disk.read('/v/.config/tags.json')!).expense.view).toBe('table'))
    expect(document.querySelector('.line-table')).toBeTruthy()
  })

  it('is a list for a tag with no structure', async () => {
    disk.write('/v/Daily/2026-09-25.md', '09:00 #reading the second chapter\n')
    const { default: App } = await import('../App')
    render(<App />)
    await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Expand all actions'))
    fireEvent.click(await waitFor(() => pane().getByText('reading')))
    await waitFor(() => expect(viewer().getByText('09:00 #reading the second chapter')).toBeTruthy())
    expect(viewer().getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('opens a property’s own page from its row, where its type is set', async () => {
    await openTag()
    fireEvent.click(await waitFor(() => structure().getByText('amount')))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('amount::'))
    expect((screen.getByRole('combobox', { name: 'Type' }) as HTMLSelectElement).value).toBe('number')
  })
})

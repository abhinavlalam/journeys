/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * **A tag's page**: its structure — the properties its lines carry, one per row —
 * then a table of those values once there are lines, then the lines themselves as
 * the note reads them. The structure is `.config/tags.json`; each property's type
 * is its own, in `properties.json`, and a `number` column is summed.
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
const viewer = () => within(document.querySelector('.viewer')!)
/** The first section on the page: the structure. The table names the same words. */
const structure = () => within(document.querySelector('.viewer .note-section') as HTMLElement)
const tags = () => JSON.parse(disk.read('/v/.config/tags.json')!).expense.properties

async function openTag() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Expand all actions'))
  await waitFor(() => expect(pane().getByText('expense')).toBeTruthy())
  fireEvent.click(pane().getByText('expense'))
  await waitFor(() => expect(document.querySelector('.viewer-title')!.textContent).toBe('#expense'))
}

describe('a tag’s page', () => {
  it('lists its properties with their types, and tabulates its lines, summing the numbers', async () => {
    await openTag()
    const rows = () => [...document.querySelectorAll('.collection-table tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim())
    )
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(structure().getByText('amount').closest('.note-row')!.textContent).toContain('number')
    expect(structure().getByText('merchant').closest('.note-row')!.textContent).toContain('backlink')
    expect(rows()).toEqual([
      ['2026-09-24', '08:40', '480', 'Harbour Bistro', ''],
      ['2026-09-24', '12:00', '5', '', 'with Mira Vance'],
    ])
    const sum = [...document.querySelectorAll('.collection-sum td')].map((td) => td.textContent)
    expect(sum).toEqual(['sum', '', '485', '', ''])
  })

  it('quotes each line as the note reads it, names and quotes left out', async () => {
    await openTag()
    fireEvent.click(await waitFor(() => viewer().getByLabelText('Expand Lines')))
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

    // A name already there, or one that is not a name, adds nothing.
    fireEvent.click(viewer().getByLabelText('Add a property'))
    fireEvent.change(viewer().getByPlaceholderText('Property name…'), { target: { value: 'Amount' } })
    fireEvent.keyDown(viewer().getByPlaceholderText('Property name…'), { key: 'Enter' })
    fireEvent.click(viewer().getByLabelText('Add a property'))
    fireEvent.change(viewer().getByPlaceholderText('Property name…'), { target: { value: 'two words' } })
    fireEvent.keyDown(viewer().getByPlaceholderText('Property name…'), { key: 'Enter' })

    fireEvent.click(viewer().getByLabelText('Remove detail'))
    await waitFor(() => expect(tags()).toEqual(['amount', 'merchant', 'category']))
  })

  it('opens a property’s own page from its row, where its type is set', async () => {
    await openTag()
    fireEvent.click(await waitFor(() => structure().getByText('amount')))
    await waitFor(() => expect(document.querySelector('.viewer-title')!.textContent).toBe('amount::'))
    expect((screen.getByRole('combobox', { name: 'Type' }) as HTMLSelectElement).value).toBe('number')
  })
})

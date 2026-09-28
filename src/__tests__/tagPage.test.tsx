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
    const rows = () => [...document.querySelectorAll('.line-table tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim())
    )
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(structure().getByText('amount').closest('.note-row')!.textContent).toContain('number')
    expect(structure().getByText('merchant').closest('.note-row')!.textContent).toContain('backlink')
    expect(rows()).toEqual([
      ['2026-09-24', '08:40', '480', 'Harbour Bistro', ''],
      ['2026-09-24', '12:00', '5', '', 'with Mira Vance'],
    ])
    const sum = [...document.querySelectorAll('.line-sum td')].map((td) => td.textContent)
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

    // Typed as a line writes it, `name::` is the name; one already there adds nothing.
    fireEvent.click(viewer().getByLabelText('Add a property'))
    fireEvent.change(viewer().getByPlaceholderText('Property name…'), { target: { value: 'venue::' } })
    fireEvent.keyDown(viewer().getByPlaceholderText('Property name…'), { key: 'Enter' })
    await waitFor(() => expect(tags()).toEqual(['amount', 'merchant', 'detail', 'category', 'venue']))
    fireEvent.click(viewer().getByLabelText('Add a property'))
    fireEvent.change(viewer().getByPlaceholderText('Property name…'), { target: { value: 'Amount' } })
    fireEvent.keyDown(viewer().getByPlaceholderText('Property name…'), { key: 'Enter' })

    // One that is not a name keeps the field, and says why.
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

  it('opens a property’s own page from its row, where its type is set', async () => {
    await openTag()
    fireEvent.click(await waitFor(() => structure().getByText('amount')))
    await waitFor(() => expect(document.querySelector('.viewer-title')!.textContent).toBe('amount::'))
    expect((screen.getByRole('combobox', { name: 'Type' }) as HTMLSelectElement).value).toBe('number')
  })
})

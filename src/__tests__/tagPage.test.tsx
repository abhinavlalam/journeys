/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * A tag's page: its colour, and every line carrying it, under its note, as the note
 * reads it. A tag is a label; what a tracker counts is in its table.
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
  disk.write('/v/.config/tags.json', JSON.stringify({ expense: {} }))
  disk.write(
    '/v/Daily/2026-09-24.md',
    ['08:40 #expense lunch amount:: 480 at merchant:: [[Harbour Bistro]]', '12:00 #expense coffee amount:: 5 detail:: "with Mira Vance" after', ''].join('\n')
  )
})

const pane = () => within(document.querySelector('.sidebar')!)
const viewer = () => within(document.querySelector('.viewer:not([hidden])')!)

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
  it('quotes each line as the note reads it, names and quotes left out', async () => {
    await openTag()
    await waitFor(() => expect(viewer().getByText('08:40 #expense lunch 480 at Harbour Bistro')).toBeTruthy())
    expect(viewer().getByText('12:00 #expense coffee 5 with Mira Vance after')).toBeTruthy()
    // A label now: no structure, table or totals of its own.
    expect(viewer().queryByText('Properties')).toBeNull()
    expect(document.querySelector('.viewer:not([hidden]) .line-table')).toBeNull()
  })

  it('keeps the colour picked in tags.json', async () => {
    await openTag()
    fireEvent.click(viewer().getByRole('button', { name: 'Green' }))
    await waitFor(() => expect(JSON.parse(disk.read('/v/.config/tags.json')!).expense.color).toBe('green'))
    expect(viewer().getByRole('button', { name: 'Green' }).getAttribute('aria-pressed')).toBe('true')
  })
})

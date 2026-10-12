/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { dayDate, localDateStamp, monthName, shortDay } from '../clock'
import { monthAfter, moneyText } from '../expenses'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * The Expenses application: a month of the expenses table at a glance. The table is
 * picked on the page the first time and kept in the settings; the page reads it and
 * a press opens it, or a day's note.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

const today = localDateStamp()
const month = today.slice(0, 7)
const before = monthAfter(month, -1)
const SHEET = 'Trackers/spend.csv'
const sheet = [
  'day,time,amount,currency,for,category,merchant,account,end-amount',
  `${before}-01,09:10,40,EUR,,Plants,Northwind Market,Harbour Card,960`,
  `${month}-01,08:00,12.5,EUR,fern,Plants,Northwind Market,Harbour Card,947.5`,
  `${month}-01,13:00,30,EUR,lunch,Tea,Harbour Bistro,Harbour Card,917.5`,
  '',
].join('\n')
const settingsFile = '/v/.config/settings.json'

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  disk.write(`/v/${SHEET}`, sheet)
  disk.write('/v/Trackers/plants.csv', 'plant,watered\nfern,2026-10-01\n')
})

const viewer = () => within(document.querySelector('.viewer:not([hidden])') as HTMLElement)
/** A tile's figure, by the word under it. */
const tile = (name: string) =>
  within(document.querySelector('.viewer:not([hidden]) .day-totals') as HTMLElement).getByText(name).previousElementSibling?.textContent

async function openExpenses(settings?: Record<string, unknown>) {
  if (settings) disk.write(settingsFile, JSON.stringify(settings))
  const { default: App } = await import('../App')
  render(<App />)
  fireEvent.click(await screen.findByLabelText('Expenses'))
}

describe('the Expenses application', () => {
  it('asks which table holds the expenses, and keeps the one pressed in the settings', async () => {
    await openExpenses()
    await waitFor(() => expect(viewer().getByText('Which table holds your expenses?')).toBeTruthy())
    expect(viewer().getByText('plants.csv')).toBeTruthy()
    fireEvent.click(viewer().getByText('spend.csv'))
    await waitFor(() => expect(JSON.parse(disk.read(settingsFile)!).expensesSheet).toBe(SHEET))
    await waitFor(() => expect(tile('Spent')).toBe(moneyText(42.5, 'EUR')))
  })

  it('shows a month at a glance, and steps back to the one before', async () => {
    await openExpenses({ expensesSheet: SHEET })
    await waitFor(() => expect(tile('Spent')).toBe(moneyText(42.5, 'EUR')))
    expect(tile('Expenses')).toBe('2')
    expect(viewer().getByText('Tea').parentElement!.textContent).toContain(moneyText(30, 'EUR', 0))
    expect(viewer().getByText('Accounts')).toBeTruthy()
    expect(viewer().getByText(moneyText(917.5, 'EUR'))).toBeTruthy()

    fireEvent.click(viewer().getByRole('button', { name: 'The month before' }))
    expect(viewer().getByText(monthName.format(dayDate(`${before}-01`)))).toBeTruthy()
    expect(tile('Spent')).toBe(moneyText(40, 'EUR'))
    // The table starts here: nothing before it, and nothing to step back to.
    expect((viewer().getByRole('button', { name: 'The month before' }) as HTMLButtonElement).disabled).toBe(true)
    expect(viewer().getByText(moneyText(960, 'EUR'))).toBeTruthy()
  })

  it('opens the table from a line, and a day’s note from its column', async () => {
    await openExpenses({ expensesSheet: SHEET })
    fireEvent.click(await waitFor(() => viewer().getByText('fern')))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Day, row 1' })).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Expenses'))
    const first = `${month}-01`
    fireEvent.click(await waitFor(() => viewer().getByRole('button', { name: new RegExp(`^${shortDay(first, today)}:`) })))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')?.textContent).toBe(first))
  })

  it('asks again when the table it read is gone', async () => {
    await openExpenses({ expensesSheet: 'Trackers/old.csv' })
    await waitFor(() => expect(viewer().getByText('old.csv is gone: which table holds your expenses?')).toBeTruthy())
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * **The timeline**: the daily notes as each day happened, oldest at the top and
 * today at the bottom. A note written by kind — groups headed by a line of tags —
 * reads by clock; a moment and a block of time read apart; a tag drawn as a table
 * shows its fields, and the day closes on its totals. A press on an entry edits its
 * line where it stands.
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
  disk.write('/v/.config/tags.json', JSON.stringify({ expense: { properties: ['amount', 'merchant'] } }))
  disk.write('/v/Daily/2026-09-20.md', '08:00 #walk by the river\n')
  disk.write(
    '/v/Daily/2026-09-21.md',
    [
      '#timeline',
      '     13:00 to 13:50 review with [[Mira Vance]]',
      '     09:00 standup',
      '',
      '#expense',
      '     12:30 #expense lunch amount:: 480 merchant:: [[Harbour Bistro]]',
      '     08:30 #expense amount:: 60',
      '',
      '#diet',
      '     08:45 #food oats',
      '',
    ].join('\n')
  )
})

const viewer = () => within(document.querySelector('.viewer:not([hidden])') as HTMLElement)
const days = () => [...document.querySelectorAll('.viewer:not([hidden]) .note-section')]
const entries = (day: Element) =>
  [...day.querySelectorAll('.timeline-entry')].map((one) => [
    one.querySelector('.timeline-when')!.textContent,
    one.querySelector('.timeline-what')!.textContent,
    one.querySelector('.timeline-group')?.textContent ?? '',
    one.classList.contains('block') ? 'block' : 'moment',
  ])

async function openTimeline() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Timeline'))
  await waitFor(() => expect(days()).toHaveLength(2))
}

describe('the timeline', () => {
  it('reads the days oldest first, each by clock across its groups', async () => {
    await openTimeline()
    const [first, second] = days()
    expect(entries(first)).toEqual([['08:00', '#walk by the river', '', 'moment']])
    expect(entries(second)).toEqual([
      ['08:30', '#expenseamount 60', '', 'moment'],
      ['08:45', '#food oats', 'diet', 'moment'],
      ['09:00', 'standup', 'timeline', 'moment'],
      ['12:30', '#expense lunchamount 480merchant Harbour Bistro', '', 'moment'],
      ['13:00–13:5050 min', 'review with Mira Vance', 'timeline', 'block'],
    ])
    expect(second.querySelector('.timeline-totals')!.textContent).toBe('#expense amount 540')
  })

  it('edits an entry’s line where it stands, on a press, and writes nothing else', async () => {
    await openTimeline()
    const before = disk.read('/v/Daily/2026-09-21.md')!
    fireEvent.click(viewer().getByText('standup'))
    const field = await waitFor(() => screen.getByTestId('line-editor') as HTMLInputElement)
    expect(field.value).toBe('09:00 standup')
    fireEvent.change(field, { target: { value: '09:10 standup, late' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(disk.read('/v/Daily/2026-09-21.md')).toBe(before.replace('09:00 standup', '09:10 standup, late')))
    await waitFor(() => expect(viewer().getByText('standup, late')).toBeTruthy())
    expect(screen.queryByTestId('line-editor')).toBeNull()
  })

  it('leaves the note as it was on Escape', async () => {
    await openTimeline()
    const before = disk.read('/v/Daily/2026-09-21.md')
    fireEvent.click(viewer().getByText('standup'))
    const field = await waitFor(() => screen.getByTestId('line-editor'))
    fireEvent.change(field, { target: { value: '09:10 standup, late' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('line-editor')).toBeNull())
    expect(disk.read('/v/Daily/2026-09-21.md')).toBe(before)
  })

  it('opens a day’s note from its name', async () => {
    await openTimeline()
    fireEvent.click(days()[1].querySelector('.folder-toggle')!)
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('2026-09-21'))
  })

  it('opens a link’s note and a tag’s page from the entry', async () => {
    await openTimeline()
    fireEvent.click(viewer().getByText('Mira Vance'))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('Mira Vance'))
    fireEvent.click(screen.getByLabelText('Timeline'))
    fireEvent.click(await waitFor(() => viewer().getByText('#food')))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('#food'))
  })
})

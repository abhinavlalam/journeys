/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { daysAfter, localDateStamp } from '../clock'
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
/** The days, and today last: with nothing written yet, it still has its new line. */
const days = () => [...document.querySelectorAll('.viewer:not([hidden]) .note-section')]
const lineIn = (section: Element) => section.querySelector<HTMLInputElement>('[data-testid="line-editor"]')
const today = () => `/v/Daily/${localDateStamp()}.md`
const entries = (day: Element) =>
  [...day.querySelectorAll('.timeline-entry')].map((one) => [
    one.querySelector('.timeline-when')!.textContent,
    one.querySelector('.timeline-what')!.textContent,
    one.querySelector('.timeline-group')?.textContent ?? '',
    one.classList.contains('block') ? 'block' : 'moment',
  ])

async function openTimeline(sections = 3) {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Timeline'))
  await waitFor(() => expect(days()).toHaveLength(sections))
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
    const field = await waitFor(() => lineIn(days()[1])!)
    expect(field.value).toBe('09:00 standup')
    fireEvent.change(field, { target: { value: '09:10 standup, late' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(disk.read('/v/Daily/2026-09-21.md')).toBe(before.replace('09:00 standup', '09:10 standup, late')))
    await waitFor(() => expect(viewer().getByText('standup, late')).toBeTruthy())
    expect(lineIn(days()[1])).toBeNull()
  })

  it('leaves the note as it was on Escape', async () => {
    await openTimeline()
    const before = disk.read('/v/Daily/2026-09-21.md')
    fireEvent.click(viewer().getByText('standup'))
    const field = await waitFor(() => lineIn(days()[1])!)
    fireEvent.change(field, { target: { value: '09:10 standup, late' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    await waitFor(() => expect(lineIn(days()[1])).toBeNull())
    expect(disk.read('/v/Daily/2026-09-21.md')).toBe(before)
  })

  it('files a new entry typed at the bottom of today as typed, making the day; with no clock, it is off the timeline', async () => {
    await openTimeline()
    const type = (text: string) => {
      const field = lineIn(days()[2])!
      fireEvent.change(field, { target: { value: text } })
      fireEvent.keyDown(field, { key: 'Enter' })
    }
    type('coffee with [[Mira Vance]]')
    await waitFor(() => expect(disk.read(today())).toBe('#timeline\n    coffee with [[Mira Vance]]\n'))
    // A fresh line for the next, and nothing on the timeline for a line with no time.
    expect(lineIn(days()[2])!.value).toBe('')
    expect(entries(days()[2])).toEqual([['', '', '', 'moment']])
    type('10:00 call with [[Mira Vance]]')
    await waitFor(() => expect(entries(days()[2])[0]).toEqual(['10:00', 'call with Mira Vance', 'timeline', 'moment']))
    expect(disk.read(today())).toBe('#timeline\n    coffee with [[Mira Vance]]\n    10:00 call with [[Mira Vance]]\n')
  })

  it('files a new entry under its tag’s group in today’s note, and keeps a draft on leaving', async () => {
    disk.write(today(), '#expense\n     08:30 #expense amount:: 60\n')
    await openTimeline()
    const field = lineIn(days()[2])!
    fireEvent.change(field, { target: { value: '12:00 #expense lunch' } })
    fireEvent.blur(field)
    // Long enough for a write that should not happen to have landed.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(disk.read(today())).toBe('#expense\n     08:30 #expense amount:: 60\n')
    expect(field.value).toBe('12:00 #expense lunch')
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(disk.read(today())).toBe('#expense\n     08:30 #expense amount:: 60\n     12:00 #expense lunch\n'))
  })

  it('has one today, in its place before a day ahead the calendar wrote, with one new line', async () => {
    disk.write(`/v/Daily/${daysAfter(localDateStamp(), 3)}.md`, '18:00 #event flight\n')
    await openTimeline(4)
    const titles = days().map((one) => one.querySelector('.folder-toggle')!.textContent ?? '')
    expect(titles.filter((one) => one.startsWith('Today'))).toHaveLength(1)
    expect(titles.findIndex((one) => one.startsWith('Today'))).toBe(2)
    expect(document.querySelectorAll('[data-testid="line-editor"]')).toHaveLength(1)
  })

  it('gives the new line the key that writes the time, as a note has', async () => {
    await openTimeline()
    const { DEFAULT_SETTINGS } = await import('../settings')
    expect(lineIn(days()[2])!.dataset.timeKey).toBe(DEFAULT_SETTINGS.shortcuts.insertTime)
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

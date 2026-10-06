/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { daysAfter, localDateStamp } from '../clock'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * The timeline: the daily notes as each day happened, oldest at the top
 * and today at the bottom. A note written by kind reads by clock;
 * moments and stretches read apart; a table tag shows its fields and the
 * day ends with totals. A press on an entry edits its line in place.
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
/** The days with today last; with nothing written, today still has its new line. */
const days = () => [...document.querySelectorAll('.viewer:not([hidden]) .journal-day')]
const lineIn = (section: Element) => section.querySelector<HTMLInputElement>('[data-testid="line-editor"]')
const today = () => `/v/Daily/${localDateStamp()}.md`
const entries = (day: Element) =>
  [...day.querySelectorAll('.timeline-entry')].map((one) => [
    one.querySelector('.timeline-when')!.textContent,
    one.querySelector('.timeline-what')!.textContent,
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
    expect(entries(first)).toEqual([['08:00', '#walk by the river', 'moment']])
    expect(entries(second)).toEqual([
      ['08:30', '#expenseamount 60', 'moment'],
      ['08:45', '#food oats', 'moment'],
      ['09:00', 'standup', 'moment'],
      ['12:30', '#expense lunchamount 480merchant Harbour Bistro', 'moment'],
      ['13:00–13:5050 min', 'review with Mira Vance', 'block'],
    ])
    const tiles = [...second.querySelectorAll('.day-total')].map((one) => [
      one.querySelector('.day-total-number')!.textContent,
      one.querySelector('.day-total-name')!.textContent,
    ])
    expect(tiles).toEqual([['540', 'amount · #expense']])
  })

  /** As written, a markdown link was its whole address, and a strong phrase kept its asterisks. */
  it('reads the lines under an entry as the note shows them', async () => {
    disk.write(
      '/v/Daily/2026-09-20.md',
      ['08:00 #walk by the river', '    - **Cold** at the ferry ([01:18](https://example.com/v?t=78))', '    see [[Harbour Bistro|the bistro]]', ''].join('\n')
    )
    await openTimeline()
    // Folded to a count, so the day's entries are not buried; a press opens it.
    expect(days()[0].querySelector('.timeline-below')).toBeNull()
    fireEvent.click(within(days()[0] as HTMLElement).getByRole('button', { name: '2 lines' }))
    const below = [...days()[0].querySelectorAll('.timeline-below')].map((one) => one.textContent)
    // Each keeps its indent under the entry, so the nesting reads as written.
    expect(below).toEqual(['    - Cold at the ferry (01:18)', '    see the bistro'])
    expect(within(days()[0] as HTMLElement).getByRole('button', { name: '01:18' })).toBeTruthy()
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
    expect(entries(days()[2])).toEqual([['', '', 'moment']])
    type('10:00 call with [[Mira Vance]]')
    await waitFor(() => expect(entries(days()[2])[0]).toEqual(['10:00', 'call with Mira Vance', 'moment']))
    expect(disk.read(today())).toBe('#timeline\n    coffee with [[Mira Vance]]\n    10:00 call with [[Mira Vance]]\n')
  })

  it('files a new entry under its tag’s group in today’s note, and keeps a draft on leaving', async () => {
    disk.write(today(), '#expense\n     08:30 #expense amount:: 60\n')
    await openTimeline()
    const field = lineIn(days()[2])!
    fireEvent.change(field, { target: { value: '12:00 #expense lunch' } })
    fireEvent.blur(field)
    // Long enough for a wrong write to have landed.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(disk.read(today())).toBe('#expense\n     08:30 #expense amount:: 60\n')
    expect(field.value).toBe('12:00 #expense lunch')
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(disk.read(today())).toBe('#expense\n     08:30 #expense amount:: 60\n     12:00 #expense lunch\n'))
  })

  it('has one today, in its place before a day ahead the calendar wrote, with one new line', async () => {
    disk.write(`/v/Daily/${daysAfter(localDateStamp(), 3)}.md`, '18:00 #event flight\n')
    await openTimeline(4)
    const titles = days().map((one) => one.querySelector('.journal-weekday')!.textContent ?? '')
    expect(titles.filter((one) => one.startsWith('Today'))).toHaveLength(1)
    expect(titles.findIndex((one) => one.startsWith('Today'))).toBe(2)
    // Today's page is marked as today's.
    expect(days()[2].querySelector('.journal-head')!.classList.contains('today')).toBe(true)
    expect(document.querySelectorAll('[data-testid="line-editor"]')).toHaveLength(1)
  })

  it('gives the new line the key that writes the time, as a note has', async () => {
    await openTimeline()
    const { DEFAULT_SETTINGS } = await import('../settings')
    expect(lineIn(days()[2])!.dataset.timeKey).toBe(DEFAULT_SETTINGS.shortcuts.insertTime)
  })

  /** A tag's colour, chosen on its page, marks its entries and its chips. */
  it('marks an entry and its chips with their tags’ colours', async () => {
    disk.write('/v/.config/tags.json', JSON.stringify({ expense: { properties: ['amount', 'merchant'], color: 'amber' }, food: { color: 'green' } }))
    await openTimeline()
    const hues = [...days()[1].querySelectorAll('.timeline-entry')].map((one) => one.getAttribute('data-hue'))
    expect(hues).toEqual(['amber', 'green', null, 'amber', null])
    expect(days()[1].querySelector('.timeline-tag[data-hue="green"]')!.textContent).toBe('#food')
    // A total's tile takes its tag's colour too.
    expect(days()[1].querySelector('.day-total')!.getAttribute('data-hue')).toBe('amber')
  })

  /** The same totals close the day's note, where they are set to show there too. */
  it('closes a day’s note with its totals', async () => {
    await openTimeline()
    fireEvent.click(days()[1].querySelector('.journal-date')!)
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('2026-09-21'))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) > .day-totals')!.textContent).toBe('540amount · #expense'))
  })

  /** A day as a calendar draws one: the switch is kept, and a box opens on a press. */
  it('draws each day as a grid in Day, kept in the vault’s settings', async () => {
    await openTimeline()
    fireEvent.click(viewer().getByRole('button', { name: 'Day' }))
    await waitFor(() => expect(days()[1].querySelector('.day-grid')).toBeTruthy())
    await waitFor(() => expect(JSON.parse(disk.read('/v/.config/settings.json')!).timelineView).toBe('day'))
    // The list's entries give way to boxes; the 13:00 to 13:50 review is one of them.
    expect(days()[1].querySelector('.timeline-entry')).toBeNull()
    const review = [...days()[1].querySelectorAll('.day-box')].find((one) => one.textContent!.includes('review'))!
    expect(review.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(review)
    expect(review.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(viewer().getByRole('button', { name: 'List' }))
    await waitFor(() => expect(days()[1].querySelector('.day-grid')).toBeNull())
  })

  it('opens a day’s note from its date', async () => {
    await openTimeline()
    fireEvent.click(days()[1].querySelector('.journal-date')!)
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

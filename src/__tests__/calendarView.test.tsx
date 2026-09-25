/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'
import { localDateStamp } from '../clock'
import { daysAfter, MINUTE_MS } from '../clock'
import { useCalendarSync } from '../useCalendarSync'
import { DEFAULT_SETTINGS } from '../settings'

/**
 * The calendar, driven from the row to the disk: a feed is fetched on Sync, its
 * occurrences land in the daily notes as `--event` lines, the page shows them
 * beside a line typed by hand, and a second Sync writes nothing twice.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))
/** What the fake calendar answers; a test that edits the calendar changes it. */
const feed = { text: '' }
const fetched = vi.fn(async (_url: string) => feed.text)
vi.mock('../calendarFeed', () => ({ fetchFeed: (url: string) => fetched(url) }))

const today = localDateStamp()
const tomorrow = daysAfter(today, 1)
const stamp = (day: string) => day.replace(/-/g, '')
const FEED = [
  'BEGIN:VCALENDAR',
  'X-WR-CALNAME:Fable Weekly',
  'BEGIN:VEVENT',
  'UID:s1',
  `DTSTART:${stamp(today)}T093000`,
  `DTEND:${stamp(today)}T100000`,
  'SUMMARY:Standup',
  'RRULE:FREQ=DAILY;COUNT=2',
  'ATTENDEE;CN=Mira Vance:mailto:m@example',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:o1',
  `DTSTART;VALUE=DATE:${stamp(tomorrow)}`,
  'SUMMARY:Offsite',
  'LOCATION:Goa',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  fetched.mockClear()
  feed.text = FEED
  disk.write(
    '/v/.config/settings.json',
    JSON.stringify({
      ...DEFAULT_SETTINGS,
      calendarFeeds: [{ name: 'Work', url: 'https://calendar.example/ical/abc/basic.ics' }],
    })
  )
})

const viewer = () => within(document.querySelector('.viewer')!)
const rows = () => viewer().queryAllByRole('button').map((row) => row.textContent)

async function openCalendar() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Calendar'))
  await waitFor(() => expect(document.querySelector('.viewer-title')?.textContent).toBe('Calendar'))
}

describe('the calendar', () => {
  it('shows a line typed into today`s note, on today', async () => {
    disk.write(`/v/Daily/${today}.md`, '19:00 --event <<Dinner>> | with:: <<Ravi Iyer>>\n')
    await openCalendar()
    await waitFor(() => expect(rows().some((row) => row?.includes('Dinner'))).toBe(true))
    const dinner = viewer().getByText('Dinner').closest('button')!
    // The clock first, as the line has it, then the title, then the rest.
    expect(dinner.textContent).toBe('19:00Dinnerwith Ravi Iyer')
    // Its section is today's, headed by the word and the date.
    expect(dinner.closest('.note-section')!.textContent).toMatch(/^Today · /)
  })

  /** Nobody presses anything: opening the vault reads the calendar. */
  it('syncs a feed into the daily notes on its own, once, and declares the collection', async () => {
    await openCalendar()
    await waitFor(() => expect(disk.has(`/v/Daily/${tomorrow}.md`)).toBe(true))
    expect(fetched).toHaveBeenCalledWith('https://calendar.example/ical/abc/basic.ics')
    expect(disk.read(`/v/Daily/${today}.md`)).toBe(
      '09:30 to 10:00 --event <<Standup>> | with:: <<Mira Vance>> | source:: <<Work>>\n'
    )
    expect(disk.read(`/v/Daily/${tomorrow}.md`)).toBe(
      [
        '--event <<Offsite>> | at:: <<Goa>> | source:: <<Work>>',
        '09:30 to 10:00 --event <<Standup>> | with:: <<Mira Vance>> | source:: <<Work>>',
        '',
      ].join('\n')
    )
    const structures = JSON.parse(disk.read('/v/.config/actions/collections.json')!)
    expect(structures.event.fields).toEqual(['what', 'with', 'at', 'source', 'repeats', 'reminder'])

    // On the page: the all-day event first on its day, the source beside each.
    await waitFor(() => expect(rows().filter((row) => row?.includes('Standup'))).toHaveLength(2))
    // `source::` is the name the feed was given in settings, not the feed's own.
    expect(viewer().getByText('Offsite').closest('button')!.textContent).toBe('Offsiteat Goa · Work')

    // Sync by hand finds every line already there.
    const before = fetched.mock.calls.length
    await waitFor(() => expect(viewer().getByText('Sync')).toHaveProperty('disabled', false))
    fireEvent.click(viewer().getByText('Sync'))
    await waitFor(() => expect(fetched.mock.calls.length).toBe(before + 1))
    await waitFor(() => expect(viewer().getByText('Sync')).toHaveProperty('disabled', false))
    expect(disk.read(`/v/Daily/${today}.md`)!.split('--event')).toHaveLength(2)
  })

  it('appends to a day that was already written, under what is there', async () => {
    disk.write(`/v/Daily/${today}.md`, '# Thursday\n\nWoke late.')
    await openCalendar()
    fireEvent.click(viewer().getByText('Sync'))
    await waitFor(() => expect(disk.read(`/v/Daily/${today}.md`)).toContain('--event <<Standup>>'))
    expect(disk.read(`/v/Daily/${today}.md`)!.startsWith('# Thursday\n\nWoke late.\n09:30')).toBe(true)
  })

  it('draws the month, today marked and its event on it, and steps between months', async () => {
    disk.write(`/v/Daily/${today}.md`, '19:00 --event <<Dinner>> | with:: <<Ravi Iyer>>\n--event <<Offsite>>\n')
    await openCalendar()
    fireEvent.click(viewer().getByText('Month'))
    const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
    const thisMonth = monthName.format(new Date())
    await waitFor(() => expect(viewer().getByText(thisMonth)).toBeTruthy())
    // Seven weekday names, then whole weeks of days.
    expect(document.querySelectorAll('.calendar-weekday')).toHaveLength(7)
    expect(document.querySelectorAll('.calendar-cell').length % 7).toBe(0)
    const cell = document.querySelector('.calendar-cell.today')!
    expect(cell.querySelector('.calendar-date')!.textContent).toBe(String(new Date().getDate()))
    const chips = [...cell.querySelectorAll('.calendar-chip')].map((chip) => chip.textContent)
    // All day first, then by time — the typed dinner beside the standup the
    // calendar's own sync wrote as the vault opened.
    expect(chips).toEqual(['Offsite', '09:30Standup', '19:00Dinner'])
    expect(cell.querySelector('.calendar-chip.all-day')!.textContent).toBe('Offsite')

    fireEvent.click(viewer().getByLabelText('Next month'))
    const [y, m] = today.split('-').map(Number)
    expect(viewer().getByText(monthName.format(new Date(y, m, 1)))).toBeTruthy()
    expect(document.querySelector('.calendar-cell.today')).toBeNull()
    fireEvent.click(viewer().getByText('Today'))
    expect(viewer().getByText(thisMonth)).toBeTruthy()
    expect(viewer().queryByText('Today')).toBeNull()
  })

  it('opens a day`s page from the month, making the day if it has none', async () => {
    await openCalendar()
    fireEvent.click(viewer().getByText('Month'))
    const first = document.querySelector('.calendar-cell:not(.outside) .calendar-date') as HTMLElement
    fireEvent.click(first)
    const day = `${today.slice(0, 8)}01`
    await waitFor(() => expect(document.querySelector('.viewer-title')?.textContent).toBe(day))
    expect(disk.has(`/v/Daily/${day}.md`)).toBe(true)
  })

  /**
   * An event deleted, moved or renamed in the calendar takes its line back out of the
   * day's note on the next Sync — and only a line that is wholly the calendar's:
   * one with words added, a note beneath it, or no feed's name in `source::` is the
   * owner's and stays. A day left with nothing is not given a page.
   */
  it('takes back the lines of events the calendar no longer has, and nothing of yours', async () => {
    await openCalendar()
    fireEvent.click(viewer().getByText('Sync'))
    await waitFor(() => expect(disk.has(`/v/Daily/${tomorrow}.md`)).toBe(true))
    // The owner writes into tomorrow's page: words on the end of the Standup line, a
    // note under a synced line of their own making, and a dinner with no source. A
    // lunch line from before the feed was named says the calendar's own name.
    disk.write(
      `/v/Daily/${tomorrow}.md`,
      disk
        .read(`/v/Daily/${tomorrow}.md`)!
        .replace('source:: <<Work>>\n09:30', 'source:: <<Work>>\n12:00 --event <<Lunch>> | source:: <<Fable Weekly>>\n09:30')
        .replace('<<Mira Vance>> | source:: <<Work>>', '<<Mira Vance>> | source:: <<Work>> and bring the notes') +
        '11:00 --event <<Review>> | source:: <<Work>>\n  - bring the slides\n' +
        '19:00 --event <<Dinner>> | with:: <<Ravi Iyer>>\n'
    )
    // The calendar drops the offsite and the second standup.
    feed.text = FEED.replace('COUNT=2', 'COUNT=1').replace(/BEGIN:VEVENT\r\nUID:o1[\s\S]*?END:VEVENT\r\n/, '')
    fireEvent.click(viewer().getByText('Sync'))
    await waitFor(() => expect(disk.read(`/v/Daily/${tomorrow}.md`)).not.toContain('Offsite'))
    // The lunch is gone too: a feed answers to its own name as well as the one given.
    expect(disk.read(`/v/Daily/${tomorrow}.md`)).toBe(
      [
        '09:30 to 10:00 --event <<Standup>> | with:: <<Mira Vance>> | source:: <<Work>> and bring the notes',
        '11:00 --event <<Review>> | source:: <<Work>>',
        '  - bring the slides',
        '19:00 --event <<Dinner>> | with:: <<Ravi Iyer>>',
        '',
      ].join('\n')
    )
    // Today's standup is still in the calendar, so it is still in the note, once.
    expect(disk.read(`/v/Daily/${today}.md`)!.split('--event')).toHaveLength(2)
    // And no page for a day the calendar has nothing on.
    expect(disk.has(`/v/Daily/${daysAfter(today, 2)}.md`)).toBe(false)
  })

  it('has nothing to sync without a feed', async () => {
    disk.write('/v/.config/settings.json', JSON.stringify(DEFAULT_SETTINGS))
    await openCalendar()
    expect(viewer().getByText('Sync')).toHaveProperty('disabled', true)
    expect(viewer().getByText('No feeds')).toBeTruthy()
  })
})

/**
 * **The calendar keeps itself current.** It was a button, and a meeting moved in
 * Google stayed at its old time in the day's note until someone pressed it — which
 * nobody would think to, beside a vault that syncs on its own.
 */
describe('the calendar’s own sync', () => {
  afterEach(() => vi.useRealTimers())

  const hook = (sync: () => Promise<void>, onError = vi.fn(), feeds = 1) =>
    renderHook((p: { feeds: number }) => useCalendarSync({ vaultPath: '/v', feeds: p.feeds, everyMinutes: 5, sync, onError }), {
      initialProps: { feeds },
    })

  it('reads the calendar as the vault opens, and again every interval', async () => {
    vi.useFakeTimers()
    const sync = vi.fn(async () => {})
    hook(sync)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(sync).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(5 * MINUTE_MS))
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('reads it on coming back to the window only when the last read is stale', async () => {
    vi.useFakeTimers()
    const sync = vi.fn(async () => {})
    hook(sync)
    await act(() => vi.advanceTimersByTimeAsync(MINUTE_MS))
    fireEvent(window, new Event('focus'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(sync).toHaveBeenCalledTimes(1)
    // Past the interval with the timer held off — a throttled background window.
    vi.setSystemTime(Date.now() + 5 * MINUTE_MS)
    fireEvent(window, new Event('focus'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('does nothing with no calendar, and reads the moment one is added', async () => {
    vi.useFakeTimers()
    const sync = vi.fn(async () => {})
    const { rerender } = hook(sync, vi.fn(), 0)
    await act(() => vi.advanceTimersByTimeAsync(5 * MINUTE_MS))
    expect(sync).not.toHaveBeenCalled()
    rerender({ feeds: 1 })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('is quiet offline, unless the button was pressed', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const { result } = hook(async () => {
      throw new Error('could not fetch: curl: (6) Could not resolve host')
    }, onError)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(onError).not.toHaveBeenCalled()
    await act(() => result.current.now(true))
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

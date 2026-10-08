/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { dayDate, daysAfter, localDateStamp, shortDate, weekdayName } from '../clock'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * The Habits application: each tag tracked as a habit, by the last weeks' days, done
 * where the day's note carries the tag. A press writes the tag in, or takes back a
 * line that is the tag alone; a day done in the note's own words is the note's.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

const today = localDateStamp()
const yesterday = daysAfter(today, -1)
const note = (day: string) => `/v/Daily/${day}.md`

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  disk.write('/v/.config/tags.json', JSON.stringify({ water: { habit: true } }))
  disk.write(note(daysAfter(today, -2)), '#water\n')
  disk.write(note(yesterday), '07:30 #water the ferns, then the palm\n')
})

const viewer = () => within(document.querySelector('.viewer:not([hidden])') as HTMLElement)
const cell = (tag: string, day: string) => {
  const date = dayDate(day)
  return viewer().getByRole('button', { name: `#${tag}, ${weekdayName.format(date)} ${shortDate.format(date)}` })
}

async function openHabits() {
  const { default: App } = await import('../App')
  render(<App />)
  fireEvent.click(await screen.findByLabelText('Habits'))
  await waitFor(() => expect(cell('water', yesterday).getAttribute('aria-pressed')).toBe('true'))
}

describe('the Habits application', () => {
  it('shows each habit’s days, its streak, and how many are left today', async () => {
    await openHabits()
    expect(cell('water', daysAfter(today, -3)).getAttribute('aria-pressed')).toBe('false')
    // Today not done yet: the streak stands, up to yesterday.
    expect(viewer().getByText('2 days')).toBeTruthy()
    expect(viewer().getByText('1 left today')).toBeTruthy()
  })

  it('writes the tag into today’s note on a press, and takes it back on the next', async () => {
    await openHabits()
    fireEvent.click(cell('water', today))
    await waitFor(() => expect(disk.read(note(today))).toMatch(/^\s*#water$/m))
    await waitFor(() => expect(cell('water', today).getAttribute('aria-pressed')).toBe('true'))
    expect(viewer().getByText('All done today')).toBeTruthy()

    fireEvent.click(cell('water', today))
    await waitFor(() => expect(disk.read(note(today))).not.toMatch(/#water/))
  })

  it('leaves a day done in the note’s own words as written, and says so', async () => {
    await openHabits()
    fireEvent.click(cell('water', yesterday))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('in its own words'))
    expect(disk.read(note(yesterday))).toBe('07:30 #water the ferns, then the palm\n')
  })

  it('makes a tag a habit from the +, as its page does', async () => {
    await openHabits()
    fireEvent.click(viewer().getByRole('button', { name: 'Add a habit' }))
    const field = viewer().getByPlaceholderText('Tag…')
    fireEvent.change(field, { target: { value: '#Stretch' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(JSON.parse(disk.read('/v/.config/tags.json')!).stretch).toEqual({ habit: true }))
    await waitFor(() => expect(cell('stretch', today)).toBeTruthy())
  })
})

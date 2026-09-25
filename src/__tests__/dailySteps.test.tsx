/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * **The days either side, at the top of a journal page.** The end of a note says
 * where it sits and what points at it; a daily note is also a place in a sequence.
 * `daily.test.ts` holds the model — what is a day, and what lies either side of one
 * when the journal has gaps; this drives the app.
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
  // A gap between the 17th and the 20th, and the folder's own note beside them.
  disk.write('/v/Daily/Daily.md', '# Daily\n')
  disk.write('/v/Daily/2026-09-16.md', 'the sixteenth\n')
  disk.write('/v/Daily/2026-09-17.md', 'the seventeenth\n')
  disk.write('/v/Daily/2026-09-20.md', 'the twentieth\n')
})

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

const sidebar = () => within(document.querySelector('.sidebar')!)
const title = () => document.querySelector('.viewer-title')?.textContent ?? null
const steps = () =>
  [...document.querySelectorAll('.daily-step')].map((el) => [
    el.className.includes('back') ? 'back' : 'forward',
    el.textContent,
  ])

async function openDay(day: string) {
  fireEvent.click(sidebar().getByText('Daily'))
  await waitFor(() => expect(sidebar().getByText(day)).toBeTruthy())
  fireEvent.click(sidebar().getByText(day))
  await waitFor(() => expect(title()).toBe(day))
}

describe('a journal page', () => {
  it('offers the day before and the day after, over the gaps', async () => {
    await openApp()
    await openDay('2026-09-17')
    await waitFor(() => expect(steps()).toEqual([
      ['back', '2026-09-16'],
      ['forward', '2026-09-20'],
    ]))
  })

  it('steps to the day, opening it in the pane', async () => {
    await openApp()
    await openDay('2026-09-17')
    await waitFor(() => expect(steps()).toHaveLength(2))
    // The step, not the row of the same name in the tree.
    fireEvent.click(document.querySelector('.daily-step.back')!)
    await waitFor(() => expect(title()).toBe('2026-09-16'))
    // The first day has nothing before it, and its one step points forward.
    expect(steps()).toEqual([['forward', '2026-09-17']])
  })

  it('offers nothing on a note that is not a day', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('roadmap'))
    await waitFor(() => expect(title()).toBe('roadmap'))
    expect(steps()).toEqual([])
    // Including the daily folder's own note, which lives there without being a day.
    await openDay('Daily')
    expect(steps()).toEqual([])
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { daysAfter, localDateStamp } from '../clock'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * The Tasks application: every `#task` line in the vault by when it is due, a box that
 * marks one done in its own line, and a line at the top that files a new one in today.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

const today = localDateStamp()
const plan = [
  'Notes on the harbour plan.',
  `- #task call Mira about the slip due:: ${daysAfter(today, -2)}`,
  `- #task book the survey due:: ${today}`,
  `- #task paint the hull due:: ${daysAfter(today, 30)}`,
  '- #task sort the photos',
  `- #task send the invoice due:: ${daysAfter(today, -9)} status:: done`,
].join('\n')

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  disk.write('/v/.config/properties.json', JSON.stringify({ due: { type: 'date' }, project: { type: 'backlink' } }))
  disk.write('/v/.config/tags.json', JSON.stringify({ task: { properties: ['project', 'due', 'status'] } }))
  disk.write('/v/Harbour.md', plan)
})

const viewer = () => within(document.querySelector('.viewer:not([hidden])') as HTMLElement)

async function openTasks() {
  const { default: App } = await import('../App')
  render(<App />)
  fireEvent.click(await screen.findByLabelText('Tasks'))
  await waitFor(() => expect(viewer().getByText('Overdue')).toBeTruthy())
}

describe('the Tasks application', () => {
  it('lists every task by when it is due, the done ones folded away', async () => {
    await openTasks()
    for (const group of ['Overdue', 'Today', 'Later', 'No date', 'Done']) expect(viewer().getByText(group)).toBeTruthy()
    expect(viewer().getByRole('checkbox', { name: 'call Mira about the slip: done' })).toBeTruthy()
    expect(viewer().getByText('sort the photos')).toBeTruthy()
    // Done is folded, so its task is not listed until it is opened.
    expect(viewer().queryByText('send the invoice')).toBeNull()
    // Four are open, and the Applications row says so.
    expect(screen.getByLabelText('Tasks').textContent).toContain('4')
  })

  it('marks a task done in its own line, and takes it back', async () => {
    await openTasks()
    fireEvent.click(viewer().getByRole('checkbox', { name: 'call Mira about the slip: done' }))
    await waitFor(() => expect(disk.read('/v/Harbour.md')).toContain('call Mira about the slip due:: ' + daysAfter(today, -2) + ' status:: done'))
    // Every other line is as it was.
    expect(disk.read('/v/Harbour.md')!.split('\n').filter((line) => !line.includes('call Mira'))).toEqual(plan.split('\n').filter((line) => !line.includes('call Mira')))
    // Done now, it is folded away with the others; open, its box takes it back.
    await waitFor(() => expect(viewer().queryByText('call Mira about the slip')).toBeNull())
    fireEvent.click(viewer().getByText('Done'))
    fireEvent.click(await waitFor(() => viewer().getByRole('checkbox', { name: 'call Mira about the slip: done' })))
    await waitFor(() => expect(disk.read('/v/Harbour.md')).toBe(plan))
  })

  it('files a task typed at the top in today’s note', async () => {
    await openTasks()
    const line = viewer().getByTestId('line-editor') as HTMLInputElement
    expect(line.value).toBe('#task ')
    fireEvent.change(line, { target: { value: '#task order rope' } })
    fireEvent.keyDown(line, { key: 'Enter' })
    await waitFor(() => expect(disk.read(`/v/Daily/${today}.md`)).toContain('#task order rope'))
    // The tag alone is no task.
    fireEvent.keyDown(viewer().getByTestId('line-editor'), { key: 'Enter' })
    expect(disk.read(`/v/Daily/${today}.md`)!.match(/#task/g)).toHaveLength(1)
  })
})

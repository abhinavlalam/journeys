/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { localDateStamp, localTimeStamp } from '../clock'
import { disk, fsModule, resetFakeVault } from './fakeVault'

/**
 * The menu bar's Journeys: a panel that asks, by events, and the main window that
 * writes what it asks into a day. The events go through a bus kept here, as Tauri's
 * would carry them between the two windows.
 */

const bus = vi.hoisted(() => {
  const handlers = new Map<string, ((event: { payload: unknown }) => void)[]>()
  const sent: { to: string; event: string; payload: unknown }[] = []
  return {
    handlers,
    sent,
    listen: async (event: string, handle: (event: { payload: unknown }) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handle])
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((one) => one !== handle))
    },
    emitTo: async (to: string, event: string, payload?: unknown) => void sent.push({ to, event, payload }),
    fire: (event: string, payload?: unknown) => handlers.get(event)?.forEach((handle) => handle({ payload })),
  }
})
vi.mock('@tauri-apps/api/event', () => ({ listen: bus.listen, emitTo: bus.emitTo }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ hide: vi.fn() }) }))
vi.mock('@tauri-apps/plugin-fs', () => fsModule())

const { ASK, elapsedText, readTracking, TELL, trackedLine, useMenuBar } = await import('../menuBar')
const { MenuBarPanel } = await import('../MenuBarPanel')

const TIMER = '/v/.config/timer.json'
const told = (event: string) => bus.sent.filter((one) => one.event === event).map((one) => one.payload)

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  bus.handlers.clear()
  bus.sent.length = 0
  // The desktop app: the menu bar's half only runs in it.
  Object.assign(window, { __TAURI_INTERNALS__: {} })
})

describe('a time tracked', () => {
  it('is written as its clocks and what it was, one clock when under a minute', () => {
    const since = new Date(2026, 9, 17, 9, 12).getTime()
    expect(trackedLine({ what: 'writing the spec', since }, new Date(2026, 9, 17, 10, 40))).toBe('09:12 to 10:40 writing the spec')
    expect(trackedLine({ what: 'a call', since }, new Date(2026, 9, 17, 9, 12, 40))).toBe('09:12 a call')
    expect(elapsedText(since, since + 65 * 60000)).toBe('1:05')
  })

  it('is read from its file, or is none', () => {
    expect(readTracking('{"what":"reading","since":5}')).toEqual({ what: 'reading', since: 5 })
    expect(readTracking('{}')).toBeNull()
    expect(readTracking('not json')).toBeNull()
    expect(readTracking(null)).toBeNull()
  })
})

describe('the main window’s half', () => {
  function mount(file = vi.fn(async () => true)) {
    renderHook(() => useMenuBar({ vaultPath: '/v', file, say: () => {} }))
    return file
  }

  it('adds a line to today, and says so', async () => {
    const file = mount()
    await waitFor(() => expect(bus.handlers.has(ASK.line)).toBe(true))
    await act(async () => bus.fire(ASK.line, { text: 'call the ferry' }))
    await waitFor(() => expect(file).toHaveBeenCalledWith(localDateStamp(), 'call the ferry'))
    await waitFor(() => expect(told(TELL.said)).toEqual([{ said: 'Added to today.' }]))
  })

  it('hands a line back when it could not be written', async () => {
    mount(vi.fn(async () => false))
    await waitFor(() => expect(bus.handlers.has(ASK.line)).toBe(true))
    await act(async () => bus.fire(ASK.line, { text: 'call the ferry' }))
    await waitFor(() => expect(told(TELL.said)).toEqual([{ said: 'It could not be added.', line: 'call the ferry' }]))
  })

  /** Kept in the vault, so a tracker running survives a quit; written into the day it started. */
  it('keeps what is being done, and writes it into the day’s log when stopped or followed', async () => {
    const file = mount()
    await waitFor(() => expect(bus.handlers.has(ASK.start)).toBe(true))
    await act(async () => bus.fire(ASK.start, { what: 'writing the spec' }))
    await waitFor(() => expect(readTracking(disk.read(TIMER)!)?.what).toBe('writing the spec'))
    expect(file).not.toHaveBeenCalled()
    // Something else started stops it first.
    await act(async () => bus.fire(ASK.start, { what: 'reading' }))
    await waitFor(() => expect(readTracking(disk.read(TIMER)!)?.what).toBe('reading'))
    expect(file).toHaveBeenCalledWith(localDateStamp(), `${localTimeStamp()} writing the spec`)
    await act(async () => bus.fire(ASK.stop))
    await waitFor(() => expect(disk.read(TIMER)).toBe('{}\n'))
    expect(file).toHaveBeenLastCalledWith(localDateStamp(), `${localTimeStamp()} reading`)
    expect(told(TELL.said).at(-1)).toEqual({ said: 'Written into the day’s log.' })
  })

  it('takes up a tracker the file holds', async () => {
    disk.write(TIMER, `${JSON.stringify({ what: 'reading', since: 5 })}\n`)
    mount()
    await waitFor(() => expect(bus.handlers.has(ASK.hello)).toBe(true))
    await act(async () => bus.fire(ASK.hello))
    await waitFor(() => expect(told(TELL.state).at(-1)).toEqual({ what: 'reading', since: 5 }))
  })
})

describe('the panel', () => {
  it('asks for a line for today and for a time to start, on Enter', async () => {
    render(<MenuBarPanel />)
    fireEvent.change(screen.getByLabelText('Add to today'), { target: { value: 'call the ferry' } })
    fireEvent.keyDown(screen.getByLabelText('Add to today'), { key: 'Enter' })
    fireEvent.change(screen.getByLabelText('Now'), { target: { value: 'writing the spec' } })
    fireEvent.keyDown(screen.getByLabelText('Now'), { key: 'Enter' })
    expect(bus.sent.filter((one) => one.to === 'main').map(({ event, payload }) => [event, payload])).toEqual([
      [ASK.hello, undefined],
      [ASK.line, { text: 'call the ferry' }],
      [ASK.start, { what: 'writing the spec' }],
    ])
    expect((screen.getByLabelText('Add to today') as HTMLInputElement).value).toBe('')
  })

  it('shows what runs and since when, stops it, and puts back a line not written', async () => {
    render(<MenuBarPanel />)
    await waitFor(() => expect(bus.handlers.has(TELL.state)).toBe(true))
    // Half a minute over, as the panel read its clock a moment before.
    const since = Date.now() - 42.5 * 60000
    act(() => bus.fire(TELL.state, { what: 'writing the spec', since }))
    expect(screen.getByText('writing the spec')).toBeTruthy()
    expect(screen.getByText(`since ${localTimeStamp(new Date(since))}, 0:42`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(bus.sent.at(-1)).toMatchObject({ to: 'main', event: ASK.stop })
    act(() => bus.fire(TELL.said, { said: 'It could not be added.', line: 'call the ferry' }))
    expect(screen.getByRole('status').textContent).toBe('It could not be added.')
    expect((screen.getByLabelText('Add to today') as HTMLInputElement).value).toBe('call the ferry')
  })
})

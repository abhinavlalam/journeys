/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { daysAfter, localDateStamp, localTimeStamp } from '../clock'
import type { Share } from '../share'
import { disk, fsModule, openApp, rememberVault, resetFakeVault } from './fakeVault'

/**
 * The phone: one place at a time over a bar, today's note as the place to
 * capture, Android's back gesture, and what other apps share in. The real
 * editor, since the capture line's chips and Add write into its view.
 */

const back = vi.hoisted(() => ({ press: null as null | (() => void) }))
const shared = vi.hoisted(() => ({ waiting: [] as Share[], called: [] as string[] }))

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null), confirm: vi.fn(async () => true) }))
vi.mock('../platform', async (actual) => ({ ...(await actual<typeof import('../platform')>()), onAndroid: true, paintBars: () => {} }))
vi.mock('@tauri-apps/api/app', () => ({
  onBackButtonPress: vi.fn(async (handler: () => void) => {
    back.press = handler
    return { unregister: () => (back.press = null) }
  }),
}))
// The bridge: shares are handed over once; anything else is not there, as in jsdom.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    shared.called.push(command)
    if (command === 'phone_shares') return shared.waiting.splice(0)
    throw new Error(`no bridge for ${command}`)
  }),
}))

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  shared.waiting = []
  shared.called = []
  back.press = null
  disk.write('/v/.config/tags.json', JSON.stringify({ expense: { properties: ['amount', 'merchant'] }, walk: { properties: [] } }))
  disk.write('/v/.config/properties.json', JSON.stringify({ amount: { type: 'number' }, merchant: { type: 'backlink' } }))
})

const today = () => `/v/Daily/${localDateStamp()}.md`
const page = () => within(document.querySelector('.viewer:not([hidden])') as HTMLElement)
const bar = () => within(screen.getByRole('navigation', { name: 'Places' }))
const sheet = () => within(screen.getByRole('dialog'))
const line = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.capture-line .cm-editor')!)!
const type = (text: string) => {
  const view = line()
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length } })
}
const focus = () => act(() => void window.dispatchEvent(new Event('focus')))
const field = (name: string) => sheet().getByText(name, { selector: '.capture-field > span' }).nextElementSibling as HTMLInputElement
const fill = (name: string, value: string) => fireEvent.change(field(name), { target: { value } })

/** Opens the + and picks what to add. */
async function add(choice: string) {
  await waitFor(() => expect(page().getByText(localDateStamp())).toBeTruthy())
  fireEvent.click(bar().getByRole('button', { name: 'Add' }))
  fireEvent.click(sheet().getByText(choice))
}

describe('the phone', () => {
  /** Opening the app to look at the day made an empty note, which a sync would commit. */
  it('starts on today, and writes nothing until a line is added', async () => {
    await openApp()
    await add('Note')
    expect(disk.read(today())).toBeUndefined()
    await waitFor(() => expect(document.querySelector('.capture-line .cm-editor')).toBeTruthy())
    type('walked to the harbour')
    fireEvent.click(sheet().getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(disk.read(today())).toBe('#timeline\n    walked to the harbour\n'))
    // Written, the sheet closes and the page stays.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('starts a note’s line with the time, leaves the caret, and files it on Enter', async () => {
    await openApp()
    await add('Note')
    await waitFor(() => expect(document.querySelector('.capture-line .cm-editor')).toBeTruthy())
    // On an empty line too, the typing goes on after the time.
    fireEvent.click(sheet().getByRole('button', { name: 'Now' }))
    expect(line().state.selection.main.head).toBe(line().state.doc.length)
    type('lunch')
    // Again, Now replaces the time rather than adding a second.
    fireEvent.click(sheet().getByRole('button', { name: 'Now' }))
    expect(line().state.doc.toString()).toBe(`${localTimeStamp()} lunch`)
    fireEvent.keyDown(line().contentDOM, { key: 'Enter' })
    await waitFor(() => expect(disk.read(today())).toBe(`#timeline\n    ${localTimeStamp()} lunch\n`))
  })

  it('keeps a note’s draft while the sheet is closed, and closes on the gesture', async () => {
    await openApp()
    await add('Note')
    await waitFor(() => expect(document.querySelector('.capture-line .cm-editor')).toBeTruthy())
    type('half a thought')
    await waitFor(() => expect(back.press).not.toBeNull())
    act(() => back.press!())
    expect(screen.queryByRole('dialog')).toBeNull()
    await add('Note')
    await waitFor(() => expect(line().state.doc.toString()).toBe('half a thought'))
  })

  /** A tag's line in its structure's order, each value as its type reads it. */
  it('writes a tag’s line from its form', async () => {
    await openApp()
    await add('Tag')
    expect(sheet().queryByText('#event')).toBeNull()
    fireEvent.click(sheet().getByText('#expense'))
    fill('What', 'lunch by the water')
    fill('merchant', 'Harbour Bistro')
    fill('amount', '24.50')
    fireEvent.click(sheet().getByRole('button', { name: 'Now' }))
    fireEvent.click(sheet().getByRole('button', { name: 'Add' }))
    // A tag with a structure is a record, at the top level of the day.
    await waitFor(() =>
      expect(disk.read(today())).toBe(`${localTimeStamp()} #expense lunch by the water amount:: 24.50 merchant:: [[Harbour Bistro]]\n`)
    )
  })

  it('writes an event into its own day, as the calendar writes one', async () => {
    const tomorrow = daysAfter(localDateStamp(), 1)
    await openApp()
    await add('Event')
    fill('What', 'Dinner')
    fill('Day', tomorrow)
    fill('From', '19:00')
    fill('To', '21:30')
    fill('with', 'Mira Vance')
    fireEvent.click(sheet().getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(disk.read(`/v/Daily/${tomorrow}.md`)).toContain('19:00 to 21:30 #event Dinner with:: "Mira Vance"'))
    expect(disk.read(today())).toBeUndefined()
  })

  it('keeps a picked photo in Files, linked from a line in today', async () => {
    disk.write('/v/Files/harbour.png', 'an older one')
    await openApp()
    await add('Photo or file')
    fireEvent.change(field('Files'), { target: { files: [new File(['PNG'], 'harbour.png', { type: 'image/png' })] } })
    fill('Caption', 'from the ferry')
    fireEvent.click(sheet().getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(disk.read(today())).toBe('#timeline\n    from the ferry [[Files/harbour 2.png]]\n'))
    expect(disk.read('/v/Files/harbour 2.png')).toBe('PNG')
    expect(disk.read('/v/Files/harbour.png')).toBe('an older one')
  })

  it('makes a new note in the folder chosen, and opens it', async () => {
    await openApp()
    await add('New note')
    fill('Name', 'Tide tables')
    fireEvent.change(field('In'), { target: { value: 'Ideas' } })
    fireEvent.click(sheet().getByRole('button', { name: 'Make it' }))
    await waitFor(() => expect(disk.has('/v/Ideas/Tide tables.md')).toBe(true))
    await waitFor(() => expect(page().getByText('Tide tables')).toBeTruthy())
  })

  /** The phone has no `curl`, and the laptop's sync writes the lines; both writing them collided in git. */
  it('reads the calendar the laptop wrote, and fetches no feed', async () => {
    await openApp({ calendarFeeds: [{ name: 'Work', url: 'https://example.com/work.ics' }] })
    fireEvent.click(bar().getByRole('button', { name: 'Calendar' }))
    await waitFor(() => expect(page().getByText('Calendar')).toBeTruthy())
    expect(page().queryByRole('button', { name: 'Sync' })).toBeNull()
    expect(page().queryByText('No feeds')).toBeNull()
    expect(shared.called).not.toContain('fetch_feed')
  })

  /** One page at a time, and the gesture goes back the way it came. */
  it('opens a note from Browse in its place, and goes back on the gesture', async () => {
    await openApp()
    await waitFor(() => expect(page().getByText(localDateStamp())).toBeTruthy())
    expect(back.press).toBeNull()

    fireEvent.click(bar().getByRole('button', { name: 'Browse' }))
    expect(document.querySelector('.sidebar')!.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('.workspace')!.hasAttribute('hidden')).toBe(true)
    fireEvent.click(within(document.querySelector('.sidebar') as HTMLElement).getByText('roadmap'))
    await waitFor(() => expect(page().getByText('roadmap')).toBeTruthy())
    expect(document.querySelector('.sidebar')!.hasAttribute('hidden')).toBe(true)
    // One page: the note is the workspace's only tab.
    expect(document.querySelectorAll('.viewer').length).toBe(1)

    await waitFor(() => expect(back.press).not.toBeNull())
    act(() => back.press!())
    expect(document.querySelector('.sidebar')!.hasAttribute('hidden')).toBe(false)
    act(() => back.press!())
    await waitFor(() => expect(page().getByText(localDateStamp())).toBeTruthy())
    // Nowhere left: the gesture is Android's again, which leaves the app.
    await waitFor(() => expect(back.press).toBeNull())
  })
})

describe('a share from another app', () => {
  const photo = (path = '/cache/shared/1-0'): Share['files'][number] => ({ name: 'photo.jpg', path })

  it('is filed in the day it arrived, with its file moved into Files', async () => {
    disk.write('/cache/shared/1-0', 'JPEG')
    disk.write('/v/Files/photo.jpg', 'an older photo')
    const at = Date.now()
    shared.waiting.push({ at, text: 'Lunch spot\n\n  by the harbour', subject: null, files: [photo()] })
    await openApp()
    const clock = localTimeStamp(new Date(at))
    await waitFor(() =>
      expect(disk.read(today())).toBe(`#timeline\n    ${clock} #shared Lunch spot [[Files/photo 2.jpg]]\n        by the harbour\n`)
    )
    // Never over a file, and moved rather than copied.
    expect(disk.read('/v/Files/photo 2.jpg')).toBe('JPEG')
    expect(disk.read('/v/Files/photo.jpg')).toBe('an older photo')
    expect(disk.has('/cache/shared/1-0')).toBe(false)
  })

  it('arrives on a return to the app', async () => {
    await openApp()
    await waitFor(() => expect(page().getByText(localDateStamp())).toBeTruthy())
    shared.waiting.push({ at: Date.now(), text: 'https://example.com/tides', subject: 'Tide tables', files: [] })
    focus()
    await waitFor(() => expect(disk.read(today())).toContain('#shared Tide tables https://example.com/tides'))
  })

  /** Filing failed after the file had moved; a second try moved it again, from nowhere. */
  it('that could not be filed is kept, and filed on the next return without moving its file twice', async () => {
    disk.write('/cache/shared/2-0', 'JPEG')
    const allow = disk.forbid('/v/Daily')
    shared.waiting.push({ at: Date.now(), text: 'menu', files: [photo('/cache/shared/2-0')] })
    await openApp()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('forbidden path'))
    expect(disk.read('/v/Files/photo.jpg')).toBe('JPEG')

    allow()
    focus()
    await waitFor(() => expect(disk.read(today())).toContain('#shared menu [[Files/photo.jpg]]'))
    expect(disk.paths().filter((path) => path.startsWith('/v/Files/'))).toEqual(['/v/Files/photo.jpg'])
    // Filed, it is not filed again on the next return.
    focus()
    await new Promise((settle) => setTimeout(settle, 50))
    expect(disk.read(today())!.match(/#shared menu/g)).toHaveLength(1)
  })

  it('says a file it could not read, and files the rest', async () => {
    shared.waiting.push({ at: Date.now(), text: 'two pages', files: [{ name: 'scan.pdf', error: 'permission denied' }] })
    await openApp()
    await waitFor(() => expect(disk.read(today())).toContain('#shared two pages'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('scan.pdf (permission denied)'))
  })
})

describe('an app switch on Android', () => {
  /** The WebView sends only `visibilitychange`, and the vault read, sync and lock wait for focus. */
  it('is focus and blur to the window', async () => {
    const { relayVisibility } = await import('../platform')
    relayVisibility()
    const heard: string[] = []
    const hear = (event: Event) => heard.push(event.type)
    window.addEventListener('focus', hear)
    window.addEventListener('blur', hear)
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    window.removeEventListener('focus', hear)
    window.removeEventListener('blur', hear)
    expect(heard).toEqual(['blur', 'focus'])
  })
})

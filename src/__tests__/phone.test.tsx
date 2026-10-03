/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { localDateStamp, localTimeStamp } from '../clock'
import type { Share } from '../share'
import { disk, fsModule, openApp, rememberVault, resetFakeVault } from './fakeVault'

/**
 * The phone: one place at a time over a bar, today's note as the place to
 * capture, Android's back gesture, and what other apps share in. The real
 * editor, since the capture line's chips and Add write into its view.
 */

const back = vi.hoisted(() => ({ press: null as null | (() => void) }))
const shared = vi.hoisted(() => ({ waiting: [] as Share[] }))

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
    if (command === 'phone_shares') return shared.waiting.splice(0)
    throw new Error(`no bridge for ${command}`)
  }),
}))

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  shared.waiting = []
  back.press = null
  disk.write('/v/.config/tags.json', JSON.stringify({ expense: { properties: [] } }))
})

const today = () => `/v/Daily/${localDateStamp()}.md`
const page = () => within(document.querySelector('.viewer:not([hidden])') as HTMLElement)
const bar = () => within(screen.getByRole('navigation', { name: 'Places' }))
const line = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.composer .cm-editor')!)!
const type = (text: string) => {
  const view = line()
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length } })
}
const focus = () => act(() => void window.dispatchEvent(new Event('focus')))

describe('the phone', () => {
  /** Opening the app to look at the day made an empty note, which a sync would commit. */
  it('starts on today, and writes nothing until a line is filed', async () => {
    await openApp()
    await waitFor(() => expect(page().getByText(localDateStamp())).toBeTruthy())
    await waitFor(() => expect(document.querySelector('.composer .cm-editor')).toBeTruthy())
    expect(disk.read(today())).toBeUndefined()

    type('walked to the harbour')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(disk.read(today())).toBe('#timeline\n    walked to the harbour\n'))
    expect(line().state.doc.toString()).toBe('')
  })

  it('starts a line with the time, puts a tag at the caret, and files it on Enter', async () => {
    await openApp()
    await waitFor(() => expect(document.querySelector('.composer .cm-editor')).toBeTruthy())
    // On an empty line too, the typing goes on after the time.
    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    expect(line().state.selection.main.head).toBe(line().state.doc.length)
    type('lunch')
    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    const clock = localTimeStamp()
    fireEvent.click(screen.getByRole('button', { name: '#expense' }))
    expect(line().state.doc.toString()).toBe(`${clock} lunch #expense `)
    // Again, Now replaces the time rather than adding a second.
    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    expect(line().state.doc.toString()).toBe(`${localTimeStamp()} lunch #expense `)

    fireEvent.keyDown(line().contentDOM, { key: 'Enter' })
    await waitFor(() => expect(disk.read(today())).toBe(`#timeline\n    ${localTimeStamp()} lunch #expense\n`))
  })

  it('keeps a draft while another page is open', async () => {
    await openApp()
    await waitFor(() => expect(document.querySelector('.composer .cm-editor')).toBeTruthy())
    type('half a thought')
    fireEvent.click(bar().getByRole('button', { name: 'Timeline' }))
    await waitFor(() => expect(document.querySelector('.composer')).toBeNull())
    fireEvent.click(bar().getByRole('button', { name: 'Today' }))
    await waitFor(() => expect(line().state.doc.toString()).toBe('half a thought'))
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

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { disk, fsModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * A note open in the real editor when something else writes it: an agent in the
 * terminal, a pull. The editor used to be rebuilt over the new text, putting the
 * caret at a daily note's end and dropping its folds and undo; a heading and its
 * lines were lost that morning. Now the change is applied in place.
 */

// Before CodeMirror loads, so `Mod-z` is ⌘ (see `markdownEditor.test.tsx`).
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, 'platform', { configurable: true, value: 'MacIntel' })
})

import { EditorView } from '@codemirror/view'
import { foldEffect, foldedRanges } from '@codemirror/language'
import { indentRange } from '../editorFold'

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null), confirm: vi.fn(async () => true) }))

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
})

const note = ['the first line', '#diet', '     08:40 #food oats', '     09:00 #food tea', 'the line typed on'].join('\n')
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe('a write from outside, to the open note', () => {
  it('reaches the editor as a change: the caret, the fold and the undo stay', { timeout: 40000 }, async () => {
    disk.write('/v/plan.md', note)
    const { default: App } = await import('../App')
    const { getByText } = render(<App />)
    await waitFor(() => expect(getByText('plan')).toBeTruthy(), { timeout: 10000 })
    getByText('plan').click()
    await waitFor(() => expect(document.querySelector('.cm-content')).toBeTruthy(), { timeout: 20000 })
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!

    // Folded, and typed at the end of the last line.
    const heading = view.state.doc.line(2)
    view.dispatch({ effects: foldEffect.of(indentRange(view.state, heading.from, heading.to)!) })
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.dispatch(view.state.update(view.state.replaceSelection('!'), { userEvent: 'input.type' }))
    await waitFor(() => expect(disk.read('/v/plan.md')).toBe(`${note}!`))

    // The agent rewrites the first line, and the window comes back to the front.
    const theirs = `${note}!`.replace('the first line', 'the first line, as the agent wrote it')
    disk.write('/v/plan.md', theirs)
    await act(async () => void window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(view.state.doc.toString()).toBe(theirs))

    expect(EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)).toBe(view)
    expect(view.state.selection.main.head).toBe(theirs.length)
    expect(foldedRanges(view.state).size).toBe(1)
    // Taking it in writes nothing back.
    await settle(1200)
    expect(disk.read('/v/plan.md')).toBe(theirs)

    // Undo takes back the typing, not the agent's line.
    fireEvent.keyDown(view.contentDOM, { key: 'z', metaKey: true })
    expect(view.state.doc.toString()).toBe(theirs.slice(0, -1))
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * **The reading pane is a workspace**: notes open as tabs, and a group of tabs can
 * be split into panes. `workspace.test.ts` holds the model; this drives the app —
 * the strip, the split buttons, and what the sidebar opens into.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
// xterm paints to a canvas jsdom does not have; what the tab *is* is the model's.
vi.mock('../TerminalPane', () => ({
  TerminalPane: ({ session }: { session: string }) => <div data-testid="terminal">{session}</div>,
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  disk.write('/v/alpha.md', '# alpha\n')
  disk.write('/v/beta.md', '# beta\n')
})

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

const sidebar = () => within(document.querySelector('.sidebar')!)
const tabs = () => [...document.querySelectorAll('[role="tab"] .tab-name')].map((el) => el.textContent)
const activeTabs = () =>
  [...document.querySelectorAll('[role="tab"][aria-selected="true"] .tab-name')].map((el) => el.textContent)
const title = () => document.querySelector('.viewer-title')?.textContent ?? null
const groups = () => document.querySelectorAll('.pane-group').length

async function openFromTree(name: string) {
  fireEvent.click(sidebar().getByText(name))
  await waitFor(() => expect(activeTabs()).toContain(name))
}

describe('tabs', () => {
  it('opens each note as a tab and shows the one clicked', async () => {
    await openApp()
    await openFromTree('alpha')
    await openFromTree('beta')
    expect(tabs()).toEqual(['alpha', 'beta'])
    expect(title()).toBe('beta')
    // One editor on screen: the other tab keeps its buffer and draws nothing.
    expect(screen.getAllByTestId('editor')).toHaveLength(1)

    fireEvent.mouseDown(screen.getByRole('tab', { name: /alpha/ }))
    await waitFor(() => expect(title()).toBe('alpha'))
    expect(tabs()).toEqual(['alpha', 'beta'])
  })

  it('opens a note that is already open by going to its tab', async () => {
    await openApp()
    await openFromTree('alpha')
    await openFromTree('beta')
    await openFromTree('alpha')
    expect(tabs()).toEqual(['alpha', 'beta'])
    expect(title()).toBe('alpha')
  })

  it('closes a tab to its neighbour, and the last one to the empty pane', async () => {
    await openApp()
    await openFromTree('alpha')
    await openFromTree('beta')
    fireEvent.click(screen.getByLabelText('Close beta'))
    await waitFor(() => expect(title()).toBe('alpha'))
    fireEvent.click(screen.getByLabelText('Close alpha'))
    await waitFor(() => expect(tabs()).toEqual([]))
    expect(screen.getByText(/Choose a note on the left/)).toBeTruthy()
  })

  /** The graph is a tab like the rest, and the footer's button still toggles it:
   *  opened over the note, closed back to it. */
  it('opens the graph as a tab and closes it back to the note', async () => {
    await openApp()
    await openFromTree('alpha')
    fireEvent.click(screen.getByLabelText('Open the note graph'))
    await waitFor(() => expect(activeTabs()).toEqual(['Graph']))
    expect(tabs()).toEqual(['alpha', 'Graph'])
    fireEvent.click(screen.getByLabelText('Close the note graph'))
    await waitFor(() => expect(tabs()).toEqual(['alpha']))
    expect(title()).toBe('alpha')
  })
})

describe('a terminal', () => {
  it('opens from Applications, returns to it on the next press, and keeps it mounted out of sight', async () => {
    await openApp()
    await openFromTree('alpha')
    fireEvent.click(screen.getByLabelText('Terminal'))
    await waitFor(() => expect(activeTabs()).toEqual(['Terminal']))
    // The pane is loaded when the first terminal opens, so it arrives a tick later.
    await waitFor(() => expect(screen.getByTestId('terminal')).toBeTruthy())
    // Back to the note: the terminal stays mounted — its shell lives on — hidden.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /alpha/ }))
    await waitFor(() => expect(activeTabs()).toEqual(['alpha']))
    expect(screen.getByTestId('terminal').closest('.viewer')?.hasAttribute('hidden')).toBe(true)
    // The row goes back to it rather than opening another.
    fireEvent.click(screen.getByLabelText('Terminal'))
    await waitFor(() => expect(activeTabs()).toEqual(['Terminal']))
    expect(tabs()).toEqual(['alpha', 'Terminal'])
    // A second one is asked for by name.
    fireEvent.contextMenu(screen.getByLabelText('Terminal'))
    fireEvent.click(screen.getByText('New terminal'))
    await waitFor(() => expect(tabs()).toEqual(['alpha', 'Terminal', 'Terminal']))
  })
})

describe('what survives a move', () => {
  /** **The same element, in a new place.** A split re-parented every element under
   *  it, and a terminal in the pane lost its shell — reported as the terminal
   *  restarting whenever anything moved across panes. The DOM is flat now. */
  it('keeps a terminal’s element through a split and a move to the new pane', async () => {
    await openApp()
    await openFromTree('alpha')
    fireEvent.click(screen.getByLabelText('Terminal'))
    const before = await screen.findByTestId('terminal')
    fireEvent.click(screen.getByLabelText('Split right'))
    await waitFor(() => expect(groups()).toBe(2))
    expect(screen.getByTestId('terminal')).toBe(before)

    const [, second] = [...document.querySelectorAll('.pane-group')] as HTMLElement[]
    const payload = new Map<string, string>()
    const dataTransfer = {
      setData: (type: string, value: string) => payload.set(type, value),
      getData: (type: string) => payload.get(type) ?? '',
      types: ['application/x-journeys-tab'],
      effectAllowed: 'move',
      dropEffect: 'move',
    }
    fireEvent.dragStart(screen.getByRole('tab', { name: /Terminal/ }), { dataTransfer })
    fireEvent.drop(second.querySelector('.tab-strip')!, { dataTransfer })
    await waitFor(() => expect(within(second).getByRole('tab', { name: /Terminal/ })).toBeTruthy())
    expect(screen.getByTestId('terminal')).toBe(before)
  })
})

describe('panes', () => {
  it('splits into a second, focused group that the next note opens into', async () => {
    await openApp()
    await openFromTree('alpha')
    fireEvent.click(screen.getByLabelText('Split right'))
    await waitFor(() => expect(groups()).toBe(2))
    expect(document.querySelector('.split-handle[aria-orientation="vertical"]')).toBeTruthy()
    // The new pane is empty and focused, so the sidebar opens into it.
    await openFromTree('beta')
    const [first, second] = [...document.querySelectorAll('.pane-group')]
    expect(within(first as HTMLElement).getByRole('tab', { name: /alpha/ })).toBeTruthy()
    expect(within(second as HTMLElement).getByRole('tab', { name: /beta/ })).toBeTruthy()
    expect(second.getAttribute('data-focused')).toBe('true')
    // Two editors now, one per pane.
    expect(screen.getAllByTestId('editor')).toHaveLength(2)
  })

  it('folds a pane away when its last tab closes, and an empty one from its own ×', async () => {
    await openApp()
    await openFromTree('alpha')
    fireEvent.click(screen.getByLabelText('Split down'))
    await waitFor(() => expect(groups()).toBe(2))
    expect(document.querySelector('.split-handle[aria-orientation="horizontal"]')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Close pane'))
    await waitFor(() => expect(groups()).toBe(1))

    fireEvent.click(screen.getByLabelText('Split right'))
    await waitFor(() => expect(groups()).toBe(2))
    await openFromTree('beta')
    fireEvent.click(screen.getByLabelText('Close beta'))
    await waitFor(() => expect(groups()).toBe(1))
    expect(title()).toBe('alpha')
  })

  /** A tab is moved by dragging it onto another pane's strip. */
  it('moves a tab to another pane by drag', async () => {
    await openApp()
    await openFromTree('alpha')
    await openFromTree('beta')
    fireEvent.click(screen.getByLabelText('Split right'))
    await waitFor(() => expect(groups()).toBe(2))
    const [first, second] = [...document.querySelectorAll('.pane-group')] as HTMLElement[]
    const payload = new Map<string, string>()
    const dataTransfer = {
      setData: (type: string, value: string) => payload.set(type, value),
      getData: (type: string) => payload.get(type) ?? '',
      types: ['application/x-journeys-tab'],
      effectAllowed: 'move',
      dropEffect: 'move',
    }
    fireEvent.dragStart(within(first).getByRole('tab', { name: /beta/ }), { dataTransfer })
    fireEvent.drop(second.querySelector('.tab-strip')!, { dataTransfer })
    await waitFor(() => expect(within(second).getByRole('tab', { name: /beta/ })).toBeTruthy())
    expect(within(first).queryByRole('tab', { name: /beta/ })).toBeNull()
    expect(second.getAttribute('data-focused')).toBe('true')
  })

  /** Dragging a page to a pane's right edge gives it a pane of its own there. */
  it('splits a pane by dropping a tab at its edge', async () => {
    await openApp()
    await openFromTree('alpha')
    await openFromTree('beta')
    // The drop target exists only while a tab is being dragged.
    const startDrag = () => fireEvent.dragStart(screen.getByRole('tab', { name: /beta/ }), { dataTransfer })
    const bodyOf = () => document.querySelector('.pane-drop') as HTMLElement
    const measured = (el: HTMLElement) => (el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect)
    const payload = new Map<string, string>()
    const dataTransfer = {
      setData: (type: string, value: string) => payload.set(type, value),
      getData: (type: string) => payload.get(type) ?? '',
      types: ['application/x-journeys-tab'],
      effectAllowed: 'move',
      dropEffect: 'move',
    }
    // jsdom has no DragEvent, so a MouseEvent carries the pointer and the payload.
    const at = (type: string) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 390, clientY: 150 })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      return event
    }
    startDrag()
    await waitFor(() => expect(bodyOf()).toBeTruthy())
    measured(bodyOf())
    fireEvent(bodyOf(), at('dragover'))
    expect(bodyOf().getAttribute('data-zone')).toBe('right')
    fireEvent(bodyOf(), at('drop'))
    await waitFor(() => expect(groups()).toBe(2))
    expect(document.querySelector('.split-handle[aria-orientation="vertical"]')).toBeTruthy()
    const [first, second] = [...document.querySelectorAll('.pane-group')] as HTMLElement[]
    expect(within(first).getByRole('tab', { name: /alpha/ })).toBeTruthy()
    expect(within(second).getByRole('tab', { name: /beta/ })).toBeTruthy()
    expect(within(first).queryByRole('tab', { name: /beta/ })).toBeNull()
  })

  /** A press in a pane focuses it, so a click in the sidebar opens there. */
  it('opens into the pane last pressed', async () => {
    await openApp()
    await openFromTree('alpha')
    fireEvent.click(screen.getByLabelText('Split right'))
    await waitFor(() => expect(groups()).toBe(2))
    const [first] = [...document.querySelectorAll('.pane-group')]
    fireEvent.mouseDown(within(first as HTMLElement).getByRole('tab', { name: /alpha/ }))
    await waitFor(() => expect(first.getAttribute('data-focused')).toBe('true'))
    await openFromTree('beta')
    expect(within(first as HTMLElement).getByRole('tab', { name: /beta/ })).toBeTruthy()
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

/**
 * A shell that finishes starting after its tab is gone is detached. The
 * spawn runs off the main thread, so a tab closed during it sends its
 * detach first, and the spawn then leaves a tmux client no one sees. Each
 * mount is its own channel, so that late detach only reaches its own tab.
 * xterm and the bridge are stand-ins; this tests the pane's side.
 */

const focused = vi.hoisted(() => ({ count: 0 }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options = {}
    loadAddon() {}
    open() {}
    write() {}
    writeln() {}
    focus() {
      focused.count++
    }
    dispose() {}
    onData() {
      return { dispose() {} }
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const pending = vi.hoisted(() => ({ spawns: [] as ((persists: boolean) => void)[] }))
const bridge = vi.hoisted(() => ({
  ANSI: { dark: {}, light: {} },
  TMUX_CONF: '# the default',
  spawnTerminal: vi.fn(
    (_id: string, _name: string) => new Promise<boolean>((resolve) => pending.spawns.push(resolve))
  ),
  killTerminal: vi.fn(async (_id: string) => {}),
  writeTerminal: vi.fn(async () => {}),
  resizeTerminal: vi.fn(async () => {}),
  onTerminalOutput: vi.fn(async () => () => {}),
  onTerminalExit: vi.fn(async () => () => {}),
}))
vi.mock('../terminal', () => bridge)

globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

afterEach(cleanup)
// Each test counts its own spawns: the spawn starts as the pane mounts.
beforeEach(() => {
  bridge.spawnTerminal.mockClear()
  pending.spawns.length = 0
})

describe('a Terminal tab', () => {
  /** Only the first mount took the keyboard, so keys typed after a tab switch went to the note. */
  it('takes the keyboard each time its tab shows', async () => {
    const { TerminalPane } = await import('../TerminalPane')
    const { rerender } = render(<TerminalPane session="journeys-1" cwd="/v" />)
    rerender(<TerminalPane session="journeys-1" cwd="/v" shown={false} />)
    focused.count = 0
    rerender(<TerminalPane session="journeys-1" cwd="/v" shown />)
    await new Promise((done) => setTimeout(done, 10))
    expect(focused.count).toBe(1)
  })

  it('detaches a shell that finished starting after the tab closed', async () => {
    const { TerminalPane } = await import('../TerminalPane')
    const { unmount } = render(<TerminalPane session="journeys-1" cwd="/v" />)
    await vi.waitFor(() => expect(bridge.spawnTerminal).toHaveBeenCalledTimes(1))
    const [id] = bridge.spawnTerminal.mock.calls[0]
    unmount()
    const before = bridge.killTerminal.mock.calls.length
    pending.spawns[0](true)
    await vi.waitFor(() => expect(bridge.killTerminal.mock.calls.length).toBeGreaterThan(before))
    expect(bridge.killTerminal).toHaveBeenLastCalledWith(id)
  })

  it('attaches each mount on a channel of its own, to the one session', async () => {
    const { TerminalPane } = await import('../TerminalPane')
    bridge.spawnTerminal.mockClear()
    render(<TerminalPane session="journeys-2" cwd="/v" />).unmount()
    render(<TerminalPane session="journeys-2" cwd="/v" />)
    await vi.waitFor(() => expect(bridge.spawnTerminal).toHaveBeenCalledTimes(2))
    const [[first, name], [second, again]] = bridge.spawnTerminal.mock.calls
    expect([name, again]).toEqual(['journeys-2', 'journeys-2'])
    expect(first).not.toBe(second)
  })
})

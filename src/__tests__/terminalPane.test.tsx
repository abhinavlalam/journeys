/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

/**
 * **A shell that finishes starting after its tab has gone is detached.** The spawn
 * runs off the main thread, so a tab closed while it is under way sends its detach
 * first, for a session not registered yet, and the spawn then lands a tmux client
 * nobody shows, alive until the app quits. And each mount is its own channel, so
 * that late detach can only ever reach the tab it belonged to.
 *
 * xterm draws to a canvas jsdom does not have, so it is a stand-in here, as is the
 * bridge: what is tested is the pane's side of the conversation.
 */

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options = {}
    loadAddon() {}
    open() {}
    write() {}
    writeln() {}
    focus() {}
    dispose() {}
    onData() {
      return { dispose() {} }
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('../vault', async (real) => ({ ...(await real<object>()), ensureTmuxConfig: async () => {} }))

const pending = vi.hoisted(() => ({ spawns: [] as ((persists: boolean) => void)[] }))
const bridge = vi.hoisted(() => ({
  ANSI: { dark: {}, light: {} },
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

describe('a Terminal tab', () => {
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

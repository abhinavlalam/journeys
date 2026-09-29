import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A quit waits for the typing. The app asks; the page writes the open
 * notes and quits, or stays and says why when a note could not be written.
 */
const handlers = new Map<string, () => Promise<void>>()
const invoked = vi.fn(async (_command: string) => {})
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: () => Promise<void>) => {
    handlers.set(name, handler)
    return () => handlers.delete(name)
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string) => invoked(command) }))

beforeEach(() => {
  handlers.clear()
  invoked.mockClear()
})

describe('a quit', () => {
  it('writes the open notes, then quits', async () => {
    const { onQuit } = await import('../quit')
    const order: string[] = []
    invoked.mockImplementation(async (command) => void order.push(command))
    await onQuit(async () => void order.push('flush'), () => {})
    await handlers.get('quit-requested')!()
    expect(order).toEqual(['flush', 'quit'])
  })

  it('stays, and says so, when a note could not be written', async () => {
    const { onQuit } = await import('../quit')
    const said = vi.fn()
    await onQuit(async () => {
      throw new Error('disk full')
    }, said)
    await handlers.get('quit-requested')!()
    expect(invoked.mock.calls.map(([command]) => command)).toEqual(['stay'])
    expect(said.mock.calls[0][0]).toMatch(/Not quitting.*disk full/)
  })
})

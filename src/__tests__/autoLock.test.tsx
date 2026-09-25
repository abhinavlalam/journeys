/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { MINUTE_MS } from '../clock'
import { useAutoLock } from '../useAutoLock'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/**
 * **An unlocked note locks again once it has gone unused.** Used is input while it
 * is the note in front; the clock, not a timer's count, decides, so a machine that
 * slept past the minutes finds the note locked on its first look.
 */
describe('locking a note that has gone unused', () => {
  const mount = (front: string | null) => {
    vi.useFakeTimers()
    const onLock = vi.fn()
    let open = ['Letters.enc']
    const hook = renderHook((p: { front: string | null }) =>
      useAutoLock({ minutes: 5, front: p.front, unlocked: () => open, onLock: (paths) => {
        open = open.filter((path) => !paths.includes(path))
        onLock(paths)
      } }),
      { initialProps: { front } }
    )
    return { onLock, hook }
  }
  const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

  it('locks once the minutes have passed with no use', async () => {
    const { onLock } = mount(null)
    await pass(4 * MINUTE_MS)
    expect(onLock).not.toHaveBeenCalled()
    await pass(2 * MINUTE_MS)
    expect(onLock).toHaveBeenCalledWith(['Letters.enc'])
  })

  it('stays open while it is the note in front and in use', async () => {
    const { onLock } = mount('Letters.enc')
    for (let i = 0; i < 4; i++) {
      await pass(3 * MINUTE_MS)
      fireEvent.keyDown(window, { key: 'a' })
    }
    expect(onLock).not.toHaveBeenCalled()
  })

  it('locks while another note is the one being used', async () => {
    const { onLock } = mount('Diary.md')
    for (let i = 0; i < 3; i++) {
      await pass(2 * MINUTE_MS)
      fireEvent.pointerDown(window)
    }
    expect(onLock).toHaveBeenCalledWith(['Letters.enc'])
  })

  it('locks on the first look after the machine slept past the minutes', async () => {
    const { onLock } = mount(null)
    await pass(MINUTE_MS)
    // Asleep: the clock moves and no timer runs.
    vi.setSystemTime(Date.now() + 60 * MINUTE_MS)
    fireEvent.focus(window)
    expect(onLock).toHaveBeenCalledWith(['Letters.enc'])
  })
})

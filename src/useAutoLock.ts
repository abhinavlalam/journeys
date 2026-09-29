import { useEffect, useRef } from 'react'
import { MINUTE_MS } from './clock'
import { isEncrypted } from './vaultModel'
import { useWindowEvent } from './useWindowEvent'

/** How often unlocked notes are checked. A lock lands at most this late. */
const LOOK_MS = MINUTE_MS / 4

/**
 * An unlocked note locks again after `minutes` unused. Used means a key, press
 * or scroll while it is the note in front, so work in another note does not keep
 * it open. Measured by the clock, not a timer, because timers stop while the
 * machine sleeps and a laptop opened next morning must find its notes locked.
 */
export function useAutoLock({
  minutes,
  front,
  unlocked,
  onLock,
}: {
  minutes: number
  /** The note in the focused pane, or null. */
  front: string | null
  unlocked: () => string[]
  onLock: (paths: string[]) => void
}) {
  const used = useRef(new Map<string, number>())
  const latest = useRef({ minutes, front, unlocked, onLock })
  latest.current = { minutes, front, unlocked, onLock }

  const touch = () => {
    const { front } = latest.current
    if (front && isEncrypted(front)) used.current.set(front, Date.now())
  }
  useWindowEvent('keydown', touch)
  useWindowEvent('pointerdown', touch)
  useWindowEvent('wheel', touch)

  const look = () => {
    const { minutes, unlocked, onLock } = latest.current
    const now = Date.now()
    const open = new Set(unlocked())
    // A note locked by hand is dropped here, or its old time
    // would lock it as soon as it is unlocked again.
    for (const path of used.current.keys()) if (!open.has(path)) used.current.delete(path)
    const stale: string[] = []
    for (const path of open) {
      const at = used.current.get(path)
      // Unlocked since the last check: its minutes start now.
      if (at === undefined) used.current.set(path, now)
      else if (now - at >= minutes * MINUTE_MS) stale.push(path)
    }
    if (stale.length === 0) return
    stale.forEach((path) => used.current.delete(path))
    onLock(stale)
  }
  useWindowEvent('focus', look)
  useEffect(() => {
    const id = setInterval(() => look(), LOOK_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

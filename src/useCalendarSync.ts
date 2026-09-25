// The calendar keeping itself current, so a meeting moved in Google is moved in
// the day's note without anyone pressing a button.

import { useEffect, useRef, useState } from 'react'
import { MINUTE_MS } from './clock'
import { isOffline } from './useSync'
import { useWindowEvent } from './useWindowEvent'

/**
 * Runs `sync` when the vault opens or a calendar is added, every `everyMinutes`,
 * and on coming back to the window when the last one is older than that — a window
 * in the background is throttled, and coming back is when the day is looked at.
 * The button is `now(true)`. Offline is a state and not a failure, unless the
 * button was pressed; anything else is said once.
 */
export function useCalendarSync({
  vaultPath,
  feeds,
  everyMinutes,
  sync,
  onError,
}: {
  vaultPath: string | null
  /** How many calendars there are; none, and there is nothing to read. */
  feeds: number
  everyMinutes: number
  /** Reads the feeds and writes what they say into the notes. */
  sync: () => Promise<void>
  onError: (message: string) => void
}): { syncing: boolean; now: (byHand?: boolean) => Promise<void> } {
  const [syncing, setSyncing] = useState(false)
  const busy = useRef(false)
  const lastRun = useRef(0)
  const said = useRef<string | null>(null)

  async function now(byHand = false) {
    if (!vaultPath || feeds === 0 || busy.current) return
    busy.current = true
    lastRun.current = Date.now()
    setSyncing(true)
    try {
      await sync()
      said.current = null
    } catch (err) {
      const message = String(err)
      if (byHand || (!isOffline(message) && said.current !== message)) {
        said.current = message
        onError(message)
      }
    } finally {
      busy.current = false
      setSyncing(false)
    }
  }

  // Read through a ref, for the reason `useWindowEvent` gives.
  const latest = useRef(now)
  useEffect(() => {
    latest.current = now
  })
  useEffect(() => {
    if (vaultPath && feeds > 0) void latest.current()
  }, [vaultPath, feeds])
  useEffect(() => {
    if (!vaultPath || feeds === 0) return
    const timer = setInterval(() => void latest.current(), everyMinutes * MINUTE_MS)
    return () => clearInterval(timer)
  }, [vaultPath, feeds, everyMinutes])
  useWindowEvent('focus', () => {
    if (Date.now() - lastRun.current >= everyMinutes * MINUTE_MS) void now()
  })

  return { syncing, now }
}

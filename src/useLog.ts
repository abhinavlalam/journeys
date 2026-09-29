import { useCallback, useEffect, useState } from 'react'

/** One thing the app said, and when. */
export interface LogItem {
  at: number
  text: string
}

/** How long a message stays at the bottom of the window: long enough to read, and
 *  it is in the Log after. It stayed until dismissed, over rounds that had since
 *  gone through. */
export const SHOWN_MS = 8000

/**
 * **What the app says**: each message shown at the bottom of the window for a
 * while, and every one kept in the Log for the window's life — in memory, as
 * nothing but the notes is stored. `said` is the latest until `say(null)` puts it
 * away, timer or not, for the one screen with no Log to look in: the one before a
 * vault is open.
 */
export function useLog() {
  const [items, setItems] = useState<LogItem[]>([])
  const [said, setSaid] = useState<LogItem | null>(null)
  const [shown, setShown] = useState<LogItem | null>(null)
  // Stable, as the setter it replaced was: effects and props hold it.
  const say = useCallback((text: string | null) => {
    const item = text === null ? null : { at: Date.now(), text }
    if (item) setItems((was) => [...was, item])
    setSaid(item)
    setShown(item)
  }, [])
  useEffect(() => {
    if (!shown) return
    const gone = setTimeout(() => setShown(null), SHOWN_MS)
    return () => clearTimeout(gone)
  }, [shown])
  return { items, said, shown, say }
}

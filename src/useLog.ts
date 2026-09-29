import { useCallback, useEffect, useState } from 'react'

/** A message the app showed, and when. */
export interface LogItem {
  at: number
  text: string
}

/** How long a message stays on screen. After that it is only in the Log. */
export const SHOWN_MS = 8000

/**
 * Messages the app shows. Each one appears at the bottom of the window for a while
 * and is kept in the Log until the window closes (in memory only).
 *
 * `said` is the latest message until `say(null)` clears it. The screen before a
 * vault is open uses it, because that screen has no Log.
 */
export function useLog() {
  const [items, setItems] = useState<LogItem[]>([])
  const [said, setSaid] = useState<LogItem | null>(null)
  const [shown, setShown] = useState<LogItem | null>(null)
  // Keep `say` stable: effects and props depend on it.
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

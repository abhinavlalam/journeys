import { useEffect, useRef } from 'react'

/**
 * `handler` on every `type` event at the window while mounted,
 * added once, always calling the latest `handler` through a ref.
 *
 * A listener that depends on its handler is re-added on every render, which kept the
 * sync's timer from ever firing. A listener for the window's life uses this: shortcuts,
 * the buffer's re-read on focus, the sync's focus and blur, the window's drop. One tied
 * to a vault (its texts, its config files, the Actions pane) is added and removed in the
 * effect that reads that vault, and one for a gesture (a drag, a resize) with it.
 */
export function useWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  handler: (event: WindowEventMap[K]) => void
) {
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  useEffect(() => {
    const call = (event: WindowEventMap[K]) => latest.current(event)
    window.addEventListener(type, call)
    return () => window.removeEventListener(type, call)
  }, [type])
}

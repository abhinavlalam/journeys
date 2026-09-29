import { useEffect, useRef } from 'react'

/**
 * `handler` on every `type` event at the window while mounted,
 * added once, always calling the latest `handler` through a ref.
 *
 * A listener that depends on its handler is re-added on every render, which kept the
 * sync's timer from ever firing. Every long-lived window listener uses this:
 * shortcuts, the buffer's re-read on focus, the sync's focus and blur, the window's
 * drop. A listener for one gesture (a drag, a resize) is added and removed with it.
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

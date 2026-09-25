import { useEffect, useRef } from 'react'

/**
 * `handler` on every `type` event at the window while the component is mounted —
 * **added once, and always the latest `handler`**, read through a ref.
 *
 * A listener that depends on its handler is torn down and added again whenever the
 * handler is made afresh, which for a closure is every render: the sync's minute
 * restarted on each one and never came round, and re-registering on every note
 * switch is how the buffer's focus re-read was starved before that. Every window
 * listener that lives as long as a component goes through here — the keyboard
 * shortcuts, the buffer's re-read on focus, the sync's device switch, the window's
 * own drop. A listener that lives for one gesture (a drag, a resize) is added and
 * removed with the gesture instead.
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

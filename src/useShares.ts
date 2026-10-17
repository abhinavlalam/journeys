import { useEffect, useRef } from 'react'
import { onAndroid } from './platform'
import { takeShares, type Share } from './share'
import { useWindowEvent } from './useWindowEvent'

/** `PhonePlugin.TAKE`: the phone's half asking for a take now. */
const TAKE = 'journeys:take'

/**
 * What other apps share in, filed as it is taken: when the vault opens and on
 * each return to the app, which is how a share arrives. One taking at a time, or
 * a share would be filed twice. One that could not be filed (`file` said why) is
 * kept, with its files as far as they got, and tried again on the next return.
 * A press on the home screen's "Add to today" arrives the same way (`capture`).
 */
export function useShares(
  vaultPath: string | null,
  file: (share: Share) => Promise<boolean>,
  capture: () => void,
  onError: (message: string) => void
) {
  const waiting = useRef<Share[]>([])
  const running = useRef(Promise.resolve())
  const latest = useRef({ vaultPath, file, capture, onError })
  latest.current = { vaultPath, file, capture, onError }
  const take = () => {
    running.current = running.current.then(async () => {
      const { vaultPath, file, onError } = latest.current
      if (!onAndroid || !vaultPath) return
      try {
        const taken = await takeShares()
        waiting.current.push(...taken.shares)
        if (taken.capture) latest.current.capture()
      } catch (err) {
        onError(`Could not take what was shared: ${String(err)}`)
      }
      while (waiting.current.length > 0 && (await file(waiting.current[0]))) waiting.current.shift()
    })
  }
  useEffect(take, [vaultPath])
  useWindowEvent('focus', take)
  // Asked by the phone's half: the home screen's bar pressed while the app was in the
  // background arrived after the return's take (`PhonePlugin`).
  useEffect(() => {
    window.addEventListener(TAKE, take)
    return () => window.removeEventListener(TAKE, take)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

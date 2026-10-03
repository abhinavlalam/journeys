import { useEffect, useRef } from 'react'
import { onAndroid } from './platform'
import { takeShares, type Share } from './share'
import { useWindowEvent } from './useWindowEvent'

/**
 * What other apps share in, filed as it is taken: when the vault opens and on
 * each return to the app, which is how a share arrives. One taking at a time, or
 * a share would be filed twice. One that could not be filed (`file` said why) is
 * kept, with its files as far as they got, and tried again on the next return.
 */
export function useShares(vaultPath: string | null, file: (share: Share) => Promise<boolean>, onError: (message: string) => void) {
  const waiting = useRef<Share[]>([])
  const running = useRef(Promise.resolve())
  const latest = useRef({ vaultPath, file, onError })
  latest.current = { vaultPath, file, onError }
  const take = () => {
    running.current = running.current.then(async () => {
      const { vaultPath, file, onError } = latest.current
      if (!onAndroid || !vaultPath) return
      try {
        waiting.current.push(...(await takeShares()))
      } catch (err) {
        onError(`Could not take what was shared: ${String(err)}`)
      }
      while (waiting.current.length > 0 && (await file(waiting.current[0]))) waiting.current.shift()
    })
  }
  useEffect(take, [vaultPath])
  useWindowEvent('focus', take)
}

// A quit waits for the open notes to be written: the page's half of `quit` in `lib.rs`.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * When the app is asked to quit, `flush` the open notes and
 * quit, or stay and say so when a note could not be written.
 */
export function onQuit(flush: () => Promise<void>, onError: (message: string) => void): Promise<UnlistenFn> {
  return listen('quit-requested', async () => {
    try {
      await flush()
    } catch (err) {
      onError(`Not quitting: a note could not be saved. ${String(err)}`)
      await invoke('stay')
      return
    }
    await invoke('quit')
  })
}

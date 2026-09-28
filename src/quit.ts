// A quit waits for the open notes to be written — the page's half of `quit` in
// `lib.rs`, which asks before it lets the app end.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * When the app is asked to quit, `flush` the open notes and quit — or, when a note
 * could not be written, stay and say so: quitting then would lose the typing this
 * is here to keep.
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

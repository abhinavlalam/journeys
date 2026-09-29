// Shows a note in the system's file manager. Not a `VaultFs`
// call, since it neither reads nor writes the vault; its own
// file keeps `vault.ts` the only importer of the fs plugin.
//
// App commands rather than `tauri-plugin-opener`, which would
// give the webview a general "open anything" call. The app needs
// two: select a path in Finder, and follow a note's link.

import { invoke } from '@tauri-apps/api/core'

/**
 * Selects `absolutePath` in Finder. Rejects when the path is not there
 * (a folder note never typed in has no file yet); the caller reports it.
 */
export function revealInFinder(absolutePath: string): Promise<void> {
  return invoke('reveal', { path: absolutePath })
}

/**
 * Opens a link in the system's app for it. Rust checks the scheme and allows
 * only `http`, `https` and `mailto`: `open` can launch apps or mount volumes,
 * and a note can say anything. Rejects with the reason, which the caller shows.
 */
export function openExternal(url: string): Promise<void> {
  return invoke('open_url', { url })
}

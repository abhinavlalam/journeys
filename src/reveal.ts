// Showing a note where it lives, in the OS's own file manager.
//
// **Not part of `VaultFs`.** Nothing here reads or writes the vault, so this is not
// an eighth call on that interface — it is one `invoke` of one app command, and it
// sits in its own file so `vault.ts` stays the only module that imports
// `@tauri-apps/plugin-fs` and a test that wants this seam mocks four lines instead
// of a filesystem.
//
// **App** commands rather than a plugin: `tauri-plugin-opener` would do both and
// would also hand the webview a general "open this with the OS" call. This app
// needs exactly two verbs — select a path in Finder, and follow a link a note
// carries — and a command is how you say only that.

import { invoke } from '@tauri-apps/api/core'

/**
 * Selects `absolutePath` in Finder, opening the window it lives in.
 *
 * Rejects when the path is not there — a folder note that has never been typed in
 * has no file yet (CLAUDE.md), so this is a real answer and not an edge case. The
 * caller reports it; swallowing it is how the `.config` bug hid for a whole launch.
 */
export function revealInFinder(absolutePath: string): Promise<void> {
  return invoke('reveal', { path: absolutePath })
}

/**
 * Opens a link in whatever the OS has for it.
 *
 * **The scheme is checked on the Rust side**, which answers for `http`, `https`
 * and `mailto` and refuses the rest: `open` will launch an application or mount a
 * volume, and a note is a document that can say anything. Rejects with the reason,
 * which the caller shows.
 */
export function openExternal(url: string): Promise<void> {
  return invoke('open_url', { url })
}

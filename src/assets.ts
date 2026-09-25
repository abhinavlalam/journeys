// A file's own URL, for the pane to show it with.
//
// **Not part of `VaultFs`.** Nothing here reads the vault: `convertFileSrc` turns
// an absolute path into the URL Tauri's asset protocol serves it at, and the
// webview does the reading — which is the point for a 40 MB PDF, where the
// alternative is the whole file through IPC and into a data URI. The same argument
// `reveal.ts` makes for not being an eighth method on that interface.
//
// The protocol is off by default: `tauri.conf.json` enables it and scopes it, and
// without that every image is a broken one.

import { convertFileSrc } from '@tauri-apps/api/core'

export function fileUrl(absolutePath: string): string {
  try {
    return convertFileSrc(absolutePath)
  } catch {
    // Outside Tauri — a test, a browser — there is no asset protocol. `file://` is
    // what a path means then, and it keeps this function total.
    return `file://${absolutePath.split('/').map(encodeURIComponent).join('/')}`
  }
}

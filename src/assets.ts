// A file's own URL, for the pane to show it.
//
// Not a `VaultFs` call, since nothing here reads the vault: `convertFileSrc`
// turns a path into the URL Tauri's asset protocol serves, and the webview
// reads it. A 40 MB PDF would otherwise go through IPC into a data URI.
//
// The protocol is off by default: `tauri.conf.json` turns it on
// and scopes it, or every image is broken.

import { convertFileSrc } from '@tauri-apps/api/core'

export function fileUrl(absolutePath: string): string {
  try {
    return convertFileSrc(absolutePath)
  } catch {
    // Outside Tauri (a test, a browser) there is no asset
    // protocol, so a path is a `file://` URL.
    return `file://${absolutePath.split('/').map(encodeURIComponent).join('/')}`
  }
}

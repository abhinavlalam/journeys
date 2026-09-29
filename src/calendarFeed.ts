// Fetching a calendar feed: one app command, in its own file so
// a test mocks one function rather than a network.

import { invoke } from '@tauri-apps/api/core'

/**
 * The body at `url`. Rust allows only `http` and `https`, and
 * rejects with the fetch's own reason, which the caller shows.
 */
export function fetchFeed(url: string): Promise<string> {
  return invoke('fetch_feed', { url })
}

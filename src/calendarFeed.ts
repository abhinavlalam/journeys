// Fetching a calendar's feed — one `invoke` of one app command, in its own file
// for the reason `reveal.ts` is: a test that wants this seam mocks one function
// rather than a network.

import { invoke } from '@tauri-apps/api/core'

/** The body at `url`. The Rust side answers for `http` and `https` and refuses
 *  the rest, and rejects with the fetch's own reason, which the caller shows. */
export function fetchFeed(url: string): Promise<string> {
  return invoke('fetch_feed', { url })
}

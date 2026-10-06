import { invoke } from '@tauri-apps/api/core'
import { localDateStamp, localTimeStamp } from './clock'

/** What another app handed over through Android's share sheet (`PhonePlugin.kt`). */
export interface Share {
  /** When it arrived, in ms. */
  at: number
  text?: string | null
  subject?: string | null
  /**
   * Each a copy in the app's own files (`path`), or why it could not be read. `kept` is
   * where filing moved it in the vault, so a second try does not move it again.
   */
  files: { name: string; path?: string | null; error?: string | null; kept?: string }[]
}

/** Every share since the last call, each once. */
export const takeShares = () => invoke<Share[]>('phone_shares')

/** The day a share is filed in: the one it arrived on. */
export const shareDay = (share: Share) => localDateStamp(new Date(share.at))

/**
 * A share as a day's entry: the clock it arrived at, its `tag` (`settings.shareTag`),
 * its subject (a page's title beside its address) and first line, and a link to each
 * file in the vault. The rest of a message is nested under it, a line each, blank
 * lines left out.
 */
export function shareEntry(share: Share, files: readonly string[], tag: string): string {
  const lines = (share.text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const subject = share.subject?.trim()
  const head = [
    localTimeStamp(new Date(share.at)),
    `#${tag}`,
    subject && !lines.some((line) => line.includes(subject)) ? subject : '',
    lines[0] ?? '',
    ...files.map((path) => `[[${path}]]`),
  ]
  return [head.filter(Boolean).join(' '), ...lines.slice(1)].join('\n')
}

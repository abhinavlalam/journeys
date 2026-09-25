// The sync as the shell runs it: a round is flush, commit, pull, push — on a timer,
// when the window gains or loses focus, and on request. Nothing here knows git; `sync.ts` is the seam.

import { useCallback, useEffect, useRef, useState } from 'react'
import { agoWord } from './clock'
import { useWindowEvent } from './useWindowEvent'
import {
  syncCommit,
  syncConfigure,
  syncForgetToken,
  syncPull,
  syncPush,
  syncSetToken,
  syncStatus,
  type Pulled,
  type SyncStatus,
} from './sync'

type SyncPhase = 'idle' | 'working' | 'offline'

export interface Sync {
  /** Null until the vault has been looked at. */
  status: SyncStatus | null
  phase: SyncPhase
  /** When the last round finished on this device, ms. */
  syncedAt: number | null
  /** A round: flush, commit, pull, push. `byHand` is the Sync now button, the one
   *  round that may carry a deletion of more than half the vault. */
  now: (byHand?: boolean) => Promise<void>
  /** The repository's address (empty for none) and the identity the commits carry. */
  configure: (remote: string, name: string, email: string) => Promise<void>
  setToken: (token: string) => Promise<void>
  forgetToken: () => Promise<void>
}

/** A network that is not there is a state, not a failure: the round is retried at
 *  the next tick and nothing is said. Everything else is said once. */
const OFFLINE = /resolve|connect|network|timed out|unreachable|offline|reset by peer|SSL|TLS/i

/** Whether a failure is the network not being there — the vault's sync and the
 *  calendar's both stay quiet about that and try again. */
export const isOffline = (message: string) => OFFLINE.test(message)

export function useSync({
  vaultPath,
  everySeconds,
  flush,
  onPulled,
  onCommitted,
  onError,
}: {
  vaultPath: string | null
  everySeconds: number
  /** Writes what the open notes hold, so a commit never captures a half-saved file. */
  flush: () => Promise<void>
  /** Given what a pull changed on disk; the caller re-reads the tree and its buffers. */
  onPulled: (pulled: Pulled) => Promise<void>
  /** A commit found changes — the app's own, or made outside it (a file deleted in
   *  Finder took a focus to show); the caller walks the tree again. */
  onCommitted: () => Promise<void>
  onError: (message: string) => void
}): Sync {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [phase, setPhase] = useState<SyncPhase>('idle')
  const [syncedAt, setSyncedAt] = useState<number | null>(null)
  const busy = useRef(false)
  /** Said once: the same failure every tick is one failure. */
  const said = useRef<string | null>(null)

  // `sync_status` never fails on the Rust side — a folder that is not a repository
  // is a default answer — so a status that cannot be had is the bridge itself
  // missing (a test with no Tauri), and the sync has nothing to say rather than
  // something to report.
  const look = useCallback(async () => (vaultPath ? syncStatus(vaultPath).catch(() => null) : null), [vaultPath])

  const refresh = useCallback(async () => {
    setStatus(await look())
  }, [look])

  async function now(byHand = false) {
    if (!vaultPath || busy.current) return
    const current = await look()
    if (!current) return
    if (!current.isRepo) {
      setStatus(current)
      return
    }
    busy.current = true
    setPhase('working')
    try {
      await flush()
      if (await syncCommit(vaultPath, byHand)) await onCommitted()
      if (current.remote && current.hasToken) {
        const pulled = await syncPull(vaultPath)
        if (pulled.changed.length > 0) await onPulled(pulled)
        if (pulled.conflicts.length > 0) {
          onError(
            `Both devices changed ${pulled.conflicts.join(', ')}. This device's version stayed; the other's was kept beside it as "(other)".`
          )
        }
        await syncPush(vaultPath)
      }
      setSyncedAt(Date.now())
      setPhase('idle')
      said.current = null
    } catch (err) {
      const message = String(err)
      if (isOffline(message)) {
        setPhase('offline')
      } else {
        setPhase('idle')
        if (said.current !== message) {
          said.current = message
          onError(message)
        }
      }
    } finally {
      busy.current = false
      await refresh()
    }
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * **The rounds read the latest `now` through a ref, so the timer is set once per
   * vault and interval.** `now` closes over callbacks the caller makes afresh on
   * every render, and as the timer's dependency it tore the minute down and started
   * it again on each one. The timer is the autosave's idea one scale up; the window
   * events are the device switch — focus is coming back from the other device, so
   * its changes are pulled, and blur is leaving for it, so this one's are pushed.
   * That second half matters because a window in the background is throttled by
   * WebKit: measured in the running app, 47 minutes without a round.
   */
  const latest = useRef(now)
  useEffect(() => {
    latest.current = now
  })
  // **Opening the vault is coming back to it**, from the other device or a night
  // away, so it runs a round of its own. It was left to the window's focus, which
  // arrives before the vault has loaded as often as after: measured, one launch
  // synced four seconds in and the next not at all.
  useEffect(() => {
    if (vaultPath) void latest.current()
  }, [vaultPath])
  useEffect(() => {
    if (!vaultPath) return
    const timer = setInterval(() => void latest.current(), everySeconds * 1000)
    return () => clearInterval(timer)
  }, [vaultPath, everySeconds])
  useWindowEvent('focus', () => void now())
  useWindowEvent('blur', () => void now())

  /** A setting written to the repository or the keychain: said if it fails, and
   *  the status read back either way. */
  async function attempt(work: () => Promise<void>) {
    try {
      await work()
    } catch (err) {
      onError(String(err))
    }
    await refresh()
  }

  return {
    status,
    phase,
    syncedAt,
    now,
    configure: (remote, name, email) =>
      attempt(async () => {
        if (vaultPath) await syncConfigure(vaultPath, remote.trim() || null, name, email)
      }),
    // The remote is read fresh, not from `status`: Back up configures the address
    // and stores the token in one press, and the state had not caught up with the
    // address when the token asked for it — so the token was not stored, the round
    // saw "no token", committed locally, and said Synced. Found on the first vault.
    setToken: (token) =>
      attempt(async () => {
        const remote = (await look())?.remote
        if (remote) await syncSetToken(remote, token)
      }),
    forgetToken: () =>
      attempt(async () => {
        const remote = (await look())?.remote
        if (remote) await syncForgetToken(remote)
      }),
  }
}

/**
 * The one sentence the sync has to say, wherever it is shown — the row under
 * Applications and the first line of Settings → Sync read the same words.
 */
export function syncWord(sync: Sync): string {
  const { status, phase } = sync
  if (!status) return ''
  if (!status.isRepo) return 'Not backed up'
  if (phase === 'working') return 'Syncing…'
  if (!status.remote) return 'History on this device only'
  if (!status.hasToken) return 'Needs the token'
  if (phase === 'offline') {
    const waiting = status.ahead + (status.dirty > 0 ? 1 : 0)
    return waiting > 0 ? `Offline, ${waiting} ${waiting === 1 ? 'change' : 'changes'} waiting` : 'Offline'
  }
  return sync.syncedAt ? `Synced ${agoWord(sync.syncedAt)}` : 'Synced'
}

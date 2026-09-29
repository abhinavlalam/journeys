// The sync as the app runs it: a round is flush, commit, pull, push, on a
// timer, on focus and blur, and on request. Git itself is behind `sync.ts`.

import { useCallback, useEffect, useRef, useState } from 'react'
import { agoWord, SECOND_MS } from './clock'
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
  /** When the last round on this device finished, in ms. */
  syncedAt: number | null
  /**
   * A round: flush, commit, pull, push. `byHand` is Sync now,
   * the one round that may delete more than half the vault.
   */
  now: (byHand?: boolean) => Promise<void>
  /** The repository's address (empty for none) and the identity commits carry. */
  configure: (remote: string, name: string, email: string) => Promise<void>
  setToken: (token: string) => Promise<void>
  forgetToken: () => Promise<void>
}

/**
 * A missing network is a state, not a failure: retried next tick, and
 * nothing said. Everything else is said once, an untrusted
 * certificate included (a bare `SSL|TLS` here once made that say only
 * "offline"). A dropped connection says `reset` or `broken pipe`.
 */
const OFFLINE = /resolve|connect|network|timed out|unreachable|offline|reset by peer|broken pipe/i

/**
 * Whether a failure is the network not being there. The vault's
 * sync and the calendar's both stay quiet and retry.
 */
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
  /** Writes what the open notes hold, so a commit never takes a half-saved file. */
  flush: () => Promise<void>
  /**
   * Given what a pull changed on disk; the caller re-reads the tree and its buffers.
   */
  onPulled: (pulled: Pulled) => Promise<void>
  /**
   * A commit found changes, the app's or someone else's (a file
   * deleted in Finder); the caller reads the tree again.
   */
  onCommitted: () => Promise<void>
  onError: (message: string) => void
}): Sync {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [phase, setPhase] = useState<SyncPhase>('idle')
  const [syncedAt, setSyncedAt] = useState<number | null>(null)
  const busy = useRef(false)
  /** Said once: the same failure every tick is one failure. */
  const said = useRef<string | null>(null)

  // `sync_status` never fails in Rust (a folder that is not a
  // repository gets a default), so a failed status means the
  // bridge is missing, as in a test, and there is nothing to say.
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
   * Rounds read the latest `now` through a ref, so the timer is set once
   * per vault and interval; as a dependency it restarted on every
   * render. Focus is coming back from another device, so its changes are
   * pulled; blur is leaving, so this one's are pushed. WebKit throttles
   * a background window: once 47 minutes passed without a round.
   */
  const latest = useRef(now)
  useEffect(() => {
    latest.current = now
  })
  // Opening the vault runs a round of its own. Left to focus, which can come before
  // the vault loads, one launch synced after four seconds and the next not at all.
  useEffect(() => {
    if (vaultPath) void latest.current()
  }, [vaultPath])
  useEffect(() => {
    if (!vaultPath) return
    const timer = setInterval(() => void latest.current(), everySeconds * SECOND_MS)
    return () => clearInterval(timer)
  }, [vaultPath, everySeconds])
  useWindowEvent('focus', () => void now())
  useWindowEvent('blur', () => void now())

  /**
   * A setting written to the repository or the keychain: said if
   * it fails, and the status read back either way.
   */
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
    // The remote is read fresh, not from `status`: Back up saves the address
    // and the token in one press, and the state had not caught up, so the
    // token was not stored and the round said Synced with nothing pushed.
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
 * The one sentence the sync says, shown in the Applications row
 * and at the top of Settings → Sync.
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

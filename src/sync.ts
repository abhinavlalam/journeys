// The vault's sync, as the shell sees it: eight `invoke`s of eight app commands, in
// their own file for the reason `reveal.ts` and `calendarFeed.ts` are — a test that
// wants this seam mocks one module rather than a repository. `sync.rs` is the whole
// of what knows git.

import { invoke } from '@tauri-apps/api/core'

export interface SyncStatus {
  isRepo: boolean
  /** The repository's address, or null when the vault has none. */
  remote: string | null
  /** The identity the vault's commits carry — this repository's own, never the
   *  machine's global one. Empty until set. */
  name: string
  email: string
  /** Files changed since the last commit. */
  dirty: number
  ahead: number
  behind: number
  /** Unix seconds of the last commit. */
  lastCommit: number | null
  /** A token for the remote is in the keychain. */
  hasToken: boolean
}

export interface Pulled {
  /** Vault-relative paths the pull changed on disk, `(other)` copies included. */
  changed: string[]
  /** Files both sides changed, whose other version was kept beside them. */
  conflicts: string[]
}

export function syncStatus(vault: string): Promise<SyncStatus> {
  return invoke('sync_status', { vault })
}

/** Makes the folder a repository if it is not one, sets the identity its commits
 *  carry, and points it at `remote` (or at nothing). */
export function syncConfigure(vault: string, remote: string | null, name: string, email: string): Promise<void> {
  return invoke('sync_configure', { vault, remote, name, email })
}

/** Commits everything that changed; answers whether anything had. Refuses, with
 *  the count, a deletion of more than half the vault unless `allowMassDeletion`:
 *  a round on its own never carries one, the Sync now button does. */
export function syncCommit(vault: string, allowMassDeletion: boolean): Promise<boolean> {
  return invoke('sync_commit', { vault, allowMassDeletion })
}

export function syncPush(vault: string): Promise<void> {
  return invoke('sync_push', { vault })
}

export function syncPull(vault: string): Promise<Pulled> {
  return invoke('sync_pull', { vault })
}

/** Downloads the repository at `url` into the folder `into`, which it makes. */
export function syncClone(url: string, into: string): Promise<void> {
  return invoke('sync_clone', { url, into })
}

/** Into the keychain, keyed by the remote; never into a file of the vault's. */
export function syncSetToken(remote: string, token: string): Promise<void> {
  return invoke('sync_set_token', { remote, token })
}

export function syncForgetToken(remote: string): Promise<void> {
  return invoke('sync_forget_token', { remote })
}

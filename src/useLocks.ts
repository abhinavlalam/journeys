import { useEffect, useState } from 'react'
import { lock, lockAll, passphraseFor, unlockedPaths } from './crypto'
import type { InlineUnlock } from './FolderTree'
import { useAutoLock } from './useAutoLock'
import { unlockFile } from './vault'
import { isEncrypted, type VaultFile } from './vaultModel'

/**
 * Locked notes as the app sees them: asking for the passphrase under a
 * note's row, and locking again by hand, after `minutes` unused, and on
 * a vault change. The format and the held passphrases are `crypto.ts`'s.
 */
export function useLocks({
  vaultPath,
  minutes,
  front,
  onAsk,
  onOpen,
  onLocked,
  flush,
  setError,
}: {
  vaultPath: string | null
  minutes: number
  /** The note in the focused pane: using it keeps it unlocked. */
  front: string | null
  /** The question opens, so the other fields close. */
  onAsk: () => void
  onOpen: (file: VaultFile) => Promise<void>
  /**
   * Closes what shows these notes: their tabs, and the vault read's copy of their text.
   */
  onLocked: (paths: readonly string[]) => void
  flush: () => Promise<void>
  setError: (message: string | null) => void
}) {
  /**
   * The note waiting on a passphrase, and what is typed. The
   * passphrase never leaves this hook and `crypto.ts`.
   */
  const [unlocking, setUnlocking] = useState<VaultFile | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const close = () => {
    setUnlocking(null)
    setPassphrase('')
  }

  // Another vault locks everything: passphrases are held by
  // path, and paths belong to one vault.
  useEffect(() => {
    close()
    lockAll()
  }, [vaultPath])

  /**
   * Whether opening `file` must wait for its passphrase; if so, it asks.
   * `openNote` calls this first, since every row, hit, backlink and link
   * opens through it, and a locked file must not reach a buffer.
   */
  function asks(file: VaultFile): boolean {
    if (!isEncrypted(file.path) || passphraseFor(file.path) !== null) return false
    onAsk()
    setPassphrase('')
    setUnlocking(file)
    return true
  }

  async function submit() {
    const file = unlocking
    if (!file) return
    try {
      await unlockFile(file, passphrase)
    } catch (err) {
      // The field stays open for a retry. `unlockFile`'s two errors
      // say whether the passphrase was wrong or the file is damaged.
      setError(err instanceof Error ? err.message : String(err))
      setPassphrase('')
      return
    }
    setError(null)
    close()
    await onOpen(file)
  }

  /**
   * Locking forgets the passphrase and closes what shows the note. Queued typing
   * is written first, sealed, while there is still a key to seal it with.
   */
  async function lockNotes(paths: readonly string[]) {
    // Not while typing could not be saved: locking closes its tab. The save said why.
    if (!(await flush().then(() => true, () => false))) return
    onLocked(paths)
    paths.forEach(lock)
  }

  useAutoLock({ minutes, front, unlocked: unlockedPaths, onLock: (paths) => void lockNotes(paths) })

  const unlock: InlineUnlock | null = unlocking && {
    path: unlocking.path,
    name: unlocking.name,
    value: passphrase,
    onChange: setPassphrase,
    onSubmit: () => void submit(),
    onCancel: close,
  }

  return { unlock, asks, lockNotes }
}

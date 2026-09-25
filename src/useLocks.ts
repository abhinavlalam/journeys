import { useEffect, useState } from 'react'
import { lock, lockAll, passphraseFor, unlockedPaths } from './crypto'
import type { InlineUnlock } from './FolderTree'
import { useAutoLock } from './useAutoLock'
import { unlockFile } from './vault'
import { isEncrypted, type VaultFile } from './vaultModel'

/**
 * **Locked notes, as the shell sees them**: the passphrase question under a note's
 * row, and locking again — by hand, once unused for `minutes`, and on a vault
 * change. The format and the passphrases held are `crypto.ts`'s; this is the
 * asking and the forgetting.
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
  /** The note in the focused pane: using it is what keeps it unlocked. */
  front: string | null
  /** The question opens: the other fields shut, one box at a time. */
  onAsk: () => void
  onOpen: (file: VaultFile) => Promise<void>
  /** What shows these notes goes: their tabs, the corpus's copy of their text. */
  onLocked: (paths: readonly string[]) => void
  flush: () => Promise<void>
  setError: (message: string | null) => void
}) {
  /** The note waiting on a passphrase, and what has been typed. The passphrase
      never leaves this hook and `crypto.ts` — nothing writes it down. */
  const [unlocking, setUnlocking] = useState<VaultFile | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const close = () => {
    setUnlocking(null)
    setPassphrase('')
  }

  // **Another vault locks everything.** A passphrase is held for a path, and paths
  // belong to the vault they were read from; the derived keys go with it.
  useEffect(() => {
    close()
    lockAll()
  }, [vaultPath])

  /**
   * Whether opening `file` has to wait on its passphrase — and if so, the question
   * is asked. `openNote` asks this first because it is the one funnel every row,
   * hit, backlink and link goes through, and a locked file must not reach a buffer:
   * a read of one throws rather than handing back bytes.
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
      // The field stays open: a wrong passphrase is worth retyping, and the two
      // errors `unlockFile` throws say which of those this is.
      setError(err instanceof Error ? err.message : String(err))
      setPassphrase('')
      return
    }
    setError(null)
    close()
    await onOpen(file)
  }

  /**
   * **Locking a note is forgetting its passphrase and closing what shows it.** Its
   * queued typing goes out first, sealed — after the passphrase is gone there is
   * nothing to seal it with.
   */
  async function lockNotes(paths: readonly string[]) {
    await flush()
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

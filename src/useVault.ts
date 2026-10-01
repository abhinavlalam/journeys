import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { readVault } from './vault'
import type { VaultFolder } from './vaultModel'

const LAST_VAULT_KEY = 'journeys:vault'

/**
 * What the vault must be able to do to the open note, passed in because
 * `useNoteBuffer` needs the vault path and is declared after this.
 */
export interface VaultBufferOps {
  /** Write any queued edit before an operation moves its file. */
  flush: () => Promise<void>
  /** Empty the editor: the vault under it is being replaced. */
  close: () => void
}

/** The chosen folder and its tree, and the one way anything changes what is on disk. */
export function useVault(buffer: RefObject<VaultBufferOps>, setError: (m: string | null) => void) {
  const [vaultPath, setVaultPath] = useState<string | null>(null)
  const [root, setRoot] = useState<VaultFolder | null>(null)

  async function refresh(path: string): Promise<VaultFolder | null> {
    try {
      const walked = await readVault(path)
      setRoot(walked)
      return walked
    } catch (err) {
      setError(`The folder could not be read: ${String(err)}`)
      return null
    }
  }

  async function loadVault(folder: string) {
    setError(null)
    setVaultPath(folder)
    localStorage.setItem(LAST_VAULT_KEY, folder)
    buffer.current.close()
    await refresh(folder)
  }

  async function pickVault() {
    const folder = await open({ directory: true, multiple: false })
    if (typeof folder === 'string') await loadVault(folder)
  }

  // Reopen the last folder on launch. An effect, so `buffer` is set by then.
  useEffect(() => {
    const last = localStorage.getItem(LAST_VAULT_KEY)
    if (last) void loadVault(last)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Everything that writes to disk goes through here: it flushes the
   * queued save, reads the tree again after, and reports errors.
   *
   * The flush matters because the queued save holds the file's old path; a
   * rename during the wait would write to a path that no longer exists.
   * Deletes drop the save instead, since flushing would bring the file back.
   *
   * `after` gets the tree the operation produced. `renameFolder` returns
   * the folder with its new path but its children's old ones, so
   * anything that walks into the result reads the folder from this tree.
   */
  async function mutate<T>(
    op: (vault: string) => Promise<T>,
    after?: (result: T, root: VaultFolder | null) => unknown
  ) {
    if (!vaultPath) return
    setError(null)
    // A note that could not be saved has said so, and its queued typing
    // follows a move or is dropped by a delete; the operation goes on.
    await buffer.current.flush().catch(() => {})
    try {
      const result = await op(vaultPath)
      const walked = await refresh(vaultPath)
      await after?.(result, walked)
    } catch (err) {
      setError(String(err))
    }
  }

  return { vaultPath, root, refresh, loadVault, pickVault, mutate }
}

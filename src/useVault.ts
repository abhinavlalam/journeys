import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { readVault } from './vault'
import type { VaultFolder } from './vaultModel'

const LAST_VAULT_KEY = 'journeys:vault'

/**
 * The two things the vault has to be able to do to the open note, handed in by the
 * caller because `useNoteBuffer` needs the vault path and so is declared second.
 */
export interface VaultBufferOps {
  /** Write any queued edit before an op moves the file it names. */
  flush: () => Promise<void>
  /** Empty the editor: the vault under it is being replaced. */
  close: () => void
}

/**
 * The chosen folder and the tree walked from it, plus the one door through which
 * anything is allowed to change what is on disk.
 */
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

  // Reopen the last folder on launch. An effect, so `buffer` is already filled in
  // by the render that declared it.
  useEffect(() => {
    const last = localStorage.getItem(LAST_VAULT_KEY)
    if (last) void loadVault(last)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Anything that puts a file on disk goes through here: it flushes the queued
   * write first, re-reads the tree afterwards, and reports the error.
   *
   * The flush matters because the debounced write closes over the file's *old*
   * `absolutePath` — a rename inside the debounce window would fire afterwards and
   * write to a path that no longer exists, resurrecting a stale duplicate. Delete
   * paths discard instead, because flushing there recreates what was just deleted.
   *
   * **`after` is handed the tree the op produced**, because the op's own answer is
   * not it: `renameFolder` returns `{...folder, path, name}`, whose children still
   * carry the paths they had before the move. Anything that walks *into* the result
   * — rewriting a `path:` under it, following the links into it — has to read the
   * folder out of this instead.
   */
  async function mutate<T>(
    op: (vault: string) => Promise<T>,
    after?: (result: T, root: VaultFolder | null) => unknown
  ) {
    if (!vaultPath) return
    setError(null)
    await buffer.current.flush()
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

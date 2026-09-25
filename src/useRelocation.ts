import { confirm } from '@tauri-apps/plugin-dialog'
import {
  deleteFile,
  deleteFolder,
  moveFile,
  moveFolder,
  renameFile,
  renameFolder,
  retargetVaultLinks,
  writePathProperty,
} from './vault'
import { baseName, folderNoteRef, isSamePath } from './vaultModel'
import type { VaultFile, VaultFolder } from './vaultModel'
import { existingNotesIn, folderAt, pathKey } from './links'
import type { BufferSet } from './useBuffers'
import type { NoteMoves } from './links'
import type { useVault } from './useVault'
import type { useVaultTexts } from './useVaultTexts'

/** How many notes a message names before it counts the rest. */
const NAMED = 3

/**
 * The operations that change where a note is, and what each one drags along.
 *
 * **What a relocation *is*, said once**: the buffer follows the note it was
 * holding, the note's `path:` is rewritten to where it now is (see
 * `writePathProperty`), and every link that pointed at it is rewritten too. A move
 * and a rename differ only in the call that does the moving; a *folder* takes every
 * note under it along, so the whole subtree is rewritten — a lot of files for one
 * drag, and the price of the property being true. The write happens after
 * `mutate`'s refresh, so the tree it reads is the one the move produced.
 *
 * `notes` and `noteIndex` are the vault **as it was** when the handler was made —
 * which is what still resolves `[[Roadmap]]` once `Roadmap.md` has another name.
 */
export function useRelocation({
  vault,
  buffer,
  notes,
  noteIndex,
  setError,
  onMoved,
}: {
  vault: ReturnType<typeof useVault>
  /** Every open note's buffer, addressed as one. */
  buffer: BufferSet
  notes: ReturnType<typeof useVaultTexts>['notes']
  noteIndex: ReturnType<typeof useVaultTexts>['noteIndex']
  setError: (message: string | null) => void
  /** The workspace's half of a move: a tab follows the note it holds. */
  onMoved: {
    file: (was: string, moved: VaultFile) => void
    folder: (oldPrefix: string, newPrefix: string, moves: NoteMoves) => void
  }
}) {
  /** A note that could not be read kept its old links, and that is worth saying —
   *  see `retargetVaultLinks` for the one case it stays quiet about. */
  async function followLinks(moves: Map<string, VaultFile>) {
    const unreadable = await retargetVaultLinks(notes, moves, noteIndex).catch((err: unknown) => {
      setError(String(err))
      return []
    })
    /**
     * **Which note, by name**, because a count alone is a fact with nothing to do
     * about it — asked, in as many words, *"what happened?"*. An **encrypted** note
     * is not in this list at all: it was reported on every rename, which is a banner
     * about a permanent condition (*"that's an unnecessary callout"*), and nothing
     * writes into one anyway. What reaches here is a note that is there and still
     * could not be read.
     */
    if (unreadable.length > 0) {
      const names = unreadable.slice(0, NAMED).join(', ')
      const rest = unreadable.length > NAMED ? `, and ${unreadable.length - NAMED} more` : ''
      setError(`Links in ${names}${rest} were left as they were: they could not be read.`)
    }
  }

  /**
   * Where each note under a renamed or moved folder used to be.
   *
   * A prefix swap, and the folder's **own note** is the exception: its name changed
   * with the folder's, so `Plans/Plans.md` became `Roadmaps/Roadmaps.md` and no
   * prefix swap finds it. Matched **by name** — `<folder>/<folder>.md` — which is
   * the pairing `renameFolder` itself moves the note by, rather than by the walk's
   * `note` field, which is not always filled in on the folder handed back.
   */
  function folderMoves(was: string, now: VaultFolder): Map<string, VaultFile> {
    const wasName = baseName(was)
    const moves = new Map<string, VaultFile>()
    for (const file of existingNotesIn(now)) {
      const own = isSamePath(file.path, `${now.path}/${now.name}.md`)
      const wasPath = own ? `${was}/${wasName}.md` : `${was}${file.path.slice(now.path.length)}`
      moves.set(pathKey(wasPath), file)
    }
    // The folder's own note **whether or not it is on disk**: browsing a folder
    // leaves it unwritten (CLAUDE.md), and the editor may be holding exactly that.
    moves.set(pathKey(`${was}/${wasName}.md`), folderNoteRef(now))
    return moves
  }

  const relocateFile = (was: string) => async (now: VaultFile) => {
    buffer.followFile(was, now)
    onMoved.file(was, now)
    await writePathProperty([now])
    // The property just changed the open note's bytes, and the editor is holding
    // what they were before it — see `reread`.
    await buffer.reread(now)
    await followLinks(new Map([[pathKey(was), now]]))
  }

  const relocateFolder = (was: string) => async (now: VaultFolder, root: VaultFolder | null) => {
    // **The folder is read back out of the tree the move produced.** What the
    // operation hands back is `{...folder, path, name}` — accurate about the folder
    // and stale about everything under it — so a `path:` rewritten from those
    // children named where they used to be, and a link into one of them found no
    // move to follow.
    const moved = folderAt(root, now.path) ?? now
    const moves = folderMoves(was, moved)
    // Before the writes: the buffer is holding one of these paths, and a folder
    // rename changed the folder note's own basename — see `followFolder`.
    buffer.followFolder(was, moved.path, moves)
    onMoved.folder(was, moved.path, moves)
    await writePathProperty(existingNotesIn(moved))
    await buffer.rereadAll()
    await followLinks(moves)
  }

  /**
   * Deleting, and the order that matters.
   *
   * The pending save is **discarded, not flushed**, and before the delete — so the
   * debounce cannot fire during it. `mutate` flushes, and writing a pending edit
   * would recreate the note just after deleting it. For a folder the discard is a
   * prefix match, so a queued edit to any note *inside* it goes too.
   */
  async function confirmAndDelete(
    message: string,
    paths: readonly string[],
    remove: () => Promise<void>
  ) {
    if (!(await confirm(message, { kind: 'warning' }))) return
    for (const path of paths) buffer.discardPendingSave(path)
    await vault.mutate(remove, () => paths.forEach((path) => buffer.closeIfDeleted(path)))
  }

  return {
    /** The after-half of a move, for a caller composing its own mutation — a note
     *  converted and something moved into it is one write, and the moved thing
     *  still needs following. Handed out rather than duplicated. */
    relocateFile,
    relocateFolder,
    moveFile: (file: VaultFile, to: string) =>
      vault.mutate((v) => moveFile(file, v, to), relocateFile(file.path)),
    moveFolder: (folder: VaultFolder, to: string) =>
      vault.mutate((v) => moveFolder(folder, v, to), relocateFolder(folder.path)),
    renameFile: (file: VaultFile, name: string) =>
      vault.mutate(() => renameFile(file, name), relocateFile(file.path)),
    renameFolder: (folder: VaultFolder, name: string) =>
      vault.mutate(() => renameFolder(folder, name), relocateFolder(folder.path)),
    deleteFile: (file: VaultFile) =>
      confirmAndDelete(`Delete "${file.name}"? This can't be undone.`, [file.path], () =>
        deleteFile(file)
      ),
    /**
     * Every note picked in the left pane, behind **one** question — which is the
     * whole point of picking a set. Serial rather than together: a failure part way
     * through leaves a state that can be read off the tree, where twenty writes in
     * flight leave one that cannot.
     */
    deleteFiles: (files: readonly VaultFile[]) =>
      confirmAndDelete(
        `Delete ${files.length} notes? This can't be undone.`,
        files.map((file) => file.path),
        async () => {
          for (const file of files) await deleteFile(file)
        }
      ),
    deleteFolder: (folder: VaultFolder) =>
      confirmAndDelete(
        `Delete "${folder.name}" and everything inside it? This can't be undone.`,
        [folder.path],
        () => deleteFolder(folder)
      ),
  }
}

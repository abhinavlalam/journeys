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
 * The operations that change where a note is, and what each one carries along.
 *
 * A relocation means: the buffer follows its note, the note's `path::` is
 * rewritten (`writePathProperty`), and every link to it is rewritten. A
 * move and a rename differ only in the call. A folder takes every note
 * under it, so the whole subtree is rewritten. The writes happen after
 * `mutate`'s refresh, so they read the tree the move produced.
 *
 * `notes` and `noteIndex` are the vault as it was, which is what
 * still resolves `[[Roadmap]]` after `Roadmap.md` is renamed.
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
  /** Every open note's buffer. */
  buffer: BufferSet
  notes: ReturnType<typeof useVaultTexts>['notes']
  noteIndex: ReturnType<typeof useVaultTexts>['noteIndex']
  setError: (message: string | null) => void
  /** The workspace's part of a move: a tab follows its note. */
  onMoved: {
    file: (was: string, moved: VaultFile) => void
    folder: (oldPrefix: string, newPrefix: string, moves: NoteMoves) => void
  }
}) {
  /**
   * Notes that exist but could not be read, left as they were (`path::`
   * not rewritten, links not followed). Named, since a count alone
   * gives nothing to act on. Locked notes are never listed: nothing
   * writes into them, and naming them on every rename was noise.
   */
  function sayUnread(paths: readonly string[]) {
    const unread = [...new Set(paths)]
    if (unread.length === 0) return
    const names = unread.slice(0, NAMED).join(', ')
    const rest = unread.length > NAMED ? `, and ${unread.length - NAMED} more` : ''
    setError(`${names}${rest} could not be read, so nothing in ${unread.length === 1 ? 'it' : 'them'} was changed.`)
  }

  /**
   * See `retargetVaultLinks` for what it does not report. `unread`
   * is what the `path::` half of the same move could not read.
   */
  async function followLinks(moves: Map<string, VaultFile>, unread: readonly string[]) {
    const skipped = await retargetVaultLinks(notes, moves, noteIndex).catch((err: unknown) => {
      setError(String(err))
      return []
    })
    sayUnread([...unread, ...skipped])
  }

  /**
   * Where each note under a renamed or moved folder used to be. A
   * prefix swap, except the folder's own note, whose name changed too
   * (`Plans/Plans.md` became `Roadmaps/Roadmaps.md`). It is matched
   * by name, `<folder>/<folder>.md`, as `renameFolder` moves it.
   */
  function folderMoves(was: string, now: VaultFolder): Map<string, VaultFile> {
    const wasName = baseName(was)
    const moves = new Map<string, VaultFile>()
    for (const file of existingNotesIn(now)) {
      const own = isSamePath(file.path, `${now.path}/${now.name}.md`)
      const wasPath = own ? `${was}/${wasName}.md` : `${was}${file.path.slice(now.path.length)}`
      moves.set(pathKey(wasPath), file)
    }
    // The folder's own note, on disk or not: browsing a folder
    // does not write it, and the editor may hold it.
    moves.set(pathKey(`${was}/${wasName}.md`), folderNoteRef(now))
    return moves
  }

  const relocateFile = (was: string) => async (now: VaultFile) => {
    buffer.followFile(was, now)
    onMoved.file(was, now)
    const unread = await writePathProperty([now])
    // The property changed the open note's bytes, and the editor
    // holds the old text; see `reread`.
    await buffer.reread(now)
    await followLinks(new Map([[pathKey(was), now]]), unread)
  }

  const relocateFolder = (was: string) => async (now: VaultFolder, root: VaultFolder | null) => {
    // Read the folder back from the tree the move produced. The
    // operation returns the folder with new paths but its
    // children's old ones, so rewrites from those named old places.
    const moved = folderAt(root, now.path) ?? now
    const moves = folderMoves(was, moved)
    // Before the writes: the buffer may hold one of these paths, and a
    // folder rename changes its own note's name; see `followFolder`.
    buffer.followFolder(was, moved.path, moves)
    onMoved.folder(was, moved.path, moves)
    const unread = await writePathProperty(existingNotesIn(moved))
    await buffer.rereadAll()
    await followLinks(moves, unread)
  }

  /**
   * Deleting. The pending save is dropped, not written, and before the delete,
   * so it cannot fire during it; `mutate` flushes, and writing it would bring
   * the note back. For a folder, every queued save inside it is dropped.
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
    /**
     * The second half of a move, for a caller making its own
     * change: a note converted and something moved into it is
     * one write, and the moved thing still needs following.
     */
    relocateFile,
    relocateFolder,
    /** For the other writers of `path::`: a new note, a converted note. */
    sayUnread,
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
     * Every picked note behind one question. One after another, not together: a failure
     * part way leaves a state the tree shows, where twenty writes at once do not.
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

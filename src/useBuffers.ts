import { useRef } from 'react'
import type { VaultFile } from './vaultModel'
import type { NoteMoves } from './links'

/**
 * What one open note's buffer can be asked to do from outside:
 * `useNoteBuffer`'s operations, without the render state.
 */
interface NoteBufferOps {
  flushPendingSave: () => Promise<void>
  discardPendingSave: (pathOrPrefix: string) => void
  followFile: (was: string, moved: VaultFile) => void
  followFolder: (oldPrefix: string, newPrefix: string, moves: NoteMoves) => void
  reread: (file: VaultFile | null, ours?: boolean) => Promise<void>
  /** The note this buffer holds, for `rereadAll`. */
  note: VaultFile | null
}

/**
 * Every open note's buffer, reached as one. Each note tab's `NotePane` owns
 * its buffer, so the buffer lives as long as the tab. Every vault operation
 * (move, rename, delete, a property written into an open note) must reach
 * every buffer, and this is the one way: each pane registers under its tab's
 * id, and the calls go to all of them. Each buffer ignores what is not about
 * its note (`followFile` checks the path, `reread` checks `loadedPath`).
 *
 * `onDeleted` is the tabs' part of a delete: buffers drop their
 * queued writes and the workspace closes the tabs, in one call.
 */
export function useBuffers({ onDeleted }: { onDeleted: (prefix: string) => void }) {
  const registry = useRef(new Map<number, NoteBufferOps>())
  const all = () => [...registry.current.values()]

  return {
    register: (id: number, ops: NoteBufferOps) => {
      registry.current.set(id, ops)
    },
    unregister: (id: number) => {
      registry.current.delete(id)
    },
    flushPendingSave: async () => {
      await Promise.all(all().map((buffer) => buffer.flushPendingSave()))
    },
    discardPendingSave: (pathOrPrefix: string) =>
      all().forEach((buffer) => buffer.discardPendingSave(pathOrPrefix)),
    followFile: (was: string, moved: VaultFile) => all().forEach((buffer) => buffer.followFile(was, moved)),
    followFolder: (oldPrefix: string, newPrefix: string, moves: NoteMoves) =>
      all().forEach((buffer) => buffer.followFolder(oldPrefix, newPrefix, moves)),
    reread: async (file: VaultFile | null, ours?: boolean) => {
      await Promise.all(all().map((buffer) => buffer.reread(file, ours)))
    },
    /**
     * Every buffer re-reads its note from disk, after a folder
     * move rewrote `path::` in each note under it.
     */
    rereadAll: async () => {
      await Promise.all(all().map((buffer) => buffer.reread(buffer.note)))
    },
    closeIfDeleted: (prefix: string) => {
      all().forEach((buffer) => buffer.discardPendingSave(prefix))
      onDeleted(prefix)
    },
  }
}

export type BufferSet = ReturnType<typeof useBuffers>

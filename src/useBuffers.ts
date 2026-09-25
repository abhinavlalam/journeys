import { useRef } from 'react'
import type { VaultFile } from './vaultModel'
import type { NoteMoves } from './links'

/** What one open note's buffer can be asked to do from outside — the operations
 *  `useNoteBuffer` returns, less the render state. */
interface NoteBufferOps {
  flushPendingSave: () => Promise<void>
  discardPendingSave: (pathOrPrefix: string) => void
  followFile: (was: string, moved: VaultFile) => void
  followFolder: (oldPrefix: string, newPrefix: string, moves: NoteMoves) => void
  reread: (file: VaultFile | null) => Promise<void>
  /** The note this buffer holds, for `rereadAll`. */
  note: VaultFile | null
}

/**
 * Every open note's buffer, addressed as one.
 *
 * There was one buffer, because there was one note open; with tabs there is one per
 * note tab, owned by the `NotePane` that draws it — a hook per mounted pane, which
 * is the only way a buffer's lifetime can be the tab's. Anything that acts on the
 * vault — a move, a rename, a delete, a property written into an open note — has to
 * reach every buffer, and this is the one door: each pane registers its operations
 * under its tab's id, and the aggregate calls all of them. Each buffer already
 * declines what is not about its own note (`followFile` compares the path,
 * `reread` checks `loadedPath`), so broadcasting is correct rather than merely
 * convenient.
 *
 * `onDeleted` is the tabs' half of a delete: the buffers drop their queued writes
 * and the workspace closes the tabs, and the two happen from one call.
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
    reread: async (file: VaultFile | null) => {
      await Promise.all(all().map((buffer) => buffer.reread(file)))
    },
    /** Every buffer takes up its own note from disk — after a folder moved and the
     *  app rewrote a `path:` into each note under it. */
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

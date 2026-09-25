import { useRef, useState } from 'react'
import { fileExists, readVaultFile, writeVaultFile } from './vault'
import { useWindowEvent } from './useWindowEvent'
import type { VaultFile, VaultFolder } from './vaultModel'
import { pathKey } from './links'
import type { NoteMoves } from './links'

/** How long typing has to stop before the note is written. */
const AUTOSAVE_MS = 800

type SaveStatus = 'idle' | 'saving' | 'saved'

/**
 * What a read of the open note produced. `{ failed: true }` is **not** the same as
 * empty text: the file's real bytes are still on disk, and mounting an empty
 * editable document over them means one keystroke autosaves the blank one on top.
 */
type NoteRead = { body: string } | { failed: true }

interface NoteBufferDeps {
  /** The vault the open note lives in. Null before one is picked. */
  vaultPath: string | null
  /** Re-reads the tree — a folder note written for the first time changes its shape. */
  refresh: (path: string) => Promise<VaultFolder | null>
  setError: (message: string | null) => void
}

/**
 * The open note, the text the editor holds for it, and every path that writes it.
 *
 * The boundary exists for `applyNoteBody`, which is module-private here: it is the
 * only mutator of that buffer, so "only" is a property of the program rather than
 * a request to future callers. The refs that guard the async windows around it —
 * `bufferGeneration`, `loadedPath`, `openNoteExists`, the save queue — are private
 * for the same reason. What leaves this file is the state the render needs plus the
 * handful of operations that are allowed to move the buffer.
 */
export function useNoteBuffer({ vaultPath, refresh, setError }: NoteBufferDeps) {
  const [note, setNote] = useState<VaultFile | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')

  // The editor takes `initialMarkdown` at mount only and is keyed on the note's
  // path, so `body` is the *mount* value and never a per-keystroke one.
  const [body, setBody] = useState('')
  // Bumped by every replacement of the buffer from outside the editor. Without it a
  // re-read updated React state the mounted editor never rendered, and the next
  // keystroke saved the stale text back over what had changed on disk.
  const [editorEpoch, setEditorEpoch] = useState(0)
  // The note the editor is refusing to mount over, because its text could not be
  // read. Compared against the open note's path, so switching clears it.
  const [unreadablePath, setUnreadablePath] = useState<string | null>(null)

  /** Mirror of `body` for the focus check, which runs outside React's render flow. */
  const bodyRef = useRef('')
  /**
   * Bumped by every replacement of that buffer. A disk re-read spans two awaits,
   * and anything that swaps the editor to another note inside them invalidates the
   * bytes in flight: `bodyRef` then holds the *other* note's text, so the "did the
   * disk change" comparison differs whatever the disk says, and note A's text is
   * applied over note B for the next keystroke to save into B.
   */
  const bufferGeneration = useRef(0)
  /** Which note the editor's text belongs to. Null when it belongs to none. */
  const loadedPath = useRef<string | null>(null)
  /**
   * Whether the open note is on disk yet. A folder note is written lazily, so
   * "empty and never written" must not create a blank file just for clicking a
   * folder — which is why the flag exists and the emptiness of the text does not
   * stand in for it.
   */
  const openNoteExists = useRef(false)

  const pendingSave = useRef<{ file: VaultFile; raw: string } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * The write currently inside `writeNote`, which is not the same as one still
   * queued: both the timer and the flush clear `pendingSave` *before* awaiting the
   * write. So a second caller saw nothing pending and walked straight past a save
   * in flight — a flush that does not flush, ahead of a read of the same file.
   */
  const inFlightSave = useRef<Promise<void> | null>(null)

  // -------------------------------------------------------------------------
  // Reading and writing the open note
  // -------------------------------------------------------------------------

  async function readNoteBody(file: VaultFile): Promise<NoteRead> {
    try {
      // A folder note that has never been edited has no file behind it yet.
      if (!(await fileExists(file))) return { body: '' }
      // The **whole** file, frontmatter included. It used to be held aside, because
      // the editor before this one could not render a block like that without
      // mangling it. This one is a text editor and the document is the file's own
      // text, and hiding the top of it made a property the app itself writes
      // invisible in the app: an icon was in the note and could not be seen.
      return { body: await readVaultFile(file) }
    } catch (err) {
      // Deleted underneath us. The delete already closes the note, and a focus
      // re-read can race it — an error naming a note that no longer exists
      // outlives the note and cannot be acted on.
      if (/no such file|os error 2|ENOENT/i.test(String(err))) return { failed: true }
      setError(`Could not read ${file.path}: ${String(err)}`)
      return { failed: true }
    }
  }

  /**
   * The **only** mutator of the editor's buffer, and it moves `loadedPath` with it.
   *
   * The path is a parameter rather than the caller's own line because those two
   * came apart repeatedly: a path left behind silently ends the external-edit
   * pickup below, which is what stops the app overwriting a note edited elsewhere.
   */
  function applyNoteBody(loaded: NoteRead, path: string | null) {
    const failed = 'failed' in loaded
    // A read that failed leaves nothing holding this note's text, so the ref must
    // not claim it does.
    loadedPath.current = failed ? null : path
    setUnreadablePath(failed ? path : null)
    bufferGeneration.current += 1
    setEditorEpoch((n) => n + 1)
    bodyRef.current = failed ? '' : loaded.body
    setBody(failed ? '' : loaded.body)
    setSaveStatus('idle')
  }

  async function openNote(file: VaultFile) {
    await flushPendingSave()
    // Read *before* switching, or the editor remounts holding the previous note's
    // text and autosave writes that into the new file. This corrupted a file.
    const loaded = await readNoteBody(file)
    openNoteExists.current = !('failed' in loaded) && (await fileExists(file))
    setNote(file)
    applyNoteBody(loaded, file.path)
  }

  /**
   * Take up what is on disk for a note **the app itself just wrote to**.
   *
   * A rename writes a `path:` property into the note it moved, and the editor went
   * on holding the text from before that — so the next keystroke saved the old text
   * back and the property vanished. Reported as "a line appears above the title and
   * goes away when I leave and come back": the block arriving on disk, then being
   * overwritten by a buffer that never heard about it.
   *
   * **Only when nothing is queued.** A pending save is the user's own typing and
   * outranks a property the app added; replacing the buffer under it would throw
   * away characters, which is worse than losing a `path:` the next move rewrites.
   */
  async function reread(file: VaultFile | null) {
    if (!file || pendingSave.current || loadedPath.current !== file.path) return
    applyNoteBody(await readNoteBody(file), file.path)
  }

  /**
   * **The editor is leaving, the buffer is staying.** A tab that is no longer the
   * active one unmounts its editor and keeps its buffer, so the text the editor
   * held has to become the mount value the editor comes back to — `body` is the
   * mount value and never the keystroke. The queued write goes out as well: a tab
   * out of sight is not a reason for its edit to sit in a timer.
   */
  function settle() {
    void flushPendingSave()
    if (bodyRef.current !== body) {
      setBody(bodyRef.current)
      setEditorEpoch((n) => n + 1)
    }
  }

  /** Nothing open, nothing held: for a delete, and for changing vault. */
  function closeNote() {
    setNote(null)
    applyNoteBody({ body: '' }, null)
  }

  async function writeNote(file: VaultFile, raw: string) {
    const isNew = !openNoteExists.current
    await writeVaultFile(file, raw)
    openNoteExists.current = true
    setSaveStatus('saved')
    // A folder note written for the first time changes the tree's shape.
    if (isNew && vaultPath) await refresh(vaultPath)
  }

  /** Writes one queued edit now, and records it so a flush can await it. */
  function runSave(pending: { file: VaultFile; raw: string }): Promise<void> {
    const write = (async () => {
      try {
        await writeNote(pending.file, pending.raw)
      } catch {
        setError(`Could not save ${pending.file.path}.`)
      }
    })()
    inFlightSave.current = write
    void write.then(() => {
      if (inFlightSave.current === write) inFlightSave.current = null
    })
    return write
  }

  async function flushPendingSave() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const pending = pendingSave.current
    pendingSave.current = null
    // Awaited before the queued edit is written, not only when there is none: two
    // writes to one path running concurrently can land in either order, which
    // would leave the older text on disk.
    await inFlightSave.current
    if (!pending) return
    await runSave(pending)
  }

  /** Drops a queued save without writing it — for paths that delete the file. */
  function discardPendingSave(pathOrPrefix: string) {
    const pending = pendingSave.current
    if (!pending) return
    const path = pending.file.path
    if (path !== pathOrPrefix && !path.startsWith(`${pathOrPrefix}/`)) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    pendingSave.current = null
  }

  function handleEditorChange(markdown: string) {
    const file = note
    if (!file) return

    // A folder note that has never been written stays unwritten until it has real
    // content, or opening a folder would create a blank file.
    if (!openNoteExists.current && markdown.trim() === '') {
      setSaveStatus('idle')
      return
    }

    setSaveStatus('saving')
    bodyRef.current = markdown
    // The frontmatter the editor never showed, put back in front of the body.
    // The document *is* the file now, so there is nothing to put back in front.
    const raw = markdown
    pendingSave.current = { file, raw }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      pendingSave.current = null
      // Through runSave, so a flush landing while this write is in flight awaits
      // it instead of reading the file back mid-write.
      void runSave({ file, raw })
    }, AUTOSAVE_MS)
  }

  // -------------------------------------------------------------------------
  // Catching up with the disk
  // -------------------------------------------------------------------------

  /**
   * Picks up an edit made outside the app — in Finder, by a sync, by an editor in
   * another window. Without it the buffer keeps a stale copy and the next autosave
   * silently overwrites whatever is now on disk. It lives here, with the buffer,
   * because applying that read is `applyNoteBody`'s business and nobody else's.
   *
   * There is no filesystem watcher: this runs on window focus. **Last-writer-wins
   * by design** — our pending save is flushed *before* the read, so with an edit of
   * our own in flight our text wins the collision. The alternative silently drops
   * the user's typing; the cost is that there is no "keep yours / take theirs".
   */
  async function syncWithDisk() {
    if (!vaultPath) return
    const file = note
    if (file && file.path === loadedPath.current) {
      const generation = bufferGeneration.current
      await flushPendingSave()
      const loaded = await readNoteBody(file)
      // The awaits above are a window in which the editor can be pointed at
      // another note; applying this read past that point writes A's text into B.
      const stillOurs =
        bufferGeneration.current === generation && loadedPath.current === file.path
      if (stillOurs && !('failed' in loaded) && loaded.body !== bodyRef.current) {
        applyNoteBody(loaded, file.path)
      }
    }
    await refresh(vaultPath)
  }

  useWindowEvent('focus', () => void syncWithDisk())

  // -------------------------------------------------------------------------
  // Following the tree
  // -------------------------------------------------------------------------

  /** After a rename or move, the editor's text belongs to the note's new path. */
  function followFile(oldPath: string, moved: VaultFile) {
    if (loadedPath.current === oldPath) loadedPath.current = moved.path
    // **A queued save is the third thing holding a path**, and it has to move with
    // the other two. It did not, and the write went to where the note used to be:
    // type in a note, press `+` to give it a child, and `convertToNested` moved the
    // file while a save sat queued for the old path. Measured before the fix —
    // `roadmap/roadmap.md` holding the text from *before* the typing, and a stray
    // `roadmap.md` at the root holding the typing itself. Two notes of one name, and
    // the edit in the wrong one.
    if (pendingSave.current?.file.path === oldPath) {
      pendingSave.current = { ...pendingSave.current, file: moved }
    }
    setNote((current) => (current?.path === oldPath ? moved : current))
  }

  /**
   * After a folder rename or move, every path under it moved with it.
   *
   * **`moves` first, and that is the whole of why it is here.** A folder *rename*
   * changes its own note's basename too — `Plans/Plans.md` becomes
   * `Roadmaps/Roadmaps.md` — and a prefix swap answers `Roadmaps/Plans.md`, which
   * is not a file. The editor then held a path with the old name in it, and the
   * next keystroke autosaved *and created it*: an empty note named after the note
   * that had just been renamed. Reported exactly that way.
   *
   * The prefix swap stays as the fallback, for everything the map does not name —
   * a note under a *sub*folder, whose own basename did not change.
   */
  function followFolder(oldPrefix: string, newPrefix: string, moves: NoteMoves) {
    const swap = (path: string) =>
      path === oldPrefix || path.startsWith(`${oldPrefix}/`)
        ? newPrefix + path.slice(oldPrefix.length)
        : path
    if (loadedPath.current) {
      loadedPath.current = moves.get(pathKey(loadedPath.current))?.path ?? swap(loadedPath.current)
    }
    // The queued save too — see `followFile`.
    const queued = pendingSave.current
    if (queued) {
      const moved = moves.get(pathKey(queued.file.path))
      const path = moved?.path ?? swap(queued.file.path)
      if (path !== queued.file.path && vaultPath) {
        pendingSave.current = {
          ...queued,
          file: moved ?? { ...queued.file, path, absolutePath: `${vaultPath}/${path}` },
        }
      }
    }
    setNote((current) => {
      if (!current || !vaultPath) return current
      // **The map carries the file itself** — its path, its absolute path *and its
      // name* — which is what a rename changes and a swapped prefix cannot: the
      // title went on showing the old name, and the path it named was not a file.
      const moved = moves.get(pathKey(current.path))
      if (moved) return moved
      const path = swap(current.path)
      if (path === current.path) return current
      return { ...current, path, absolutePath: `${vaultPath}/${path}` }
    })
  }

  /** Closes the editor when the note it holds is deleted, or is inside what was. */
  function closeIfDeleted(prefix: string) {
    discardPendingSave(prefix)
    const path = note?.path
    if (!path) return
    if (path !== prefix && !path.startsWith(`${prefix}/`)) return
    closeNote()
  }

  return {
    note,
    body,
    editorEpoch,
    saveStatus,
    /** The open note is one whose bytes could not be read: mount no editor over it. */
    unreadable: note !== null && note.path === unreadablePath,
    openNote,
    closeNote,
    settle,
    handleEditorChange,
    flushPendingSave,
    discardPendingSave,
    followFile,
    reread,
    followFolder,
    closeIfDeleted,
  }
}

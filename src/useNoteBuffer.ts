import { useRef, useState } from 'react'
import { fileExists, keepOther, readVaultFile, writeVaultFile } from './vault'
import { useWindowEvent } from './useWindowEvent'
import { isWithin, movedWith, type VaultFile, type VaultFolder } from './vaultModel'
import { followedFile, pathKey } from './links'
import type { NoteMoves } from './links'

/** How long typing has to stop before the note is written. */
const AUTOSAVE_MS = 800

type SaveStatus = 'idle' | 'saving' | 'saved'

/**
 * What a read of the open note produced. `{ failed: true }` is
 * not empty text: the real file is still on disk, and an empty
 * editor over it would save the blank on the first keystroke.
 */
type NoteRead = { body: string } | { failed: true }

interface NoteBufferDeps {
  /** The vault the open note lives in. Null before one is picked. */
  vaultPath: string | null
  /** Reads the tree again: a folder note written for the first time changes it. */
  refresh: (path: string) => Promise<VaultFolder | null>
  setError: (message: string | null) => void
}

/**
 * The open note, the text the editor holds for it, and every path that
 * writes it. `applyNoteBody` is private here, so it really is the only
 * thing that changes the buffer; the refs guarding the async gaps around
 * it are private for the same reason. What leaves this file is the state
 * the render needs and the few operations allowed to move the buffer.
 */
export function useNoteBuffer({ vaultPath, refresh, setError }: NoteBufferDeps) {
  const [note, setNote] = useState<VaultFile | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')

  // The editor reads `initialMarkdown` only when it mounts and is keyed on
  // the note's path, so `body` is the mount value, not the text as typed.
  const [body, setBody] = useState('')
  // Bumped whenever the buffer is replaced from outside the editor.
  // Without it, a re-read updated state the mounted editor never
  // showed, and the next keystroke saved the stale text over the disk.
  const [editorEpoch, setEditorEpoch] = useState(0)
  /**
   * The note as last re-read from disk, for the editor already holding it, which
   * applies it as a change (`EditorHost`'s `incoming`). Null after a remount.
   */
  const [incoming, setIncoming] = useState<{ text: string; n: number } | null>(null)
  // The note the editor won't mount over, because its text couldn't be
  // read. Compared with the open note's path, so switching clears it.
  const [unreadablePath, setUnreadablePath] = useState<string | null>(null)

  /** A copy of `body` for the focus check, which runs outside React's render. */
  const bodyRef = useRef('')
  /**
   * Bumped whenever the buffer is replaced. A disk re-read spans
   * two awaits, and switching notes in between would apply note
   * A's text to note B; the generation check drops it.
   */
  const bufferGeneration = useRef(0)
  /** Which note the editor's text belongs to, or null. */
  const loadedPath = useRef<string | null>(null)
  /**
   * Whether the open note is on disk yet. Folder notes are written lazily, so an
   * empty, never-written note must not be created just by clicking the folder.
   */
  const openNoteExists = useRef(false)
  /**
   * The note's text as this buffer last read or wrote it: what a save may
   * write over. Anything else on disk belongs to someone else and is kept.
   */
  const seen = useRef<string | null>(null)

  const pendingSave = useRef<{ file: VaultFile; raw: string } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * The write currently in `writeNote`. Not the same as one queued:
   * the timer and the flush both clear `pendingSave` before
   * awaiting, so without this a flush could miss a write in flight.
   */
  const inFlightSave = useRef<Promise<void> | null>(null)

  // -------------------------------------------------------------------------
  // Reading and writing the open note
  // -------------------------------------------------------------------------

  async function readNoteBody(file: VaultFile): Promise<NoteRead> {
    try {
      // A folder note never edited has no file yet.
      if (!(await fileExists(file))) return { body: '' }
      // The whole file, frontmatter included: the document is the file's own
      // text, and hiding the top made the app's own properties invisible.
      return { body: await readVaultFile(file) }
    } catch (err) {
      // Deleted underneath us. The delete already closes the note, and
      // an error about a note that no longer exists can't be acted on.
      if (/no such file|os error 2|ENOENT/i.test(String(err))) return { failed: true }
      setError(`Could not read ${file.path}: ${String(err)}`)
      return { failed: true }
    }
  }

  /**
   * The only thing that changes the editor's buffer, and it moves
   * `loadedPath` with it. The path is a parameter because the two kept coming
   * apart, which silently stopped external edits from being picked up.
   */
  function applyNoteBody(loaded: NoteRead, path: string | null) {
    const failed = 'failed' in loaded
    // A failed read leaves nothing holding this note's text, so
    // the ref mustn't claim it does.
    loadedPath.current = failed ? null : path
    setUnreadablePath(failed ? path : null)
    bufferGeneration.current += 1
    setEditorEpoch((n) => n + 1)
    setIncoming(null)
    bodyRef.current = failed ? '' : loaded.body
    seen.current = failed ? null : loaded.body
    setBody(failed ? '' : loaded.body)
    setSaveStatus('idle')
  }

  /**
   * A re-read of the note the editor already holds, handed to it as a change, so
   * the caret, folds and undo stay. Rebuilt instead, the editor lost them after
   * every outside write, and keys pressed during the re-read went into an editor
   * about to be replaced. A note that could not be read is a remount, as on opening.
   */
  function takeFromDisk(loaded: NoteRead, path: string) {
    if ('failed' in loaded || loadedPath.current !== path || unreadablePath === path) return applyNoteBody(loaded, path)
    bufferGeneration.current += 1
    bodyRef.current = loaded.body
    seen.current = loaded.body
    setIncoming((was) => ({ text: loaded.body, n: (was?.n ?? 0) + 1 }))
    setSaveStatus('idle')
  }

  async function openNote(file: VaultFile) {
    // A save that failed keeps this buffer on its note, so the typing is not dropped.
    if (!(await saved())) return
    // Read before switching, or the editor remounts with the
    // previous note's text and autosave writes it into the new file.
    const loaded = await readNoteBody(file)
    openNoteExists.current = !('failed' in loaded) && (await fileExists(file))
    setNote(file)
    applyNoteBody(loaded, file.path)
  }

  /**
   * Takes up what is on disk for a note the app itself just wrote
   * to. A rename writes a `path::` into the note, and without
   * this the next keystroke saved the old text back over it.
   *
   * Only when no save is queued: queued typing outranks a property the app
   * added. The app's write still counts as seen, so the save goes over it
   * without a copy. `ours` is false for a pull: the other device's text isn't
   * seen, so a save during typing keeps it beside the note (`writeNote`).
   */
  async function reread(file: VaultFile | null, ours = true) {
    if (!file || loadedPath.current !== file.path) return
    const loaded = await readNoteBody(file)
    if (!pendingSave.current) takeFromDisk(loaded, file.path)
    else if (ours && !('failed' in loaded)) seen.current = loaded.body
  }

  /**
   * A save never writes over text it hasn't seen. Typing during a pull once
   * wrote the old text over the other device's edit, and the next sync pushed
   * it. Now text on disk that this buffer didn't read or write is kept beside
   * the note (`keepOther`) and reported, and then the typing is written.
   */
  async function writeNote(file: VaultFile, raw: string) {
    const isNew = !openNoteExists.current
    // A note deleted elsewhere has nothing on disk to keep, so the typing is written.
    if (!isNew && loadedPath.current === file.path && (await fileExists(file))) {
      const onDisk = await readVaultFile(file)
      if (seen.current !== null && onDisk !== seen.current && onDisk !== raw) {
        const other = await keepOther(file)
        setError(`${file.name} changed elsewhere while you typed. Yours is in the note; the other is beside it as ${other.name}.`)
      }
    }
    await writeVaultFile(file, raw)
    if (loadedPath.current === file.path) seen.current = raw
    openNoteExists.current = true
    setSaveStatus('saved')
    // A folder note written for the first time changes the tree.
    if (isNew && vaultPath) await refresh(vaultPath)
  }

  /**
   * Writes one queued edit now, and records it so a flush can wait for it. A
   * write that fails is said, queued again unless newer typing replaced it, and
   * thrown, so a quit stays and a lock waits instead of dropping the typing.
   */
  function runSave(pending: { file: VaultFile; raw: string }): Promise<void> {
    const write = (async () => {
      try {
        await writeNote(pending.file, pending.raw)
      } catch (err) {
        pendingSave.current ??= pending
        setError(`Could not save ${pending.file.path}: ${String(err)}`)
        throw err
      }
    })()
    inFlightSave.current = write
    const settled = () => {
      if (inFlightSave.current === write) inFlightSave.current = null
    }
    void write.then(settled, settled)
    return write
  }

  async function flushPendingSave() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    // Waited for first: two writes to one file at once can land in either order.
    // One that failed has queued its edit again, so it is tried once more below.
    await inFlightSave.current?.catch(() => {})
    const pending = pendingSave.current
    pendingSave.current = null
    if (!pending) return
    await runSave(pending)
  }

  /** Whether every queued edit is on disk. A failure has been said and stays queued. */
  const saved = () => flushPendingSave().then(() => true, () => false)

  /** Drops a queued save without writing it, for anything that deletes the file. */
  function discardPendingSave(pathOrPrefix: string) {
    if (!pendingSave.current || !isWithin(pendingSave.current.file.path, pathOrPrefix)) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    pendingSave.current = null
  }

  function handleEditorChange(markdown: string) {
    const file = note
    if (!file) return

    // A folder note never written stays unwritten until it has
    // content, or opening a folder would create a blank file.
    if (!openNoteExists.current && markdown.trim() === '') {
      setSaveStatus('idle')
      return
    }

    // The disk's own text, taken in from outside (`takeFromDisk`): nothing to write.
    if (markdown === seen.current && !pendingSave.current) {
      bodyRef.current = markdown
      return
    }

    setSaveStatus('saving')
    bodyRef.current = markdown
    pendingSave.current = { file, raw: markdown }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      pendingSave.current = null
      // Through `runSave`, so a flush during this write waits for it instead
      // of reading the file mid-write. A failure is said there and stays queued.
      runSave({ file, raw: markdown }).catch(() => {})
    }, AUTOSAVE_MS)
  }

  // -------------------------------------------------------------------------
  // Catching up with the disk
  // -------------------------------------------------------------------------

  /**
   * Picks up an edit made outside the app: in Finder, by a sync, or by another
   * editor. Without it, the next autosave would silently overwrite what is on
   * disk. Runs on window focus; there is no watcher. Pending typing is saved
   * first, so our text wins, and the other is kept beside the note (`writeNote`).
   */
  async function syncWithDisk() {
    if (!vaultPath) return
    const file = note
    const generation = bufferGeneration.current
    // After a failed save the disk is not read over the typing it holds.
    if ((await saved()) && file && file.path === loadedPath.current) {
      const loaded = await readNoteBody(file)
      // The editor can be switched to another note during the awaits
      // above; applying this read after that would write A's text into B.
      const stillOurs =
        bufferGeneration.current === generation && loadedPath.current === file.path
      // Not over keys pressed during the read: they are queued, and their save keeps
      // what is on disk beside the note if it changed (`writeNote`).
      if (stillOurs && !('failed' in loaded) && loaded.body !== bodyRef.current && !pendingSave.current) {
        takeFromDisk(loaded, file.path)
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
    // A queued save moves with the note too. It didn't once: typing in a
    // note and then giving it a child moved the file while a save waited
    // for the old path, leaving the typing in a stray file at the root.
    if (pendingSave.current?.file.path === oldPath) {
      pendingSave.current = { ...pendingSave.current, file: moved }
    }
    setNote((current) => (current?.path === oldPath ? moved : current))
  }

  /** After a folder rename or move, every path under it moves too (`followedFile`). */
  function followFolder(oldPrefix: string, newPrefix: string, moves: NoteMoves) {
    if (!vaultPath) return
    const follow = (file: VaultFile) => followedFile(file, oldPrefix, newPrefix, moves, vaultPath)
    if (loadedPath.current) {
      loadedPath.current = moves.get(pathKey(loadedPath.current))?.path ?? movedWith(loadedPath.current, oldPrefix, newPrefix)
    }
    // The queued save too (see `followFile`).
    if (pendingSave.current) pendingSave.current = { ...pendingSave.current, file: follow(pendingSave.current.file) }
    setNote((current) => current && follow(current))
  }

  return {
    note,
    body,
    editorEpoch,
    incoming,
    saveStatus,
    /** The open note's text couldn't be read: mount no editor over it. */
    unreadable: note !== null && note.path === unreadablePath,
    openNote,
    handleEditorChange,
    flushPendingSave,
    discardPendingSave,
    followFile,
    reread,
    followFolder,
  }
}

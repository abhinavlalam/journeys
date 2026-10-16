import { createElement, createRef, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DocxEditor, type DocxEditorRef } from '@eigenpal/docx-editor-react'
import { setGoogleFontsEnabled } from '@eigenpal/docx-editor-core'
import editorSheet from '@eigenpal/docx-editor-react/styles.css?inline'
import type { BufferSet } from './useBuffers'
import { followedFile } from './links'
import { useWindowEvent } from './useWindowEvent'
import { sameStamp, vaultFileBytes, vaultFileStamp, writeSeenBytes, type FileStamp } from './vault'
import { isWithin, type VaultFile } from './vaultModel'
import { loadTwins } from './wordFonts'

/** How long after the last change a document is saved, as a note is. */
const AUTOSAVE_MS = 800

// A document's fonts are the bundled twins or the machine's, never asked of Google.
setGoogleFontsEnabled(false)

/**
 * The editor's sheet, in once. Five of its rules are on every editable element in the
 * page, and set the note's editor to `display: inline`: they are kept to the editor's
 * root and the hidden ProseMirror it puts in `body`.
 */
let styled = false
function addSheet() {
  if (styled) return
  styled = true
  const sheet = document.createElement('style')
  sheet.textContent = editorSheet.replaceAll('[contenteditable=true]', ':is(.ep-root, .paged-editor__hidden-pm) [contenteditable=true]')
  document.head.append(sheet)
}

/**
 * One Word document open for editing: the editor (`docx-editor`, in a React root of its
 * own, so a save in flight is finished before it goes: unmounted under one, the save came
 * back empty), the bytes last seen on disk, and the save. Not the library's `renderAsync`,
 * which resolves on the first change, so never for a document only opened.
 */
class Session {
  root: Root | null = null
  editor = createRef<DocxEditorRef>()
  seen: Uint8Array | null = null
  stamp: FileStamp | null = null
  dirty = false
  timer: ReturnType<typeof setTimeout> | undefined
  saving: Promise<void> = Promise.resolve()
  closed = false
  file: VaultFile
  box: HTMLElement
  say: (message: string) => void

  constructor(file: VaultFile, box: HTMLElement, say: (message: string) => void) {
    this.file = file
    this.box = box
    this.say = say
  }

  async open() {
    const [, bytes, stamp] = await Promise.all([loadTwins(), vaultFileBytes(this.file), vaultFileStamp(this.file)])
    if (this.closed) return
    this.root?.unmount()
    this.seen = bytes
    this.stamp = stamp
    this.root = createRoot(this.box)
    this.root.render(
      createElement(DocxEditor, {
        ref: this.editor,
        documentBuffer: bytes,
        mode: 'editing',
        colorMode: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
        showFileOpen: false,
        showHelpMenu: false,
        renderLogo: () => null,
        onChange: () => this.changed(),
        onSave: () => void this.flush().catch(() => {}),
      })
    )
  }

  changed() {
    this.dirty = true
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush().catch(() => {}), AUTOSAVE_MS)
  }

  /** Writes what was changed. A save that fails stays to be written, is said, and throws, so a quit stays. */
  flush(): Promise<void> {
    clearTimeout(this.timer)
    const editor = this.editor.current
    if (!this.dirty || !editor) return this.saving
    this.dirty = false
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        const saved = await editor.save()
        if (!saved) throw new Error('the editor had nothing to save')
        const bytes = new Uint8Array(saved)
        const kept = await writeSeenBytes(this.file, bytes, this.seen!)
        this.seen = bytes
        this.stamp = await vaultFileStamp(this.file)
        if (kept) this.say(`${this.file.name} changed elsewhere while you edited. Yours is in the document; the other is beside it as ${kept.name}.`)
      })
      .catch((err: unknown) => {
        this.dirty = true
        this.say(`${this.file.name} could not be saved: ${String(err)}`)
        throw err
      })
    return this.saving
  }

  /** A write the app did not make, taken in when nothing is waiting to be saved; else the save keeps it beside. */
  async refresh() {
    if (this.dirty || !this.root || this.closed) return
    const stamp = await vaultFileStamp(this.file)
    if (this.stamp && sameStamp(stamp, this.stamp)) return
    await this.open()
  }

  /** Saves what is waiting, then lets the editor go. */
  async close() {
    this.closed = true
    try {
      await this.flush()
    } finally {
      this.root?.unmount()
    }
  }
}

/**
 * A Word document edited in place, as Word edits it. Saved a moment after the last
 * change, when its tab hides, and before it closes or the app quits, through the
 * buffers every open note is reached by, so a move, a delete and a quit reach it too.
 */
export default function WordEditor({
  id,
  file,
  shown,
  buffers,
  say,
  flushRef,
}: {
  id: number
  file: VaultFile
  shown: boolean
  buffers: Pick<BufferSet, 'register' | 'unregister'>
  say: (message: string) => void
  /** The save, for the page to wait on before it draws the pages again. */
  flushRef: { current: (() => Promise<void>) | null }
}) {
  const box = useRef<HTMLDivElement>(null)
  const session = useRef<Session | null>(null)

  useEffect(() => {
    addSheet()
    const one = new Session(file, box.current!, say)
    session.current = one
    flushRef.current = () => one.flush()
    one.open().catch((err: unknown) => say(`${file.name} could not be opened for editing: ${String(err)}`))
    buffers.register(id, {
      flushPendingSave: () => one.flush(),
      discardPendingSave: (pathOrPrefix) => {
        if (!isWithin(one.file.path, pathOrPrefix)) return
        one.dirty = false
        clearTimeout(one.timer)
      },
      followFile: (was, moved) => {
        if (one.file.path === was) one.file = moved
      },
      followFolder: (from, to, moves) => {
        const root = one.file.absolutePath.slice(0, one.file.absolutePath.length - one.file.path.length - 1)
        one.file = followedFile(one.file, from, to, moves, root)
      },
      reread: async (written) => {
        if (written?.path === one.file.path) await one.refresh()
      },
      note: null,
    })
    return () => {
      buffers.unregister(id)
      flushRef.current = null
      // A save that fails has said so.
      one.close().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (session.current) session.current.file = file
  }, [file])

  // Hidden, it writes what it held and lets go of the keyboard: its editable lives in
  // `body`, so it kept the keys a tab's press did not move.
  useEffect(() => {
    if (shown) {
      void session.current?.refresh()
      return
    }
    session.current?.flush().catch(() => {})
    const focused = document.activeElement
    if (focused instanceof HTMLElement && focused.closest('.paged-editor__hidden-pm')) focused.blur()
  }, [shown])
  useWindowEvent('focus', () => shown && void session.current?.refresh())

  return <div ref={box} className="word-editor" />
}

import { useEffect, useMemo, useRef, type ComponentProps, type MutableRefObject } from 'react'
import { useNoteBuffer } from './useNoteBuffer'
import type { BufferSet } from './useBuffers'
import { ViewerHeader } from './ViewerHeader'
import { MarkdownEditor } from './MarkdownEditor'
import { JsonEditor } from './JsonEditor'
import { NoteFooter } from './NoteFooter'
import { FolderTree } from './FolderTree'
import { backlinksTo, childrenOf, folderWithNote, trailTo } from './links'
import { dailyNeighbours } from './daily'
import { ChevronIcon } from './icons'
import { fileKind, isEncrypted, isNote } from './vaultModel'
import { CsvEditor } from './CsvEditor'
import { TextEditor } from './TextEditor'
import type { VaultFile, VaultFolder } from './vaultModel'
import type { Settings } from './settings'
import type { useVaultTexts } from './useVaultTexts'
import type { CollectionOption } from './editorComplete'

interface NotePaneProps {
  /** The tab's id — what this pane's buffer is registered under. */
  id: number
  file: VaultFile
  /** Whether this tab is the one its group shows. An inactive pane keeps its
   *  buffer and draws nothing. */
  active: boolean
  vaultPath: string
  refresh: (path: string) => Promise<VaultFolder | null>
  setError: (message: string | null) => void
  buffers: Pick<BufferSet, 'register' | 'unregister'>
  /** The open note's text as the *editor* has it — see `App`. */
  liveText: MutableRefObject<{ path: string; text: string } | null>
  settings: Settings
  settingsOpen: boolean
  notes: ComponentProps<typeof MarkdownEditor>['notes']
  completable: CollectionOption[]
  root: VaultFolder | null
  icons: Record<string, string>
  backlinks: ReturnType<typeof useVaultTexts>['backlinks']
  /** Everything a tree needs but the folder it draws and which tree it is — for
   *  the Inside section, which is the second tree drawing these. */
  treeProps: Omit<ComponentProps<typeof FolderTree>, 'folder' | 'depth' | 'where'>
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string, wiki: boolean) => void
  onOpenTag: (tag: string) => void
  onOpenCollection: (keyword: string) => void
  onRename: (file: VaultFile, name: string) => void
  /** Locks an encrypted note again: its tab closes and its passphrase is forgotten. */
  onLock: (file: VaultFile) => void
  /** A keystroke landed. `App` listens while a view derived from the corpus is on
   *  screen in another pane, so it can re-take the live text — see `liveVersion`. */
  onTyped?: () => void
}

/**
 * One note tab: its header, its editor and the sections at the end of it — and
 * **its buffer**, which is why this is a component and not a branch of `App`'s
 * render. A buffer is a hook, a hook lives as long as the component that calls
 * it, and a tab's text should live exactly as long as the tab: so each note tab
 * mounts one of these, and an inactive one stays mounted and renders nothing.
 * `App` reaches the buffer through the registry it hands in.
 */
export function NotePane({
  id,
  file,
  active,
  vaultPath,
  refresh,
  setError,
  buffers,
  liveText,
  settings,
  settingsOpen,
  notes,
  completable,
  root,
  icons,
  backlinks,
  treeProps,
  onOpen,
  onOpenLink,
  onOpenCollection,
  onOpenTag,
  onRename,
  onLock,
  onTyped,
}: NotePaneProps) {
  const buffer = useNoteBuffer({ vaultPath, refresh, setError })

  // **Read the note before it is shown**, and only when the buffer is not already
  // holding it: after a rename `followFile` has already re-pointed the buffer at
  // the new path, and re-reading here would race the `path:` the rename writes.
  useEffect(() => {
    if (buffer.note?.path !== file.path) void buffer.openNote(file)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path])

  // Registered every render, so the operations `App` reaches are this render's
  // closures — a stale `followFile` would move a note the buffer no longer holds.
  useEffect(() => {
    buffers.register(id, {
      flushPendingSave: buffer.flushPendingSave,
      discardPendingSave: buffer.discardPendingSave,
      followFile: buffer.followFile,
      followFolder: buffer.followFolder,
      reread: buffer.reread,
      note: buffer.note,
    })
  })
  // The last thing a closing tab does is write what it held.
  const flush = useRef(buffer.flushPendingSave)
  flush.current = buffer.flushPendingSave
  useEffect(
    () => () => {
      buffers.unregister(id)
      void flush.current()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id]
  )
  // Out of sight: the editor unmounts and the buffer takes over its text.
  useEffect(() => {
    if (!active) buffer.settle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const insideFolder = useMemo(() => folderWithNote(root, file.path), [root, file.path])
  const trail = useMemo(() => trailTo(root, file.path), [root, file.path])
  /** The days either side of this one, for a note in the daily folder. */
  const steps = useMemo(
    () => dailyNeighbours(notes ?? [], settings.dailyFolder, file.path),
    [notes, settings.dailyFolder, file.path]
  )

  // Bound before the markup: a `const` narrows inside the handler under it, where
  // `steps.previous &&` in the JSX narrows only what is drawn.
  const { previous: back, next: forward } = steps

  if (!active) return null

  /**
   * **The editor mounts once, over the bytes.** Until the buffer holds this file
   * the pane is its header alone: an editor mounted over `''` and then re-keyed
   * when the read landed was two CodeMirror instances for one open, and between
   * the first's teardown and the second's effect there is no editor in the DOM at
   * all — a gap a test fell through, and a flash on screen.
   */
  const loaded = buffer.note?.path === file.path

  function handleEditorChange(markdown: string) {
    liveText.current = { path: file.path, text: markdown }
    buffer.handleEditorChange(markdown)
    onTyped?.()
  }

  return (
    <>
      <ViewerHeader
        name={file.name}
        // A note is renamed by its title, and a nested note's title renames its
        // folder — `App` picks which. Only a note: a JSON file has a name too, and
        // nothing about it is a note's.
        onRename={isNote(file.path) ? (typed) => onRename(file, typed) : undefined}
        status={
          buffer.saveStatus === 'saving' ? 'Saving…' : buffer.saveStatus === 'saved' ? 'Saved' : ''
        }
      >
        {isEncrypted(file.path) && (
          <button className="header-action" onClick={() => onLock(file)}>
            Lock
          </button>
        )}
      </ViewerHeader>
      {/* **The day before and the day after, at the top of a journal page.** The
          end of a note says where it sits and what points at it; a daily note is
          also a place in a *sequence*, and that belongs at the top where reading
          starts. Only the days that exist, either side — see `dailyNeighbours` —
          and nothing at all on a note that is not one of them. */}
      {(back || forward) && (
        <nav className="daily-steps" aria-label="The days either side">
          {back && (
            <button className="daily-step back" onClick={() => onOpen(back)}>
              <ChevronIcon open={false} />
              {back.name}
            </button>
          )}
          {forward && (
            <button className="daily-step forward" onClick={() => onOpen(forward)}>
              {forward.name}
              <ChevronIcon open={false} />
            </button>
          )}
        </nav>
      )}
      {!loaded ? null : buffer.unreadable ? (
        <p className="viewer-empty">
          This note could not be read, so it has not been opened for editing. Nothing has been
          written to it — its text is still on disk.
        </p>
      ) : /* Keyed on the path *and* the epoch: the text is a value the editor takes
           at mount, so the key is what makes a re-read — the focus sync, a property
           written into the note, a tab coming back — replace what the pane holds.

           **Every editor autosaves**, through the same `handleEditorChange`: a JSON
           file, a CSV, a note — a file of the user's, kept as they type.
           `.config/settings.json` is the one file with a Save, and it has its own
           tab. The question is what *kind* of file it is and not whether it is a
           note: an unlocked `.enc` is markdown once it is open, and a `.txt` or a
           `.conf` is not — in the markdown editor every `# comment` was a heading. */
      fileKind(file.path) === 'json' ? (
        <JsonEditor
          key={`${file.path}:${buffer.editorEpoch}`}
          name={file.name}
          initialText={buffer.body}
          onChange={handleEditorChange}
          indentWidth={settings.indentWidth}
        />
      ) : fileKind(file.path) === 'csv' ? (
        <CsvEditor
          key={`${file.path}:${buffer.editorEpoch}`}
          name={file.name}
          initialText={buffer.body}
          onChange={handleEditorChange}
          indentWidth={settings.indentWidth}
        />
      ) : fileKind(file.path) === 'text' ? (
        <TextEditor
          key={`${file.path}:${buffer.editorEpoch}`}
          name={file.name}
          initialText={buffer.body}
          onChange={handleEditorChange}
          indentWidth={settings.indentWidth}
        />
      ) : (
        <MarkdownEditor
          key={`${file.path}:${buffer.editorEpoch}`}
          initialMarkdown={buffer.body}
          onChange={handleEditorChange}
          insertTimeCombo={settingsOpen ? null : settings.shortcuts.insertTime}
          notes={notes}
          collections={completable}
          dailyFolder={settings.dailyFolder}
          indentWidth={settings.indentWidth}
          onOpenLink={onOpenLink}
          onOpenCollection={onOpenCollection}
          onOpenTag={onOpenTag}
        />
      )}
      {/* Notes only. A link to a non-`.md` target resolves as external, so nothing
          in the vault can point at a JSON file for this to list. */}
      {loaded && isNote(file.path) && (
        <NoteFooter
          // Keyed on the note: a section's open state is an answer about *this*
          // note, and `startOpen` is only an initial value.
          key={file.path}
          insideCount={insideFolder ? childrenOf(insideFolder).length : 0}
          inside={
            insideFolder && (
              // `depth={1}`: the section's heading is the parent row and its items
              // are children, so they sit one step in.
              <FolderTree folder={insideFolder} depth={1} where="inside" {...treeProps} />
            )
          }
          trail={trail}
          icons={icons}
          backlinks={backlinks ? backlinksTo(backlinks, file.path) : []}
          onOpen={onOpen}
        />
      )}
    </>
  )
}

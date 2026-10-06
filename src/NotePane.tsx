import { useEffect, useMemo, useRef, type ComponentProps, type MutableRefObject } from 'react'
import { useNoteBuffer } from './useNoteBuffer'
import type { BufferSet } from './useBuffers'
import { ViewerHeader } from './ViewerHeader'
import { MarkdownEditor } from './MarkdownEditor'
import { JsonEditor } from './JsonEditor'
import { NoteFooter } from './NoteFooter'
import { FolderTree } from './FolderTree'
import { backlinksTo, childrenOf, folderWithNote, trailTo } from './links'
import { dailyNeighbours, isDailyNote } from './daily'
import { ChevronIcon } from './icons'
import { fileKind, isEncrypted, isNote } from './vaultModel'
import { CsvEditor } from './CsvEditor'
import { TextEditor } from './TextEditor'
import type { VaultFile, VaultFolder } from './vaultModel'
import type { Settings } from './settings'
import type { useVaultTexts } from './useVaultTexts'
import type { Entries } from './configEntries'
import { DayTotals } from './DayTotals'
import { typeOf } from './properties'
import type { DayTotal } from './tags'

interface NotePaneProps {
  /** The tab's id, which this pane's buffer is registered under. */
  id: number
  file: VaultFile
  /**
   * Whether this tab is the one its group shows. A hidden pane
   * keeps its buffer and editor.
   */
  active: boolean
  vaultPath: string
  refresh: (path: string) => Promise<VaultFolder | null>
  setError: (message: string | null) => void
  buffers: Pick<BufferSet, 'register' | 'unregister'>
  /** The open note's text as the editor has it; see `App`. */
  liveText: MutableRefObject<{ path: string; text: string } | null>
  settings: Settings
  settingsOpen: boolean
  notes: ComponentProps<typeof MarkdownEditor>['notes']
  /** Each property's type, to know where a block property's value ends. */
  propertyTypes: Entries
  /** Each tag's structure, for the properties its line is offered. */
  tagStructures: Entries
  root: VaultFolder | null
  icons: Record<string, string>
  backlinks: ReturnType<typeof useVaultTexts>['backlinks']
  /**
   * Everything a tree needs except its folder and which tree it
   * is, for the Inside section.
   */
  treeProps: Omit<ComponentProps<typeof FolderTree>, 'folder' | 'depth' | 'where'>
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string, wiki: boolean) => void
  onOpenTag: (tag: string) => void
  onRename: (file: VaultFile, name: string) => void
  /** Locks a locked note again: its tab closes and its passphrase is forgotten. */
  onLock: (file: VaultFile) => void
  /** Each tag's daily totals, closing a daily note as they close its day in the timeline. */
  dayTotals: Readonly<Record<string, readonly DayTotal[]>>
  /**
   * A key was typed. `App` listens while a view built from the notes is
   * on screen in another pane, to take the live text; see `liveVersion`.
   */
  onTyped?: () => void
}

/**
 * One note tab: its header, its editor, the sections at its end, and
 * its buffer. The buffer is a hook, so it lives as long as this
 * component, which lives as long as the tab. A hidden tab stays
 * mounted. `App` reaches the buffer through the registry it passes in.
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
  propertyTypes,
  tagStructures,
  root,
  icons,
  backlinks,
  treeProps,
  onOpen,
  onOpenLink,
  onOpenTag,
  onRename,
  onLock,
  onTyped,
  dayTotals,
}: NotePaneProps) {
  const buffer = useNoteBuffer({ vaultPath, refresh, setError })

  // Read the note before it is shown, unless the buffer already
  // holds it: after a rename `followFile` has moved the buffer,
  // and reading again would race the `path::` the rename writes.
  useEffect(() => {
    if (buffer.note?.path !== file.path) void buffer.openNote(file)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path])

  // Registered every render, so `App` reaches this render's functions;
  // a stale `followFile` would move a note the buffer no longer holds.
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
  // A closing tab writes what it held.
  const flush = useRef(buffer.flushPendingSave)
  flush.current = buffer.flushPendingSave
  useEffect(
    () => () => {
      buffers.unregister(id)
      // A save that fails has said so.
      flush.current().catch(() => {})
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id]
  )
  // Hidden, the tab keeps its editor (text and undo) and writes what it held.
  useEffect(() => {
    if (!active) buffer.flushPendingSave().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const insideFolder = useMemo(() => folderWithNote(root, file.path), [root, file.path])
  const trail = useMemo(() => trailTo(root, file.path), [root, file.path])
  /** The days either side, for a note in the daily folder. */
  const steps = useMemo(
    () => dailyNeighbours(notes ?? [], settings.dailyFolder, file.path),
    [notes, settings.dailyFolder, file.path]
  )

  // Bound first: a `const` narrows inside the handler, where
  // `steps.previous &&` in the JSX narrows only what is drawn.
  const { previous: back, next: forward } = steps

  /**
   * The editor mounts once, over the file's text. Until the buffer holds
   * it, the pane is only its header. Mounting over `''` and re-keying made
   * two editors per open, with a moment between them where there was none.
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
        shown={active}
        name={file.name}
        // A note is renamed by its title, and a nested note's title
        // renames its folder (`App` decides which). Notes only.
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
      {/* The day before and the day after, at the top of a daily
          note, when those notes exist (`dailyNeighbours`). */}
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
          shown={active}
          name={file.name}
          initialText={buffer.body}
          incoming={buffer.incoming}
          onChange={handleEditorChange}
          indentWidth={settings.indentWidth}
        />
      ) : fileKind(file.path) === 'csv' ? (
        <CsvEditor
          key={`${file.path}:${buffer.editorEpoch}`}
          shown={active}
          name={file.name}
          initialText={buffer.body}
          incoming={buffer.incoming}
          onChange={handleEditorChange}
          indentWidth={settings.indentWidth}
        />
      ) : fileKind(file.path) === 'text' ? (
        <TextEditor
          key={`${file.path}:${buffer.editorEpoch}`}
          shown={active}
          name={file.name}
          initialText={buffer.body}
          incoming={buffer.incoming}
          onChange={handleEditorChange}
          indentWidth={settings.indentWidth}
        />
      ) : (
        <MarkdownEditor
          key={`${file.path}:${buffer.editorEpoch}`}
          shown={active}
          initialMarkdown={buffer.body}
          incoming={buffer.incoming}
          onChange={handleEditorChange}
          insertTimeCombo={settingsOpen ? null : settings.shortcuts.insertTime}
          notes={notes}
          propertyTypes={propertyTypes}
          tagStructures={tagStructures}
          dailyFolder={settings.dailyFolder}
          caretAtEnd={isDailyNote(file.path, settings.dailyFolder)}
          indentWidth={settings.indentWidth}
          onOpenLink={onOpenLink}
          onOpenTag={onOpenTag}
        />
      )}
      {/* A day's totals at its note's end, from the text as last saved or typed: the
          pane is drawn again when a save lands, so they follow the typing. */}
      {loaded && !buffer.unreadable && isDailyNote(file.path, settings.dailyFolder) && (
        <DayTotals
          text={liveText.current?.path === file.path ? liveText.current.text : buffer.body}
          totals={dayTotals}
          typeOf={(name) => typeOf(propertyTypes, name)}
          place="note"
        />
      )}
      {/* Notes only. A link to a non-`.md` target is external,
          so nothing links to a JSON file. */}
      {loaded && isNote(file.path) && (
        <NoteFooter
          // Keyed on the note, so each note starts with its own
          // open state; `startOpen` is only the first value.
          key={file.path}
          insideCount={insideFolder ? childrenOf(insideFolder).length : 0}
          inside={
            insideFolder && (
              // `depth={1}`: the heading is the parent row, so
              // its items sit one step in.
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

import { useEffect, useMemo, useRef, useState, type ComponentProps, type MutableRefObject } from 'react'
import { useNoteBuffer } from './useNoteBuffer'
import type { BufferSet } from './useBuffers'
import { ViewerHeader, ViewSwitch } from './ViewerHeader'
import { CsvTable } from './CsvTable'
import { MarkdownEditor } from './MarkdownEditor'
import { SourceEditor } from './SourceEditor'
import { NoteFooter } from './NoteFooter'
import { FolderTree } from './FolderTree'
import { anchorRange, backlinksTo, childrenOf, folderWithNote, trailTo } from './links'
import { openBoxOf } from './daySections'
import { dailyNeighbours, dayOf, isDailyNote } from './daily'
import { TrackedSection, type TrackedDay } from './trackerParts'
import type { Tracker } from './trackers'
import { ChevronIcon } from './icons'
import { fileKind, isEncrypted, isNote, knownPath } from './vaultModel'
import type { VaultFile, VaultFolder } from './vaultModel'
import type { Settings } from './settings'
import type { useVaultTexts } from './useVaultTexts'
import type { Typing } from './LineEditor'
import type { ColumnTotal } from './tags'

/** A delimited file's two ways of being shown: a table edited in place, or its text. */
const CSV_VIEWS = ['table', 'text'] as const

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
  typing: Typing
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
  /** What the trackers' tables hold for a day, ending its daily note. */
  tracked: (day: string) => TrackedDay
  onOpenTable: (tracker: Tracker) => void
  /** How a table's column is totalled, chosen under it: kept in the settings by the column's name. */
  onColumnTotal: (column: string, total: ColumnTotal) => void
  /**
   * A key was typed. `App` listens while a view built from the notes is
   * on screen in another pane, to take the live text; see `liveVersion`.
   */
  onTyped?: () => void
  /** A link's anchor to show, for the note at `path`: its line chosen and brought into view. */
  reveal?: { path: string; anchor: string; n: number } | null
  /** Asks the vault's agent to organise the days (`ORGANISE`), from a daily note's header; none on the phone. */
  onOrganise?: () => void
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
  typing,
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
  onColumnTotal,
  tracked,
  onOpenTable,
  reveal,
  onOrganise,
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
    () => dailyNeighbours(typing.notes, settings.dailyFolder, file.path),
    [typing.notes, settings.dailyFolder, file.path]
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
  const kind = fileKind(file.path)
  // The day's plan is drawn as a section is, after them, so the sections keep their hues.
  // A link to one of its lines names it as the `[[` popup does, by its path when
  // another note has its name, since the link is pasted elsewhere.
  const linkName = useMemo(
    () => (typing.notes.filter((one) => one.name.toLowerCase() === file.name.toLowerCase()).length > 1 ? knownPath(file.path) : file.name),
    [typing.notes, file]
  )
  const lineLinked = (link: string | null) => {
    if (!link) return setError('A link goes to a line with something written on it.')
    navigator.clipboard.writeText(link).then(
      () => setError(`Copied ${link}: pasted anywhere, it opens this note at that line.`),
      (err: unknown) => setError(`The link could not be copied: ${String(err)}`)
    )
  }
  // Found in the text as it is now, so a link followed before the note was read lands once it is.
  const revealAt = useMemo(() => {
    const range = reveal && reveal.path === file.path ? anchorRange(buffer.body, reveal.anchor) : null
    return range && reveal ? { ...range, n: reveal.n } : null
  }, [reveal, file.path, buffer.body])
  const daySectionNames = useMemo(
    () => [...settings.daySections.map((section) => section.name), ...(settings.dayPlan.count ? [settings.dayPlan.name] : [])],
    [settings.daySections, settings.dayPlan]
  )

  /**
   * A table, or its text (`CSV_VIEWS`). Either mounts over the text as it is now
   * (`current`), not as last read: switched to after an edit in the other, the editor
   * held the old text, and its first key saved it over the edit.
   */
  const [csvView, setCsvView] = useState<(typeof CSV_VIEWS)[number]>('table')
  const current = useRef(buffer.body)
  const taken = useRef({ epoch: buffer.editorEpoch, incoming: buffer.incoming?.n })
  if (taken.current.epoch !== buffer.editorEpoch) current.current = buffer.body
  else if (buffer.incoming && taken.current.incoming !== buffer.incoming.n) current.current = buffer.incoming.text
  taken.current = { epoch: buffer.editorEpoch, incoming: buffer.incoming?.n }

  function handleEditorChange(markdown: string) {
    current.current = markdown
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
        {kind === 'csv' && <ViewSwitch views={CSV_VIEWS} view={csvView} onView={setCsvView} />}
        {isEncrypted(file.path) && (
          <button className="header-action" onClick={() => onLock(file)}>
            Lock
          </button>
        )}
        {onOrganise && isDailyNote(file.path, settings.dailyFolder) && (
          <button className="header-action" onClick={onOrganise}>
            Organise
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
      ) : /* Keyed on the path *and* the epoch: the text is a value the editor takes at
           mount, so opening a note, or one that could not be read, remounts it. A re-read
           of the note it holds arrives as `incoming`, a change, keeping caret and undo.

           **Every editor autosaves**, through the same `handleEditorChange`: a JSON
           file, a CSV, a note — a file of the user's, kept as they type.
           `.config/settings.json` is the one file with a Save, and it has its own
           tab. The question is what *kind* of file it is and not whether it is a
           note: an unlocked `.enc` is markdown once it is open, and a `.txt` or a
           `.conf` is not — in the markdown editor every `# comment` was a heading. */
      kind === 'csv' && csvView === 'table' ? (
        <CsvTable
          key={`${file.path}:${buffer.editorEpoch}:table`}
          text={current.current}
          incoming={buffer.incoming}
          onChange={handleEditorChange}
          totals={settings.columnTotals}
          onTotal={onColumnTotal}
          onOpenLink={onOpenLink}
        />
      ) : kind === 'json' || kind === 'csv' || kind === 'text' ? (
        <SourceEditor
          key={`${file.path}:${buffer.editorEpoch}:${csvView}`}
          kind={kind}
          shown={active}
          name={file.name}
          initialText={current.current}
          incoming={buffer.incoming}
          onChange={handleEditorChange}
          indentWidth={settings.indentWidth}
          onOpenLink={onOpenLink}
        />
      ) : (
        <MarkdownEditor
          key={`${file.path}:${buffer.editorEpoch}`}
          shown={active}
          initialMarkdown={buffer.body}
          incoming={buffer.incoming}
          onChange={handleEditorChange}
          {...typing}
          dailyFolder={settings.dailyFolder}
          daySections={isDailyNote(file.path, settings.dailyFolder) ? daySectionNames : undefined}
          linkName={linkName}
          onLineLink={lineLinked}
          reveal={revealAt}
          caretAtEnd={isDailyNote(file.path, settings.dailyFolder)}
          caret={isDailyNote(file.path, settings.dailyFolder) ? (openBoxOf(buffer.body, settings.dayPlan, settings.daySections) ?? undefined) : undefined}
          indentWidth={settings.indentWidth}
          onOpenLink={onOpenLink}
          onOpenTag={onOpenTag}
        />
      )}
      {/* What the trackers' tables hold for the day, under its last section, Trackers: what the
          note says and this does not is not in a table yet. */}
      {loaded && isDailyNote(file.path, settings.dailyFolder) && <TrackedSection day={tracked(dayOf(file.path))} onOpenTable={onOpenTable} />}

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

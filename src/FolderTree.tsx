import { useEffect, useRef, useState } from 'react'
import { isSelfOrDescendant } from './vault'
import { fileKind, folderNoteRef, folderOf, isEncrypted, isNote, type FileKind } from './vaultModel'
import { guideAt, NameField, NoteRow, stepIn, RowIcon } from './rows'
import { pickMode, type PickMode } from './picking'
import { onAndroid } from './platform'
import type { VaultFolder, VaultFile } from './vaultModel'
import { useContextMenu } from './useContextMenu'
import {
  ChevronIcon,
  DEFAULT_NOTE_ICON,
  NOTE_ICONS,
  NoteIcon,
  BracesIcon,
  PlusIcon,
  resolveNoteIcon,
} from './icons'

const DRAG_MIME = 'application/x-journeys-file'
const DRAG_MIME_FOLDER = 'application/x-journeys-folder'

/** Where the dragged label sits under the pointer: a little down and to the right,
 *  so the cursor is beside the name rather than on top of it. */
const GHOST_OFFSET = { x: 12, y: 14 }

function setCustomDragImage(e: React.DragEvent, label: string) {
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.textContent = label
  document.body.appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, GHOST_OFFSET.x, GHOST_OFFSET.y)
  setTimeout(() => ghost.remove(), 0)
}

/** The passphrase question, under the file it is about. `name` is what the field's
 *  accessible name says, since the row above it says nothing to a reader. */
export interface InlineUnlock {
  path: string
  name: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}

/** A name being typed for a note or folder about to be created, rendered in place. */
export interface InlineCreate {
  /** The folder the new note goes in, `''` for the vault itself. */
  parentPath: string
  /** The tree that asked for it — see `where`. Only that tree draws the field. */
  owner: string
  /** Set while that folder is still a plain note: its path, until it is committed. */
  insideNote?: string
  /** A locked note's passphrase, asked in the same field once its name is in. */
  secret?: { placeholder: string; label: string }
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}

interface FolderTreeProps {
  folder: VaultFolder
  depth: number
  /**
   * **Which tree this is.** Two panes draw one: the left pane's (`'tree'`) and the
   * *Inside* section at the end of a nested note (`'inside'`). A name being typed
   * belongs to the tree the `+` was pressed in — both drew it otherwise, and the
   * second field to mount took the focus and blurred the first, which cancels a
   * create. Also what keeps a passphrase question in the pane, where the row it is
   * about has just been revealed.
   */
  where: string
  /** The folders that are open — `useFolderOpenState`'s one set, and the only
   *  reason a folder is open. */
  openFolders: Set<string>
  onToggleFolder: (path: string, isOpen: boolean) => void
  /** Rendered in place, under the folder it will create into. */
  create: InlineCreate | null
  /** The file waiting on a passphrase, if one is. */
  unlock: InlineUnlock | null
  selectedPath: string | null
  /**
   * The notes **picked** to act on together, by path — ⌘-click and ⇧-click put them
   * here and nothing opens. A row in it paints; see `.picked` in the sheet.
   */
  picked: ReadonlySet<string>
  /** Deletes every picked note, behind one question. */
  onDeletePicked: () => void
  /** A folder note's chosen emoji, by the note's path. */
  icons: Record<string, string>
  onSetFileIcon: (file: VaultFile, icon: string | null) => void
  onSetFolderIcon: (folder: VaultFolder, icon: string | null) => void
  /** A click on a leaf row, and which gesture it was — see `picking.ts`. `only`
   *  opens the note; the other two pick without opening. */
  onSelectFile: (file: VaultFile, mode: PickMode) => void
  onSelectFolderNote: (folder: VaultFolder) => void
  /** A note inside this path — `''` is the vault itself. */
  onNewNote: (parentPath: string) => void
  /** A note inside a note that has none yet, which converts it on the way. */
  onNewNoteInside: (file: VaultFile, owner: string) => void
  onMoveFile: (file: VaultFile, newParentPath: string) => void
  onMoveFolder: (folder: VaultFolder, newParentPath: string) => void
  /** **Files dragged in from outside**, copied into that folder under their own
   *  names. A vault is a folder, and filing a PDF in one is a drag. */
  onImportFiles: (files: readonly File[], to: string) => void
  /** The same, dropped on a **plain note**: it becomes a nested note and they go
   *  inside it — the `+` on that row, for a file rather than a name. */
  onImportFilesInside: (note: VaultFile, files: readonly File[]) => void
  /** **A note dragged onto a plain note** goes inside it, converting it on the way:
   *  the same act, for one of the vault's own notes rather than a file from
   *  outside. Any note can hold notes; it becomes nested the moment one arrives. */
  onAdoptFile: (note: VaultFile, dragged: VaultFile) => void
  /** And a nested note — a folder with its own note — dragged onto a plain one. */
  onAdoptFolder: (note: VaultFile, dragged: VaultFolder) => void
  onRenameFile: (file: VaultFile, newName: string) => void
  onRenameFolder: (folder: VaultFolder, newName: string) => void
  onDeleteFile: (file: VaultFile) => void
  onDeleteFolder: (folder: VaultFolder) => void
  /** Takes an *absolute* path, which is all Finder needs and the one thing both
      row kinds have. `App` holds the side effect, as it does for every other
      thing a menu item does. */
  onReveal: (absolutePath: string) => void
}

/**
 * The icon picker: the same menu for a page and for a nested page.
 *
 * `own` is the note's *own* icon and not an inherited one — it is what marks a row
 * as chosen and what Remove can act on. The two rows had this twice, and the copies
 * had already begun to differ in how they spelled the same thing.
 */
function useIconMenu(own: string | undefined, onSet: (icon: string | null) => void) {
  return useContextMenu(
    () => (own ? [{ label: 'Remove icon', onSelect: () => onSet(null), danger: true }] : []),
    () =>
      NOTE_ICONS.map((choice) => ({
        label: choice.label,
        icon: <NoteIcon icon={choice.key} />,
        selected: choice.key === own,
        onSelect: () => onSet(choice.key),
      }))
  )
}

/**
 * **A passphrase, asked where the file is.** An encrypted note opens by being
 * unlocked, so the question belongs under its own row rather than in a dialog over
 * the note it is about to show — and it is asked in the field everything else is
 * typed into, with the glyphs held back.
 *
 * Blur cancels, like every field that is not a rename: leaving the question is an
 * answer.
 */
function unlockRow(unlock: InlineUnlock, depth: number) {
  return (
    <li style={{ paddingLeft: stepIn(depth) }}>
      <NameField
        value={unlock.value}
        type="password"
        placeholder="Passphrase…"
        ariaLabel={`Passphrase for ${unlock.name}`}
        onChange={unlock.onChange}
        onSubmit={unlock.onSubmit}
        onCancel={unlock.onCancel}
        onBlur={unlock.onCancel}
      />
    </li>
  )
}

/** The name field for a new note, at whatever depth it is being made. Blur
 *  **cancels** here, where a rename's commits: browsing away from a half-typed
 *  name must not make a note called half of it. */
function createRow(create: InlineCreate, depth: number) {
  return (
    <li style={{ paddingLeft: stepIn(depth) }}>
      <NameField
        value={create.value}
        type={create.secret ? 'password' : 'text'}
        placeholder={create.secret?.placeholder ?? 'Note title…'}
        ariaLabel={create.secret?.label}
        onChange={create.onChange}
        onSubmit={create.onSubmit}
        onCancel={create.onCancel}
        onBlur={create.onCancel}
      />
    </li>
  )
}

export function FolderTree(props: FolderTreeProps) {
  const { folder, depth, create, selectedPath, onSelectFile, onRenameFile, onDeleteFile } = props
  return (
    <>
      {create &&
        create.owner === props.where &&
        !create.insideNote &&
        create.parentPath === folder.path &&
        createRow(create, depth)}
      {folder.folders.map((sub) => (
        <FolderRow key={sub.path} {...props} folder={sub} />
      ))}
      {folder.files.flatMap((file) => [
        <FileRow
          key={file.path}
          file={file}
          depth={depth}
          selected={file.path === selectedPath}
          picked={props.picked.has(file.path)}
          pickedCount={props.picked.size}
          onDeletePicked={props.onDeletePicked}
          icon={props.icons[file.path]}
          own={props.icons[file.path]}
          onImportFilesInside={props.onImportFilesInside}
          onAdoptFile={props.onAdoptFile}
          onAdoptFolder={props.onAdoptFolder}
          onSetIcon={props.onSetFileIcon}
          onSelectFile={onSelectFile}
          onRenameFile={onRenameFile}
          onNewNoteInside={(file) => props.onNewNoteInside(file, props.where)}
          onDeleteFile={onDeleteFile}
          onReveal={props.onReveal}
        />,
        // The note has no folder yet, so there is nowhere in the tree for the field
        // to sit but under the row itself — and it sits at the depth the new note
        // will have. The folder is made when the name is committed, not when the
        // `+` is clicked, so cancelling here leaves the note exactly as it was.
        create?.insideNote === file.path && create.owner === props.where
          ? createRow(create, depth + 1)
          : null,
        // An encrypted note asks for its passphrase in the same slot, at its own
        // depth: the question is about *this* file. **The pane's tree only** — the
        // row it is about is revealed there, and two fields would fight for the
        // keyboard the way two create rows did.
        props.unlock?.path === file.path && props.where === 'tree'
          ? unlockRow(props.unlock, depth)
          : null,
      ])}
    </>
  )
}

/**
 * **What a row's glyph says a file is.** The tree lists every file in the vault
 * now, so a row has to say which kind it is at a glance — a photograph, a PDF, a
 * table of values — from the one drawn set (`NOTE_ICONS`), because an icon this app
 * does not have renders as its own name. JSON keeps its braces, which is a glyph of
 * its own; anything the app has nothing to say about takes the page.
 */
const GLYPHS: Partial<Record<FileKind, string>> = {
  csv: 'list',
  image: 'image',
  pdf: 'book',
  text: 'quote',
}

/** The glyph for a file that is not a note. JSON wears braces, which is a drawn
 *  glyph of its own rather than one of the set; everything else names one. */
function glyphFor(path: string) {
  if (isEncrypted(path)) return <NoteIcon icon="lock" />
  const kind = fileKind(path)
  if (kind === 'json') return <BracesIcon />
  return <NoteIcon icon={GLYPHS[kind] ?? DEFAULT_NOTE_ICON} />
}

/**
 * The second click of a double click, which the browser has already counted for
 * us in `detail`.
 *
 * A double click renames, and both rows do something on a single click — a leaf
 * opens, a folder's row opens *and* toggles. Without this the row expanded and
 * shut again underneath the field that had just appeared. The *first* click still
 * does its work: waiting to see whether a second one follows would put a delay on
 * every note in the vault to serve the rarer gesture.
 */
function isDoubleClick(e: React.MouseEvent): boolean {
  return e.detail > 1
}

/**
 * Rename in place: the state, the input, and the three ways out of it.
 *
 * Local to this file because it has exactly two callers and both are here. The
 * create row above is deliberately *not* a caller — it has no prefill and
 * **cancels** on blur, where these commit. Committing on blur is the decision being
 * shared, not the markup.
 */
function useRename(name: string, onRename: (newName: string) => void) {
  const [renaming, setRenaming] = useState(false)
  const [value, setValue] = useState(name)

  function submit() {
    setRenaming(false)
    const trimmed = value.trim()
    if (trimmed && trimmed !== name) onRename(trimmed)
  }

  return {
    renaming,
    start() {
      setValue(name)
      setRenaming(true)
    },
    input: (className?: string) => (
      <NameField
        value={value}
        // A rename stands in for a row that is on screen: same height, no gap.
        className={className ? `rename-in-row ${className}` : 'rename-in-row'}
        onChange={setValue}
        onSubmit={submit}
        onCancel={() => setRenaming(false)}
        // **Blur commits**, unlike the create row's: the name was already there,
        // and clicking away from an edit of it means keep the edit.
        onBlur={submit}
      />
    ),
  }
}

function FileRow({
  file,
  depth,
  selected,
  onImportFilesInside,
  onAdoptFile,
  onAdoptFolder,
  picked,
  pickedCount,
  onDeletePicked,
  icon,
  own,
  onSetIcon,
  onSelectFile,
  onRenameFile,
  onNewNoteInside,
  onDeleteFile,
  onReveal,
}: {
  file: VaultFile
  depth: number
  selected: boolean
  onImportFilesInside: (note: VaultFile, files: readonly File[]) => void
  onAdoptFile: (note: VaultFile, dragged: VaultFile) => void
  onAdoptFolder: (note: VaultFile, dragged: VaultFolder) => void
  /** In the picked set: the row paints, and its menu acts on the whole set. */
  picked: boolean
  pickedCount: number
  onDeletePicked: () => void
  /** Its own or inherited — what is drawn. */
  icon: string | undefined
  /** Only its own, which is what Remove can act on. */
  own: string | undefined
  onSetIcon: (file: VaultFile, icon: string | null) => void
  onSelectFile: (file: VaultFile, mode: PickMode) => void
  onRenameFile: (file: VaultFile, newName: string) => void
  onNewNoteInside: (file: VaultFile) => void
  onDeleteFile: (file: VaultFile) => void
  onReveal: (absolutePath: string) => void
}) {
  const [dragging, setDragging] = useState(false)
  const drag = usePrimaryDrag()
  const drop = useNoteDropTarget(file, onImportFilesInside, onAdoptFile, onAdoptFolder)
  const rename = useRename(file.name, (newName) => onRenameFile(file, newName))
  /** **The menu acts on the set when this row is in one.** Rename goes with it:
   *  one name cannot stand for twenty notes. Reveal stays — it is about the row
   *  that was pressed, and one path is all Finder takes. */
  const many = picked && pickedCount > 1
  const [menu, openMenu] = useContextMenu(() => [
    ...(many ? [] : [{ label: 'Rename', onSelect: rename.start }]),
    ...(onAndroid ? [] : [{ label: 'Reveal in Finder', onSelect: () => onReveal(file.absolutePath) }]),
    many
      ? { label: `Delete ${pickedCount} notes`, onSelect: onDeletePicked, danger: true }
      : { label: 'Delete', onSelect: () => onDeleteFile(file), danger: true },
  ])
  const [iconMenu, openIconMenu] = useIconMenu(own, (icon) => onSetIcon(file, icon))

  if (rename.renaming) {
    return <li style={{ paddingLeft: stepIn(depth) }}>{rename.input()}</li>
  }

  return (
    <li className="note-row" style={{ paddingLeft: stepIn(depth) }}>
      {/* `NoteRow` is the shape — the reserved chevron, the body, the icon's
          column, the name — shared with the Actions section and the sections at the
          end of a note. What is a leaf row's *own* is all here: it drags, it renames
          on a double click, and its icon is a picker.

          A file that is not a note wears braces and is **not** a picker: an icon is
          an `icon:` property written into the file, and frontmatter in a JSON file
          is a JSON file that no longer parses. `writeNoteProperty` refuses it as
          well — this is the half that says so on screen. */}
      <NoteRow
        className={`${selected ? 'selected' : ''} ${picked ? 'picked' : ''} ${drop.over ? 'drag-over' : ''} ${dragging ? 'dragging' : ''}`.trim()}
        {...drop.handlers}
        icon={
          isNote(file.path) ? (
            <span
              role="button"
              tabIndex={-1}
              className="folder-icon"
              aria-label={`Icon for ${file.name}`}
              onClick={(e) => {
                e.stopPropagation()
                openIconMenu(e)
              }}
            >
              <NoteIcon icon={icon ?? DEFAULT_NOTE_ICON} />
            </span>
          ) : (
            <RowIcon>{glyphFor(file.path)}</RowIcon>
          )
        }
        name={file.name}
        draggable
        onMouseDown={drag.onMouseDown}
        onDragStart={(e) => {
          if (drag.refused(e)) return
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(DRAG_MIME, JSON.stringify(file))
          // The payload is not readable during dragover, only the type list, so
          // the path rides along as a type — the folder's own arrangement — and a
          // note's row can refuse the drag that started on it.
          e.dataTransfer.setData(`${DRAG_MIME}+${file.path.toLowerCase()}`, '')
          setCustomDragImage(e, file.name)
          setDragging(true)
        }}
        onDragEnd={() => setDragging(false)}
        onClick={(e) => {
          if (isDoubleClick(e)) return
          onSelectFile(file, pickMode(e))
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          rename.start()
        }}
        onContextMenu={openMenu}
      />
      {/* Every note takes a note inside it. This one has no folder yet, so the
          handler makes one — `Ideas.md` becomes `Ideas/Ideas.md` and the new note
          goes in beside it. Same cluster as a folder row's, so the two `+`s sit in
          one column. */}
      {/* Only a note takes a note inside it: `Ideas.md` becomes `Ideas/Ideas.md`,
          and there is no such move for `data.json`. The cluster stays, empty, so
          the column it shares with a folder row's `+` does not collapse. */}
      <span className="folder-actions">
        {isNote(file.path) && (
          <button
            aria-label={`New note in ${file.name}`}
            // **Holds the focus where it is.** A create field abandons on blur, so
            // pressing this while one is open threw away what had been typed and
            // then opened an empty one — the close racing the click, the same thing
            // the search results list refuses the focus change for.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onNewNoteInside(file)}
          >
            <PlusIcon />
          </button>
        )}
      </span>
      {menu}
      {iconMenu}
    </li>
  )
}

/**
 * **A drag starts on the primary button and no other.**
 *
 * WebKit begins a drag session when the *right* button is pressed on a `draggable`
 * element, where Chrome does not — so a right-click on a note in the app started a
 * drag it never finished: the list under the pointer took the drop wash and kept
 * it, a blue outline across the whole left pane with a context menu open over it.
 * Reported exactly that way, and invisible to every test because jsdom and Chrome
 * both decline the gesture.
 *
 * The button is read on `mousedown`, because a `DragEvent` does not carry one.
 */
function usePrimaryDrag() {
  const primary = useRef(true)
  return {
    onMouseDown: (event: React.MouseEvent) => {
      primary.current = event.button === 0
    },
    /** True when this drag must not happen — and it is refused on the way out. */
    refused(event: React.DragEvent): boolean {
      if (primary.current) return false
      event.preventDefault()
      return true
    },
  }
}

/**
 * A drop wash cannot outlive the gesture that lit it. `dragleave` clears it, but a
 * drag that ends without one — Escape, or the right-button drag WebKit starts by
 * itself — left the pane painted; `dragend` fires on the source and `drop` anywhere,
 * and either means this is over. Both drop targets in the tree use it.
 */
function useClearOnDragEnd(over: boolean, clear: () => void) {
  useEffect(() => {
    if (!over) return
    const off = () => clear()
    window.addEventListener('dragend', off)
    window.addEventListener('drop', off)
    return () => {
      window.removeEventListener('dragend', off)
      window.removeEventListener('drop', off)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over])
}

/**
 * A dragged row's own path, lowercased, from the marker type it rides on. The
 * payload is unreadable until the drop — only the type list is — so the path goes
 * along as a MIME suffix, which is what lets a target refuse at `dragover`.
 */
const markedPath = (types: readonly string[], mime: string) =>
  types.find((t) => t.startsWith(`${mime}+`))?.slice(mime.length + 1) ?? ''

/**
 * What a drop carries, read one way for both kinds of target: files from outside
 * first — asked the way the dragover asked it, since a `DataTransfer` that never
 * said it carries files need not have a `files` list at all — then a note, then a
 * folder. What each target *does* with it, and what it refuses, stays its own: a
 * refused drop on a folder row must be swallowed there, or it bubbles to the root
 * and moves the folder to the top of the vault.
 */
function payloadOf(e: React.DragEvent): { files?: File[]; file?: VaultFile; folder?: VaultFolder } | null {
  if (e.dataTransfer.types.includes('Files')) return { files: [...(e.dataTransfer.files ?? [])] }
  const file = e.dataTransfer.getData(DRAG_MIME)
  if (file) return { file: JSON.parse(file) as VaultFile }
  const folder = e.dataTransfer.getData(DRAG_MIME_FOLDER)
  return folder ? { folder: JSON.parse(folder) as VaultFolder } : null
}

/**
 * **A plain note takes what is dropped on it and becomes a nested note**: a file
 * from outside, one of the vault's own notes, or a nested note. Each goes inside it,
 * the same act the `+` on the row performs for a typed name. Only a note takes one —
 * a PDF is not a page that can hold anything — and anything else falls through to
 * the list below, which is the vault itself.
 *
 * It took files from outside first and refused the vault's own notes, on the
 * grounds that a note dragged onto a note had no meaning yet. It has one, and it is
 * the obvious one: asked for as "I want to be able to move notes under any other
 * note; a note should just automatically convert." A note is not a kind of thing
 * that can or cannot hold notes; it is a note, and it holds notes the moment one is
 * put in it.
 *
 * Two refusals, both at `dragover` so the row does not light up for a drop it would
 * not take. A note cannot be dropped on itself — its path rides on the drag as a
 * type suffix, since the payload is unreadable until the drop. And a folder cannot
 * be dropped on a note that is *inside* it, which would move the destination along
 * with the source; the same guard `useDropTarget` has, asked of the note's folder.
 */
function useNoteDropTarget(
  file: VaultFile,
  onImportFilesInside: (note: VaultFile, files: readonly File[]) => void,
  onAdoptFile: (note: VaultFile, dragged: VaultFile) => void,
  onAdoptFolder: (note: VaultFile, dragged: VaultFolder) => void
) {
  const [over, setOver] = useState(false)
  useClearOnDragEnd(over, () => setOver(false))
  const accepts = (e: React.DragEvent) => {
    if (!isNote(file.path)) return false
    const types = e.dataTransfer.types
    if (types.includes('Files')) return true
    if (types.includes(DRAG_MIME)) return markedPath(types, DRAG_MIME) !== file.path.toLowerCase()
    if (!types.includes(DRAG_MIME_FOLDER)) return false
    return !isSelfOrDescendant(markedPath(types, DRAG_MIME_FOLDER), folderOf(file.path).toLowerCase())
  }
  return {
    over,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const dropped = payloadOf(e)
        if (dropped?.files) {
          if (dropped.files.length > 0) onImportFilesInside(file, dropped.files)
        } else if (dropped?.file) {
          // The drop-time half of the self check, for a drag that carried no marker.
          if (dropped.file.path !== file.path) onAdoptFile(file, dropped.file)
        } else if (dropped?.folder && !isSelfOrDescendant(dropped.folder.path, folderOf(file.path))) {
          onAdoptFolder(file, dropped.folder)
        }
      },
    },
  }
}

/**
 * A place a note or a folder can be dropped: a folder's row, or the tree's own
 * container, which is the **root**.
 *
 * There was no root target at all, so dragging anything out of a folder and back
 * to the top of the vault had nowhere to land — reported from the running app.
 * One hook for both, because "what may be dropped here and what that means" is one
 * question with one answer, and the root is just `''` as a destination.
 */
export function useDropTarget(
  to: string,
  onMoveFile: (file: VaultFile, to: string) => void,
  onMoveFolder: (folder: VaultFolder, to: string) => void,
  /** Files dragged in from outside the app — see `onImportFiles`. */
  onImportFiles: (files: readonly File[], to: string) => void
) {
  const [over, setOver] = useState(false)

  useClearOnDragEnd(over, () => setOver(false))

  // A folder cannot be dropped into itself or its own subtree; refusing the
  // dragover is what stops the drop indicator appearing on an invalid target.
  function canAccept(e: React.DragEvent): boolean {
    // **From outside the app.** A drag out of Finder carries `Files`, and taking it
    // is the whole of what stops the webview doing its own thing with it: its
    // default for a dropped file is to *navigate to it*, which replaced the app
    // with the PDF somebody meant to file.
    if (e.dataTransfer.types.includes('Files')) return true
    if (e.dataTransfer.types.includes(DRAG_MIME)) return true
    if (!e.dataTransfer.types.includes(DRAG_MIME_FOLDER)) return false
    return !isSelfOrDescendant(markedPath(e.dataTransfer.types, DRAG_MIME_FOLDER), to.toLowerCase())
  }

  return {
    over,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!canAccept(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const dropped = payloadOf(e)
        if (dropped?.files) {
          if (dropped.files.length > 0) onImportFiles(dropped.files, to)
        } else if (dropped?.file) {
          onMoveFile(dropped.file, to)
        } else if (dropped?.folder && !isSelfOrDescendant(dropped.folder.path, to)) {
          onMoveFolder(dropped.folder, to)
        }
      },
    },
  }
}

function FolderRow(props: FolderTreeProps) {
  const {
    folder,
    depth,
    create,
    selectedPath,
    openFolders,
    onToggleFolder,
    onSelectFolderNote,
    onNewNote,
    onMoveFile,
    onMoveFolder,
    onRenameFolder,
    onReveal,
    onDeleteFolder,
    icons,
    onSetFolderIcon,
  } = props

  /** Open because it is in the set, and for no other reason — see
   *  `useFolderOpenState` for what the other reasons were and what they cost. */
  const expanded = openFolders.has(folder.path)

  /** The chevron's answer, taking the state on screen. */
  function toggleSelf() {
    onToggleFolder(folder.path, expanded)
  }

  // Against the path `folderNoteRef` *would* produce, not just an existing note: a
  // folder note is written lazily, so a folder without one yet could otherwise
  // never show as selected however long you waited.
  /**
   * Whether anything is actually inside this note.
   *
   * A folder note with nothing beside it is a note that *can* hold others and does
   * not — clicking `+` and thinking better of it used to leave exactly that, drawn
   * with an arrow and an accent as though it were full. `files` excludes the
   * folder's own note, so this is the honest question.
   */
  const hasNotesInside = folder.folders.length > 0 || folder.files.length > 0

  const isSelected = folderNoteRef(folder).path === selectedPath
  const creatingHere = create?.parentPath === folder.path
  const showChildren = expanded || creatingHere
  const drop = useDropTarget(folder.path, onMoveFile, onMoveFolder, props.onImportFiles)
  const [dragging, setDragging] = useState(false)
  const drag = usePrimaryDrag()
  const rename = useRename(folder.name, (newName) => onRenameFolder(folder, newName))
  const [menu, openMenu] = useContextMenu(() => [
    { label: 'Rename', onSelect: rename.start },
    // The folder, not its own note: the row stands for the folder, and revealing it
    // shows the container with its note and its children inside. A folder note that
    // has never been typed in has no file to select anyway.
    ...(onAndroid ? [] : [{ label: 'Reveal in Finder', onSelect: () => onReveal(folder.absolutePath) }]),
    { label: 'Delete', onSelect: () => onDeleteFolder(folder), danger: true },
  ])
  /** Its own — what is written in the note, which is all a row draws. */
  const shownIcon = resolveNoteIcon(folder.path, icons)
  /** Only its own — what the menu's Remove is about, and what it can remove. */
  const ownIcon = icons[folderNoteRef(folder).path]
  const [iconMenu, openIconMenu] = useIconMenu(ownIcon, (icon) =>
    onSetFolderIcon(folder, icon)
  )

  return (
    <li className="folder-row">
      <div
        className={`folder-header ${isSelected ? 'selected' : ''} ${drop.over ? 'drag-over' : ''} ${dragging ? 'dragging' : ''}`}
        style={{ paddingLeft: stepIn(depth) }}
        draggable
        onMouseDown={drag.onMouseDown}
        onDragStart={(e) => {
          if (drag.refused(e)) return
          e.stopPropagation()
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(DRAG_MIME_FOLDER, JSON.stringify(folder))
          // Type-list marker so drop targets can reject their own subtree during
          // dragover, when getData() is not allowed to return the payload.
          e.dataTransfer.setData(`${DRAG_MIME_FOLDER}+${folder.path}`, '')
          setCustomDragImage(e, folder.name)
          setDragging(true)
        }}
        onDragEnd={() => setDragging(false)}
        {...drop.handlers}
      >
        {rename.renaming ? (
          rename.input('folder-rename-input')
        ) : (
          <>
            {/* Both do both: the chevron expands, and the name opens the folder's
                own note *and* toggles. A node is a note and a container at once, so
                clicking it twice has to close what the first click opened — the
                alternative is a row that only ever expands. `toggleSelf` reads the
                rendered state and drops the reveal, which is what lets the second
                click win even though the open note keeps the folder on the selected
                path. */}
            {hasNotesInside ? (
              <button
                className="folder-chevron"
                aria-label={expanded ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleSelf()
                }}
              >
                <ChevronIcon open={expanded} />
              </button>
            ) : (
              // Nothing inside: the same empty slot a leaf row reserves, so this
              // note reads as what it is — a note — until something is in it.
              <span className="folder-chevron" aria-hidden="true" />
            )}
            <button
              className="folder-toggle"
              onClick={(e) => {
                if (isDoubleClick(e)) return
                onSelectFolderNote(folder)
                toggleSelf()
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                rename.start()
              }}
              onContextMenu={openMenu}
            >
              {/* The icon is its own button: clicking it picks one, and clicking the
                  name still opens the note. `stopPropagation` is what keeps those
                  two apart, since the icon sits inside the name's button. */}
              <span
                role="button"
                tabIndex={-1}
                className="folder-icon"
                aria-label={`Icon for ${folder.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  openIconMenu(e)
                }}
              >
                <NoteIcon icon={shownIcon ?? DEFAULT_NOTE_ICON} />
              </span>
              <span className="row-name">{folder.name}</span>
            </button>
          </>
        )}
        {/* A note inside this one. No menu: there is one kind of note, and where
            it goes is what this button already says. */}
        <span className="folder-actions">
          <button
            aria-label={`New note in ${folder.name}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onNewNote(folder.path)}
          >
            <PlusIcon />
          </button>
        </span>
        {menu}
        {iconMenu}
      </div>
      {showChildren && (
        // `--guide-x` is this folder's own indent; the stylesheet adds the half
        // chevron that centres the rule under the arrow, because that is where the
        // chevron's size is written down.
        <ul className="folder-children" style={guideAt(depth)}>
          <FolderTree {...props} depth={depth + 1} />
        </ul>
      )}
    </li>
  )
}

import { useEffect, useRef, useState } from 'react'
import { fileKind, folderNoteRef, folderOf, isEncrypted, isNote, isWithin, type FileKind } from './vaultModel'
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

/**
 * Where the dragged label sits under the pointer: a little down
 * and right, so the cursor is beside the name.
 */
const GHOST_OFFSET = { x: 12, y: 14 }

function setCustomDragImage(e: React.DragEvent, label: string) {
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.textContent = label
  document.body.appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, GHOST_OFFSET.x, GHOST_OFFSET.y)
  setTimeout(() => ghost.remove(), 0)
}

/**
 * The passphrase question, under the file it is about. `name` is
 * the field's accessible name.
 */
export interface InlineUnlock {
  path: string
  name: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}

/** A name being typed for a new note or folder, shown in place. */
export interface InlineCreate {
  /** The folder the new note goes in; `''` is the vault itself. */
  parentPath: string
  /** The tree that asked for it (see `where`). Only that tree draws the field. */
  owner: string
  /**
   * Set while that folder is still a plain note: its path, until the name is committed.
   */
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
   * Which tree this is: the left pane's (`'tree'`) or the Inside section at the end of
   * a nested note (`'inside'`). A name being typed belongs to the tree whose `+` was
   * pressed; if both drew the field, the second took the focus and cancelled the first.
   */
  where: string
  /** The open folders: `useFolderOpenState`'s set, the only reason a folder is open. */
  openFolders: Set<string>
  onToggleFolder: (path: string, isOpen: boolean) => void
  /** Shown in place, under the folder it creates into. */
  create: InlineCreate | null
  /** The file waiting for a passphrase, if any. */
  unlock: InlineUnlock | null
  selectedPath: string | null
  /**
   * Notes picked to act on together, by path. ⌘-click and ⇧-click add to
   * it without opening. A picked row gets a background (see `.picked`).
   */
  picked: ReadonlySet<string>
  /** Deletes every picked note, after one confirmation. */
  onDeletePicked: () => void
  /** A folder note's icon, by the note's path. */
  icons: Record<string, string>
  onSetFileIcon: (file: VaultFile, icon: string | null) => void
  onSetFolderIcon: (folder: VaultFolder, icon: string | null) => void
  /**
   * A click on a row, and which gesture it was (see `picking.ts`).
   * `only` opens the note; the other two pick without opening.
   */
  onSelectFile: (file: VaultFile, mode: PickMode) => void
  onSelectFolderNote: (folder: VaultFolder) => void
  /** A new note inside this path; `''` is the vault itself. */
  onNewNote: (parentPath: string) => void
  /** A new note inside a plain note, which converts it on the way. */
  onNewNoteInside: (file: VaultFile, owner: string) => void
  onMoveFile: (file: VaultFile, newParentPath: string) => void
  onMoveFolder: (folder: VaultFolder, newParentPath: string) => void
  /** Files dragged in from outside, copied into that folder under their own names. */
  onImportFiles: (files: readonly File[], to: string) => void
  /**
   * The same, dropped on a plain note: it becomes a nested note and they go inside it.
   */
  onImportFilesInside: (note: VaultFile, files: readonly File[]) => void
  /**
   * A note dragged onto a plain note goes inside it, converting
   * it on the way. Any note can hold notes.
   */
  onAdoptFile: (note: VaultFile, dragged: VaultFile) => void
  /** And a nested note (a folder with its own note) dragged onto a plain one. */
  onAdoptFolder: (note: VaultFile, dragged: VaultFolder) => void
  onRenameFile: (file: VaultFile, newName: string) => void
  onRenameFolder: (folder: VaultFolder, newName: string) => void
  onDeleteFile: (file: VaultFile) => void
  onDeleteFolder: (folder: VaultFolder) => void
  /**
   * Takes an absolute path, which is what Finder needs. `App`
   * does the actual work, as for every menu item.
   */
  onReveal: (absolutePath: string) => void
}

/**
 * The icon picker, the same for a note and a nested note. `own` is the note's own
 * icon, not an inherited one: it marks the chosen icon and is what Remove removes.
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
 * The passphrase question, asked under the file's own row rather than in a dialog,
 * in the same field as everything else, with the characters hidden. Blur cancels.
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

/**
 * The name field for a new note, at the depth it will have. Blur cancels here, unlike a
 * rename: clicking away from a half-typed name mustn't make a note called half of it.
 */
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
        // The note has no folder yet, so the field sits under the
        // row, at the new note's depth. The folder is made when the
        // name is committed, so cancelling leaves the note as it was.
        create?.insideNote === file.path && create.owner === props.where
          ? createRow(create, depth + 1)
          : null,
        // A locked note asks for its passphrase in the same place,
        // at its own depth. Only in the pane's tree, where its row
        // is shown; two fields would fight for the keyboard.
        props.unlock?.path === file.path && props.where === 'tree'
          ? unlockRow(props.unlock, depth)
          : null,
      ])}
    </>
  )
}

/**
 * The icon for a file by its kind, so a photo, a PDF and a table look different
 * at a glance. Drawn from `NOTE_ICONS`, since an unknown icon shows as its
 * name. JSON keeps its braces; anything else unknown gets the page icon.
 */
const GLYPHS: Partial<Record<FileKind, string>> = {
  csv: 'list',
  image: 'image',
  pdf: 'book',
  text: 'quote',
}

/**
 * The icon for a file that isn't a note. JSON gets braces;
 * everything else names one from the set.
 */
function glyphFor(path: string) {
  if (isEncrypted(path)) return <NoteIcon icon="lock" />
  const kind = fileKind(path)
  if (kind === 'json') return <BracesIcon />
  return <NoteIcon icon={GLYPHS[kind] ?? DEFAULT_NOTE_ICON} />
}

/**
 * The second click of a double click, from the event's `detail`. A double click
 * renames, but the first click still does its own work (opening a note, or opening and
 * toggling a folder); waiting to see if a second click follows would slow every click.
 */
function isDoubleClick(e: React.MouseEvent): boolean {
  return e.detail > 1
}

/**
 * Rename in place: the state, the input, and the three ways out.
 * Here because both callers are here. The create row is not one
 * of them: it cancels on blur, where a rename commits.
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
        // A rename replaces a row on screen: same height, no gap.
        className={className ? `rename-in-row ${className}` : 'rename-in-row'}
        onChange={setValue}
        onSubmit={submit}
        onCancel={() => setRenaming(false)}
        // Blur commits, unlike the create row: the name was
        // already there, and clicking away means keep the edit.
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
  /**
   * In the picked set: the row gets a background, and its menu acts on the whole set.
   */
  picked: boolean
  pickedCount: number
  onDeletePicked: () => void
  /** Its own or inherited: what is drawn. */
  icon: string | undefined
  /** Only its own: what Remove can act on. */
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
  /**
   * When this row is in a picked set, the menu acts on the set. There is no Rename
   * (one name can't cover twenty notes). Reveal stays, for the row that was pressed.
   */
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
      {/* `NoteRow` is the shared row shape: chevron space, body, icon
          column, name. What belongs to a leaf row is here: it drags,
          it renames on a double click, and its icon is a picker.

          A file that isn't a note shows braces and has no picker: an
          icon is an `icon::` property written into the file, and that
          would break a JSON file. `writeNoteProperty` refuses it too. */}
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
          // The payload can't be read during dragover, only the
          // type list, so the path rides along as a type, and a
          // note's row can refuse a drag that started on it.
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
          handler makes one: `Ideas.md` becomes `Ideas/Ideas.md` with the new note
          beside it. Same cluster as a folder row's, so the `+` buttons line up. */}
      {/* Only a note takes a note inside it; there is no such move for
          `data.json`. The empty cluster stays so the `+` column lines up. */}
      <span className="folder-actions">
        {isNote(file.path) && (
          <button
            aria-label={`New note in ${file.name}`}
            // Keep the focus where it is: a create field closes on blur, so
            // pressing this while one is open would throw away what was typed.
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
 * A drag starts on the primary button only. WebKit starts a drag on a
 * right-press over a draggable element, so a right-click on a note
 * left the left pane lit as a drop target behind the menu. The button
 * is read on `mousedown`, since a drag event doesn't carry it.
 */
function usePrimaryDrag() {
  const primary = useRef(true)
  return {
    onMouseDown: (event: React.MouseEvent) => {
      primary.current = event.button === 0
    },
    /** True when this drag must not happen; it is cancelled as it starts. */
    refused(event: React.DragEvent): boolean {
      if (primary.current) return false
      event.preventDefault()
      return true
    },
  }
}

/**
 * Clears a drop target's highlight when the drag ends. `dragleave`
 * isn't enough: a drag ended with Escape, or WebKit's right-button
 * drag, left it lit. `dragend` and `drop` both mean it is over.
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
 * A dragged row's path, lowercased, read from the type it rides on.
 * The payload can't be read until the drop, so the path travels as
 * a MIME suffix, which lets a target refuse at `dragover`.
 */
const markedPath = (types: readonly string[], mime: string) =>
  types.find((t) => t.startsWith(`${mime}+`))?.slice(mime.length + 1) ?? ''

/**
 * What a drop carries, read the same way for both kinds of target: files
 * from outside first, then a note, then a folder. Each target decides what
 * to do and what to refuse. A refused drop on a folder row must be swallowed
 * there, or it bubbles to the root and moves the folder to the top.
 */
function payloadOf(e: React.DragEvent): { files?: File[]; file?: VaultFile; folder?: VaultFolder } | null {
  if (e.dataTransfer.types.includes('Files')) return { files: [...(e.dataTransfer.files ?? [])] }
  const file = e.dataTransfer.getData(DRAG_MIME)
  if (file) return { file: JSON.parse(file) as VaultFile }
  const folder = e.dataTransfer.getData(DRAG_MIME_FOLDER)
  return folder ? { folder: JSON.parse(folder) as VaultFolder } : null
}

/**
 * A plain note takes what is dropped on it and becomes a nested note: a
 * file from outside, a note, or a nested note, which goes inside it.
 * Only a note takes one; anything else falls through to the vault.
 *
 * Two refusals, both at `dragover` so the row doesn't light up: a note can't
 * be dropped on itself, and a folder can't be dropped on a note inside it.
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
    return !isWithin(folderOf(file.path).toLowerCase(), markedPath(types, DRAG_MIME_FOLDER))
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
          // The self check again at drop time, for a drag that carried no marker.
          if (dropped.file.path !== file.path) onAdoptFile(file, dropped.file)
        } else if (dropped?.folder && !isWithin(folderOf(file.path), dropped.folder.path)) {
          onAdoptFolder(file, dropped.folder)
        }
      },
    },
  }
}

/**
 * Where a note or folder can be dropped: a folder's row, or the
 * tree's container, which is the root (`''`).
 */
export function useDropTarget(
  to: string,
  onMoveFile: (file: VaultFile, to: string) => void,
  onMoveFolder: (folder: VaultFolder, to: string) => void,
  /** Files dragged in from outside the app (see `onImportFiles`). */
  onImportFiles: (files: readonly File[], to: string) => void
) {
  const [over, setOver] = useState(false)

  useClearOnDragEnd(over, () => setOver(false))

  // A folder can't be dropped into itself or its own subtree;
  // refusing the dragover keeps the highlight off.
  function canAccept(e: React.DragEvent): boolean {
    // Files from outside the app: taking the drop stops the
    // webview's default, which is to navigate to the dropped file.
    if (e.dataTransfer.types.includes('Files')) return true
    if (e.dataTransfer.types.includes(DRAG_MIME)) return true
    if (!e.dataTransfer.types.includes(DRAG_MIME_FOLDER)) return false
    return !isWithin(to.toLowerCase(), markedPath(e.dataTransfer.types, DRAG_MIME_FOLDER))
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
        } else if (dropped?.folder && !isWithin(to, dropped.folder.path)) {
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

  /**
   * Open because it is in the set, and for no other reason (see `useFolderOpenState`).
   */
  const expanded = openFolders.has(folder.path)

  /** The chevron's action, given the state on screen. */
  function toggleSelf() {
    onToggleFolder(folder.path, expanded)
  }

  // Compared with the path `folderNoteRef` would produce, since a folder note is
  // written lazily; otherwise a folder with no note file could never show as selected.
  /**
   * Whether anything is inside this note. `files` excludes the folder's
   * own note, so an empty folder note isn't drawn as having children.
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
    // Reveal the folder, not its note: it shows the folder with everything
    // inside. A folder note never typed in has no file to select anyway.
    ...(onAndroid ? [] : [{ label: 'Reveal in Finder', onSelect: () => onReveal(folder.absolutePath) }]),
    { label: 'Delete', onSelect: () => onDeleteFolder(folder), danger: true },
  ])
  /** Its own icon: what is written in the note, which is what the row draws. */
  const shownIcon = resolveNoteIcon(folder.path, icons)
  /** Only its own: what the menu's Remove removes. */
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
          // A type-list marker, so drop targets can refuse their own
          // subtree during dragover, when the payload can't be read.
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
            {/* The chevron expands; the name opens the folder's note and toggles.
                A second click closes what the first opened. `toggleSelf` reads
                the state on screen and drops the reveal, so the second click wins
                even though the open note keeps the folder on the selected path. */}
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
              // Nothing inside: the same empty slot a leaf row
              // has, so it reads as a plain note.
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
              {/* The icon is its own button: clicking it picks an icon, and
                  clicking the name opens the note. `stopPropagation` keeps
                  them apart, since the icon is inside the name's button. */}
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
        {/* A note inside this one. No menu: there is one kind of note. */}
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
        // `--guide-x` is this folder's indent; the stylesheet adds
        // half the chevron so the guide sits under the arrow.
        <ul className="folder-children" style={guideAt(depth)}>
          <FolderTree {...props} depth={depth + 1} />
        </ul>
      )}
    </li>
  )
}

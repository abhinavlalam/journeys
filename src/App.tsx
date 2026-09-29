import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  CONFIG_DIR,
  convertToNested,
  createNote,
  ensureDailyNote,
  folderIcon,
  readConfigFile,
  readVaultFile,
  vaultFileRef,
  writeNoteProperty,
  writePathProperty,
  writeVaultFile,
} from './vault'
import { folderNoteRef, isTextFile, knownPath, noteName, SETTINGS_FILE } from './vaultModel'
import { FileView } from './FileView'
import type { VaultFile, VaultFolder } from './vaultModel'
import { FolderTree, useDropTarget } from './FolderTree'
import { ActionsPane, branchKey, headsOf } from './ActionsPane'
import { onQuit } from './quit'
import { BUILT_IN_KINDS, creatable, declares, createAction, groupKey, type ViewKind } from './actionKinds'
import { SettingsFile } from './SettingsFile'
import { NoteSearch } from './NoteSearch'
import { searchNotes } from './search'
import { openExternal, revealInFinder } from './reveal'
import {
  APP_PROPERTIES,
  isAppProperty,
  PROPERTIES_FILE,
  readProperty,
  typeOf,
  withProperty,
  type PropertyType,
} from './properties'
import { useConfigEntries } from './useConfigEntries'
import { readEntries } from './configEntries'
import { propertiesOf, tablesOf, TAG_NAME, TAGS_FILE, viewOf } from './tags'
import { withEditedEntry, withNewEntry, type TimelineEntry } from './timeline'
import { TimelineView } from './TimelineView'
import { LogView } from './LogView'
import { useLog } from './useLog'
import { GraphView } from './GraphView'
import { PropertyView } from './PropertyView'
import { TagView } from './TagView'
import { CalendarView } from './CalendarView'
import { EVENT, EVENT_PROPERTIES, eventLine } from './calendar'
import { syncEvents } from './calendarSync'
import { fetchFeed } from './calendarFeed'
import { occurrences, parseIcs } from './ics'
import { dayDate, daysAfter, localDateStamp } from './clock'
import { Resizer } from './Resizer'
import { useContextMenu } from './useContextMenu'
import { useFolderOpenState } from './useFolderOpenState'
import { useVaultTexts } from './useVaultTexts'
import { useSettings } from './useSettings'
import { useBuffers } from './useBuffers'
import { NotePane } from './NotePane'
import { WorkspaceView } from './WorkspaceView'
import {
  activeTab,
  groups,
  closeNotesUnder,
  emptyWorkspace,
  followFileTabs,
  followFolderTabs,
  openTab,
  openTerminal,
  terminalName,
  toggleTab,
  type TabRequest,
  type Workspace,
} from './workspace'
import { useVault, type VaultBufferOps } from './useVault'
import { useRelocation } from './useRelocation'
import { useInlineCreate } from './useInlineCreate'
import { useWindowShortcuts } from './useWindowShortcuts'
import { useLocks } from './useLocks'
import { onAndroid } from './platform'
import { useDrops } from './useDrops'
import { useCalendarSync } from './useCalendarSync'
import { endTerminal } from './terminal'
import { SettingsPanel, type SectionId } from './SettingsPanel'
import { syncWord, useSync } from './useSync'
import { CloneVault } from './CloneVault'
import {
  collectFolders,
  folderWithNote,
  existingNotesIn,
  pathKey,
  resolveTarget,
  visibleFiles,
} from './links'
import { nothingPicked, pick, withoutUnder, type PickMode } from './picking'
import type { GraphNode } from './graph'
import { claimsIcon, FoldAllIcon, GraphIcon, NoteIcon, SearchIcon, PlusIcon, SettingsIcon, TerminalIcon } from './icons'
/**
 * Loaded only when a terminal opens: xterm is large and touches `window` as it loads.
 */
const TerminalPane = lazy(() => import('./TerminalPane').then((m) => ({ default: m.TerminalPane })))
import { SidebarSection } from './SidebarSection'
import { stepIn, NoteRow, RowIcon } from './rows'

const SIDEBAR_KEY = 'journeys:sidebar-width'
/**
 * The left pane's sections. Their open state is kept with the
 * folders', so a section closed by hand stays closed. They start open.
 */
const SECTIONS = ['section:notes', 'section:actions', 'section:applications'] as const

/** How often typing refreshes a view shown beside the note, at most. */
const LIVE_REFRESH_MS = 250
/** The left pane's width in px: where it starts, and the resizer's limits. */
const SIDEBAR_WIDTH = { start: 260, min: 180, max: 520 }

export default function App() {
  // Every message goes through `setError`: shown at the bottom
  // for a while, then kept in the Log.
  const log = useLog()
  const setError = log.say
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SectionId>('appearance')
  /**
   * Which section's search is open, and its text. Notes searches note
   * text; Actions searches row names. An empty field is still open.
   */
  const [searching, setSearching] = useState<'notes' | 'actions' | null>(null)
  const [query, setQuery] = useState('')
  /**
   * The reading pane: groups of tabs, split into panes, one group
   * focused. Every change is a pure function in `workspace.ts`.
   */
  const [ws, setWs] = useState<Workspace>(emptyWorkspace)
  const active = activeTab(ws)
  /**
   * The note in the focused group, if any. The tree marks it and
   * `liveText` is about it.
   */
  const focusedNote = active?.kind === 'note' ? active.file : null
  /**
   * The last note in front. The graph centres on it, since the
   * graph's own tab is in front while it shows.
   */
  const lastNote = useRef<VaultFile | null>(null)
  if (focusedNote) lastNote.current = focusedNote
  /**
   * A view built from the notes is on screen in some pane, so it has to follow typing.
   */
  const viewVisible = groups(ws.layout).some((group) => {
    const shown = group.tabs[group.active]
    return (
      shown?.kind === 'graph' ||
      shown?.kind === 'property' ||
      shown?.kind === 'tag' ||
      shown?.kind === 'calendar' ||
      shown?.kind === 'timeline'
    )
  })
  /**
   * Bumped by typing, at most a few times a second, while such a
   * view shows; `useVaultTexts` then takes the typed text again.
   * The throttle is a ref so it doesn't re-render the shell.
   */
  const [liveVersion, bumpLive] = useReducer((n: number) => n + 1, 0)
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typed = () => {
    if (!viewVisible || liveTimer.current) return
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null
      bumpLive()
    }, LIVE_REFRESH_MS)
  }
  const open = (tab: TabRequest) => setWs((current) => openTab(current, tab))
  /**
   * Opens a property's or tag's page: from a row, a `#tag` in a
   * note, or a new tag's `+`.
   */
  const view = (kind: ViewKind, name: string) => open({ kind, name })

  /**
   * A file picked in the Actions pane. `.config/settings.json` opens
   * in the tab with a Save, because saving it reconfigures the app.
   */
  function openConfigFile(file: VaultFile) {
    if (file.path === `${CONFIG_DIR}/${SETTINGS_FILE}`) open({ kind: 'settingsFile' })
    else void openNote(file)
  }
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_KEY))
    return Number.isFinite(stored) && stored >= SIDEBAR_WIDTH.min ? stored : SIDEBAR_WIDTH.start
  })

  /**
   * The open notes' buffers, for the vault to save before it writes.
   * Filled in the render, which runs before any effect or handler uses it.
   */
  const bufferOps = useRef<VaultBufferOps>({ flush: async () => {}, close: () => {} })
  const vault = useVault(bufferOps, setError)
  /**
   * Every open note's buffer (see `useBuffers`). A delete closes
   * the tabs under it and drops their queued writes.
   */
  const buffers = useBuffers({
    onDeleted: (prefix) => {
      setWs((current) => closeNotesUnder(current, prefix))
      // The one place a pick is cleared, so every kind of delete clears it.
      setPicked((current) => withoutUnder(current, prefix))
    },
  })
  bufferOps.current = { flush: buffers.flushPendingSave, close: () => setWs(emptyWorkspace()) }
  // A quit saves the open notes first (`quit.ts`). Only inside
  // the app: a test has no quit to wait for.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    const off = onQuit(() => bufferOps.current.flush(), setError)
    return () => void off.then((unlisten) => unlisten())
  }, [])

  const folders = useFolderOpenState(vault.vaultPath, SECTIONS)

  /**
   * Rows picked to act on together (see `picking.ts`). ⌘-click adds one and
   * ⇧-click takes a range. A plain click opens a note and picks only it.
   */
  const [picked, setPicked] = useState(nothingPicked)

  // A new vault starts with nothing picked.
  useEffect(() => setPicked(nothingPicked), [vault.vaultPath])
  /**
   * The open note's text as typed. The buffer's `body` is only
   * the text as last read, and autosave waits 800 ms, so a link
   * typed and followed straight away would be missing from it.
   *
   * A ref, so typing doesn't re-render the shell. It carries the
   * path, so it is never applied to another note.
   */
  const liveText = useRef<{ path: string; text: string } | null>(null)

  /**
   * The vault's `.config/settings.json`, or `localStorage`
   * before a vault is open (see `useSettings`). Read before the
   * vault, because the graph's hidden folders come from it.
   */
  const { settings, changeSettings } = useSettings(vault.vaultPath, setError)
  /**
   * Git sync: save, commit, pull, push, on a timer and on focus. A pull's
   * changes are read again like any outside write, and open buffers are told.
   */
  const sync = useSync({
    vaultPath: vault.vaultPath,
    everySeconds: settings.syncSeconds,
    flush: buffers.flushPendingSave,
    onPulled: async ({ changed }) => {
      if (!vault.vaultPath) return
      await vault.refresh(vault.vaultPath)
      // A pull's changes aren't ours: a save during typing keeps them beside the note.
      for (const path of changed) await buffers.reread(vaultFileRef(vault.vaultPath, path), false)
    },
    onCommitted: async () => {
      if (vault.vaultPath) await vault.refresh(vault.vaultPath)
    },
    onError: setError,
  })
  const syncSentence = syncWord(sync)

  /**
   * The one read of the vault and everything built from it. `liveText`,
   * the open note as typed, is the one input not read from disk.
   */
  /** Each property's type, from `.config/properties.json`. */
  const propertyTypes = useConfigEntries(vault.vaultPath, PROPERTIES_FILE, setError)
  /** Each tag's structure, from `.config/tags.json`. */
  const tagStructures = useConfigEntries(vault.vaultPath, TAGS_FILE, setError)

  const {
    notes,
    noteIndex,
    icons,
    properties,
    propertyValues,
    collectTag,
    timeline,
    tags,
    graph,
    backlinks,
    reading,
    texts,
    patch,
  } = useVaultTexts({
    root: vault.root,
    graphHides: settings.graphHides,
    dailyFolder: settings.dailyFolder,
    vaultPath: vault.vaultPath,
    openPath: focusedNote?.path ?? null,
    // A view built from the notes is open, so use the note as typed:
    // a line written seconds ago must show on its tag's page.
    viewOpen: viewVisible,
    liveVersion,
    liveText,
    types: propertyTypes.entries,
    onError: setError,
  })

  /**
   * Sets a folder's icon and, when icons pass down, the icon of the notes inside.
   * The icon is written into each note, because it belongs to the note.
   * `existingNotesIn` keeps this from creating folder notes that aren't written yet.
   */
  async function setFolderIcon(folder: VaultFolder, icon: string | null) {
    const own = folderNoteRef(folder)
    const inside = settings.inheritIcons
      ? existingNotesIn(folder).filter(
          (note) => note.path !== own.path && claimsIcon(icons[note.path], icons[own.path], icon)
        )
      : []
    await setNoteIcon([own, ...inside], icon)
  }

  const setFileIcon = (file: VaultFile, icon: string | null) => setNoteIcon([file], icon)

  async function setNoteIcon(files: VaultFile[], icon: string | null) {
    // Update the tree now, with the same function the write uses, so it matches what
    // lands on disk. An icon write doesn't change the tree, so nothing reads it back.
    patch(new Set(files.map((file) => file.path)), (text) =>
      withProperty(text, APP_PROPERTIES.icon, icon)
    )
    // `mutate` saves pending typing first; reading the files
    // back afterwards puts the new icon in any open buffer.
    await vault.mutate(
      async () => {
        // In parallel: these are different files, and each write
        // is a read and a write over IPC.
        await Promise.all(files.map((file) => writeNoteProperty(file, APP_PROPERTIES.icon, icon)))
      },
      // Puts the new property in any open note's buffer.
      () => Promise.all(files.map((file) => buffers.reread(file)))
    )
  }


  /**
   * Bumped when the app writes a kind's file, so the lists
   * update without waiting for window focus.
   */
  const [actionsRevision, actionWritten] = useReducer((n: number) => n + 1, 0)
  const kinds = BUILT_IN_KINDS

  /** The rows the tree shows, in order: what a ⇧-click range runs over. */
  const pickOrder = useMemo(
    () => visibleFiles(vault.root, folders.open).map((file) => file.path),
    [vault.root, folders.open]
  )

  /** A click on a row: a plain click opens; ⌘ and ⇧ pick. */
  function selectFile(file: VaultFile, mode: PickMode) {
    setPicked((current) => pick(current, file.path, mode, pickOrder))
    if (mode === 'only') void openNote(file)
  }

  /** Every folder, for Expand all and Collapse all. */
  const folderPaths = useMemo(() => (vault.root ? collectFolders(vault.root) : []), [vault.root])
  /** The Actions pane's rows: what the notes use per kind, and what is declared. */
  const actionsUsed: Partial<Record<string, readonly { name: string; notes: number }[]>> = { property: properties, tag: tags }
  const actionsDeclared: Partial<Record<string, readonly string[]>> = { tag: Object.keys(tagStructures.entries) }
  /**
   * What the Actions section's Expand all and Collapse all act on:
   * its groups and tag groups. They share the folders' open state.
   */
  const groupPaths = kinds.flatMap((kind) => [
    groupKey(kind),
    ...headsOf([
      ...(actionsUsed[kind.key] ?? []).map((one) => one.name),
      ...(actionsDeclared[kind.key] ?? []),
    ]).map((head) => branchKey(kind, head)),
  ])


  /**
   * Search results, over `texts` rather than `corpus`: a hit that
   * flickers as you type in another pane is worse than one a second old.
   */
  const hits = useMemo(() => searchNotes(texts ?? [], query), [texts, query])

  /**
   * The action being named, and the name so far. Kept here because
   * the `+` is in the header and the field is in the pane.
   */
  const [namingAction, setNamingAction] = useState<string | null>(null)
  const [actionName, setActionName] = useState('')

  /** Keeps the spelling the file already has for the property. */
  const setPropertyType = (name: string, type: PropertyType) =>
    propertyTypes.write(
      Object.keys(propertyTypes.entries).find((one) => one.toLowerCase() === name.toLowerCase()) ?? name,
      { type }
    )

  /** The Terminal row's menu: a second shell, under the next free session name. */
  const [terminalMenu, openTerminalMenu] = useContextMenu(() => [
    {
      label: 'New terminal',
      onSelect: () => setWs((current) => openTab(current, { kind: 'terminal', session: terminalName(current) })),
    },
  ])

  const [actionMenu, openActionMenu] = useContextMenu(() =>
    // Config isn't offered: `settings.json` and its neighbours come with the app.
    kinds.filter(creatable).map((kind) => ({
      label: kind.singular,
      icon: <NoteIcon icon={kind.icon} />,
      onSelect: () => startNamingAction(kind.key),
    }))
  )

  /**
   * Starts naming a new one of a kind, from the section's `+` menu or a kind's own `+`.
   */
  function startNamingAction(kind: string) {
    closeSearch()
    creating.cancel()
    setActionName('')
    setNamingAction(kind)
  }

  async function commitAction() {
    const kind = namingAction
    const typed = actionName
    setNamingAction(null)
    setActionName('')
    const type = kinds.find((one) => one.key === kind)
    if (!type || !vault.vaultPath) return

    // A tag's `+` adds an entry to `tags.json`, not a file, and opens the tag's page.
    if (declares(type)) {
      const tag = typed.trim().replace(/^#/, '').toLowerCase()
      if (!new RegExp(`^${TAG_NAME}$`).test(tag)) {
        if (tag) setError(`#${tag} is not a tag: a tag is one word, with a letter in it.`)
        return
      }
      await tagStructures.write(tag, { properties: propertiesOf(tagStructures.entries, tag) })
      view('tag', tag)
      return
    }
    const made = await createAction(vault.vaultPath, type, typed).catch((err: unknown) => {
      setError(String(err))
      return null
    })
    if (!made) return
    actionWritten()
    void openNote(made)
  }

  function closeSearch() {
    setSearching(null)
    setQuery('')
  }

  /**
   * One field at a time. Search and `+` open the same kind of field in the same
   * place, so opening one closes the others, and leaving a field closes it.
   */
  function openSearch(which: 'notes' | 'actions') {
    creating.cancel()
    setNamingAction(null)
    setSearching(which)
  }

  /**
   * Opens a note in its tab, or in a new tab of the file's kind.
   * The tab reads the file before its editor mounts; opening
   * first would save the previous note's text into this one.
   */
  function openNote(file: VaultFile) {
    // Opening a note opens the folders above it, by adding them
    // to the set the tree reads.
    folders.reveal(knownPath(file.path))
    // A locked note opens by unlocking (see `useLocks`).
    if (locks.asks(file)) return Promise.resolve()
    // A tab of the file's kind. Only text gets a note tab with a
    // buffer; a buffer over a PDF would corrupt it on the first
    // keystroke. `FileView` shows the rest and writes nothing.
    open({ kind: isTextFile(file.path) ? 'note' : 'file', file })
    return Promise.resolve()
  }

  /**
   * Locked notes: asking for the passphrase under the note's row, and
   * locking again, which closes its tabs and drops its text from the corpus.
   */
  const locks = useLocks({
    vaultPath: vault.vaultPath,
    minutes: settings.lockMinutes,
    front: focusedNote?.path ?? null,
    onAsk: () => {
      closeSearch()
      creating.cancel()
      setNamingAction(null)
    },
    onOpen: openNote,
    onLocked: (paths) => {
      setWs((current) => paths.reduce(closeNotesUnder, current))
      if (liveText.current && paths.includes(liveText.current.path)) liveText.current = null
    },
    flush: buffers.flushPendingSave,
    setError,
  })

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  /**
   * ⌘⇧O: today's note, opened through `openNote` like any row,
   * so the file is read before the switch.
   */
  const openDay = (day?: string) =>
    vault.mutate(
      (v) => ensureDailyNote(v, settings.dailyFolder, day),
      async ({ file, created }) => {
        // A new note is given its icon once, when it is made.
        if (created) await inheritIcon(file)
        await openNote(file)
      }
    )
  const openToday = () => openDay()
  /**
   * Calendar sync: each feed's events for the days shown, written into those days'
   * notes as `#event` lines. The tag's structure is read from disk at that moment,
   * since the pane's copy may not be loaded yet. A new day note gets its folder's
   * icon. Changed notes are patched into the corpus and read again by open editors.
   */
  async function syncCalendar() {
    if (!vault.vaultPath) return
    const declared = readEntries((await readConfigFile(vault.vaultPath, TAGS_FILE)) ?? '')
    if (!declared) throw new Error(`${TAGS_FILE} could not be read as JSON, so the calendar was left alone.`)
    if (!declared[EVENT]) await tagStructures.write(EVENT, { properties: EVENT_PROPERTIES })
    const format = {
      properties: declared[EVENT] ? propertiesOf(declared, EVENT) : EVENT_PROPERTIES,
      typeOf: (name: string) => typeOf(propertyTypes.entries, name),
    }
    const today = localDateStamp()
    const from = dayDate(today)
    const to = dayDate(daysAfter(today, settings.calendarDays))
    // Every day, empty or not, so an event that's gone can be
    // removed, and every name a feed goes by, including its own.
    const byDay = new Map(
      Array.from({ length: settings.calendarDays }, (_, at) => [daysAfter(today, at), [] as string[]] as const)
    )
    const sources = new Set<string>()
    for (const { name, url } of settings.calendarFeeds) {
      const feed = parseIcs(await fetchFeed(url))
      // Never an empty name: a line typed by hand with no
      // `source::` belongs to no feed.
      for (const one of [name, feed.name]) if (one) sources.add(one)
      for (const one of occurrences(feed, from, to)) {
        byDay.get(localDateStamp(one.start))?.push(eventLine(format.properties, one, name || feed.name))
      }
    }
    await vault.mutate(
      (v) => syncEvents(v, settings.dailyFolder, format, byDay, sources),
      async ({ changed, created }) => {
        for (const file of created) await inheritIcon(file)
        for (const { file, text } of changed) patch(new Set([file.path]), () => text)
        await Promise.all(changed.map(({ file }) => buffers.reread(file)))
      }
    )
  }
  const calendar = useCalendarSync({
    vaultPath: vault.vaultPath,
    feeds: settings.calendarFeeds.length,
    everyMinutes: settings.calendarMinutes,
    sync: syncCalendar,
    onError: setError,
  })
  useWindowShortcuts({
    openToday,
    combo: settings.shortcuts.openToday,
    disabled: settingsOpen,
    openSettings: () => setSettingsOpen(true),
  })

  /**
   * Shows a row in Finder. A folder note with no file yet can't
   * be shown, and that is reported, not swallowed.
   */
  const handleReveal = (absolutePath: string) =>
    void revealInFinder(absolutePath).catch((err: unknown) => setError(String(err)))

  /**
   * A clicked link. The editor sends the raw target and whether
   * it was `[[…]]`; resolving it needs the note index.
   */
  async function openLinkTarget(target: string, wiki: boolean) {
    const from = focusedNote?.path ?? ''
    const resolved = resolveTarget(
      wiki ? { label: target, target, start: 0, end: 0, wiki: true } : target,
      from,
      noteIndex
    )
    if (resolved.kind === 'note') {
      void openNote(resolved.note)
      return
    }
    // A link that isn't a note goes to the OS. Rust checks the
    // scheme (http, https, mailto) and refuses anything else.
    if (resolved.kind === 'external') {
      void openExternal(resolved.target).catch((err: unknown) => setError(String(err)))
      return
    }
    // A link to a note that doesn't exist yet creates it, as in Obsidian.
    if (resolved.kind !== 'new' || !vault.vaultPath) return
    const slash = resolved.path.lastIndexOf('/')
    const parent = slash === -1 ? '' : resolved.path.slice(0, slash)
    const name = noteName(slash === -1 ? resolved.path : resolved.path.slice(slash + 1))
    // Through `mutate`, so the new note is in the tree before it
    // opens. Folders named in the target are created as nested notes.
    await vault.mutate(
      (v) => createNote(v, parent, name),
      async (created) => {
        await endowNote(created)
        await openNote(created)
      }
    )
  }

  /** A graph node was clicked. */
  function selectGraphNode(node: GraphNode) {
    const file = noteIndex.byKey.get(node.id)
    /**
     * A node for a note that isn't written yet isn't in this map, so the click
     * does nothing. Creating a note from the graph shouldn't happen silently.
     */
    if (file) void openNote(file)
  }

  /** Moving, renaming and deleting, and what each one updates (see the hook). */
  const fileOps = useRelocation({
    vault,
    buffer: buffers,
    notes,
    noteIndex,
    setError,
    // A move updates tabs by name; the buffers follow the text.
    onMoved: {
      file: (was, moved) => setWs((current) => followFileTabs(current, was, moved)),
      folder: (oldPrefix, newPrefix, moves) =>
        setWs((current) =>
          followFolderTabs(current, oldPrefix, newPrefix, moves, vault.vaultPath ?? '')
        ),
    },
  })

  /**
   * Renames the open note from its title. A nested note is its
   * folder, so renaming it renames the folder, as the tree does.
   */
  const renameNote = (file: VaultFile, name: string) => {
    const folder = folderWithNote(vault.root, file.path)
    return folder ? fileOps.renameFolder(folder, name) : fileOps.renameFile(file, name)
  }

  /** Opens a folder's note, whether or not its file exists yet. */
  function handleOpenFolderNote(folder: VaultFolder) {
    void openNote(folderNoteRef(folder))
  }

  /** The new-note field under a row. Opening it closes the other fields. */
  const creating = useInlineCreate({
    vault,
    openNote,
    onCreated: endowNote,
    onConvert: convertNote,
    onStart: () => {
      closeSearch()
      setNamingAction(null)
    },
    setError,
  })

  /**
   * What every new note is given, wherever it was made: its `path::`, and its
   * folder's icon when icons pass down. A note that already has an icon keeps it.
   */
  async function endowNote(file: VaultFile) {
    fileOps.sayUnread(await writePathProperty([file]))
    await inheritIcon(file)
  }

  /**
   * Just the icon, for today's note: a `path::` at the top of a
   * page made for you every day would be noise.
   */
  /**
   * Rewrites a timeline entry's line in place. Through `mutate`, so
   * pending typing is saved first and open buffers are read again.
   */
  async function editEntry(entry: TimelineEntry, text: string) {
    await vault.mutate(
      async () => {
        const next = withEditedEntry(await readVaultFile(entry.note), entry, text)
        if (next === null) throw new Error(`${entry.note.name} changed since the timeline read it; the entry was not written.`)
        await writeVaultFile(entry.note, next)
        return next
      },
      async (next) => {
        patch(new Set([entry.note.path]), () => next)
        await buffers.reread(entry.note)
      }
    )
  }

  /**
   * Files a new timeline entry in today's note (made if needed),
   * where `withNewEntry` puts it. It is filed as typed: without
   * a time it is a line of the note, not a timeline entry.
   */
  async function addEntry(text: string) {
    await vault.mutate(
      async (v) => {
        const { file, created } = await ensureDailyNote(v, settings.dailyFolder)
        const next = withNewEntry(file, await readVaultFile(file), text, ' '.repeat(settings.indentWidth))
        await writeVaultFile(file, next)
        return { file, created, next }
      },
      async ({ file, created, next }) => {
        patch(new Set([file.path]), () => next)
        if (created) await inheritIcon(file)
        await buffers.reread(file)
      }
    )
  }

  async function inheritIcon(file: VaultFile) {
    if (!settings.inheritIcons || !vault.vaultPath) return
    const inherited = await folderIcon(vault.vaultPath, file.path)
    if (!inherited) return
    // A note that already has an icon keeps it.
    if (readProperty(await readVaultFile(file).catch(() => ''), APP_PROPERTIES.icon)) return
    await writeNoteProperty(file, APP_PROPERTIES.icon, inherited)
    // Redraw the tree now rather than on the next vault read.
    patch(new Set([file.path]), (raw) => withProperty(raw, APP_PROPERTIES.icon, inherited))
  }

  /**
   * Giving a note children turns it into a folder. Its buffer,
   * its tab and its `path::` all follow the new path.
   */
  async function convertNote(file: VaultFile, vaultPath: string): Promise<VaultFile> {
    const moved = await convertToNested(file, vaultPath)
    buffers.followFile(file.path, moved)
    setWs((current) => followFileTabs(current, file.path, moved))
    fileOps.sayUnread(await writePathProperty([moved]))
    return moved
  }

  /** Files and notes dropped onto the tree (see `useDrops`). */
  const { importFiles, importFilesInside, adoptFile, adoptFolder } = useDrops({
    vault,
    convertNote,
    relocateFile: fileOps.relocateFile,
    relocateFolder: fileOps.relocateFolder,
    setError,
  })

  /**
   * The tree's root as a drop target, so a note dragged out of a
   * folder can land at the top. `''` is the root's path.
   */
  const rootDrop = useDropTarget('', fileOps.moveFile, fileOps.moveFolder, importFiles)

  /**
   * Everything a tree needs except the folder it draws. The left pane
   * and a note's Inside section share it, so their rows behave the same.
   */
  const treeProps = {
    create: creating.create,
    unlock: locks.unlock,
    selectedPath: locks.unlock?.path ?? focusedNote?.path ?? null,
    openFolders: folders.open,
    onToggleFolder: folders.toggle,
    picked: picked.paths,
    onSelectFile: selectFile,
    onDeletePicked: () => {
      // Read the files from the tree, not the picked paths: a
      // picked path may be gone after a pull.
      if (!vault.root) return
      const files = existingNotesIn(vault.root).filter((file) => picked.paths.has(file.path))
      if (files.length > 0) void fileOps.deleteFiles(files)
    },
    icons,
    onSetFileIcon: setFileIcon,
    onSetFolderIcon: setFolderIcon,
    onSelectFolderNote: handleOpenFolderNote,
    onNewNote: creating.start,
    onNewNoteInside: creating.startInside,
    onMoveFile: fileOps.moveFile,
    onMoveFolder: fileOps.moveFolder,
    onImportFiles: importFiles,
    onImportFilesInside: importFilesInside,
    onAdoptFile: adoptFile,
    onAdoptFolder: adoptFolder,
    onRenameFile: fileOps.renameFile,
    onRenameFolder: fileOps.renameFolder,
    onDeleteFile: fileOps.deleteFile,
    onDeleteFolder: fileOps.deleteFolder,
    onReveal: handleReveal,
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Rendered in both branches, so ⌘, works before a vault is open.
  const panel = settingsOpen && (
    <SettingsPanel
      settings={settings}
      onChange={changeSettings}
      onClose={() => setSettingsOpen(false)}
      sync={sync}
      initialSection={settingsSection}
    />
  )

  if (!vault.vaultPath || !vault.root) {
    return (
      <div className="app app-empty">
        <div className="welcome">
          <h1>Journeys</h1>
          {onAndroid ? (
            <p>Download your vault from GitHub. It stays yours — plain text, synced with git.</p>
          ) : (
            <>
              <p>Choose a folder of markdown files. They stay yours — plain text, edited in place.</p>
              <button className="primary" onClick={() => void vault.pickVault()}>
                Open folder…
              </button>
            </>
          )}
          <CloneVault onOpened={(path) => void vault.loadVault(path)} onError={setError} />
          {log.said && <p className="welcome-error">{log.said.text}</p>}
        </div>
        {panel}
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar" style={{ width: sidebarWidth }}>
        <header className="sidebar-header">
          <button
            className="vault-name"
            onClick={() => void vault.pickVault()}
            title={vault.vaultPath}
          >
            {vault.root.name}
          </button>
        </header>
        {actionMenu}
        {/* Three sections, Notes, Actions and Applications, each with its own
            controls on its heading. Each section decides what its search means. */}
        <div className="sidebar-body">
          <SidebarSection
            name="Notes"
            open={folders.open.has('section:notes')}
            onToggle={() => folders.toggle('section:notes', folders.open.has('section:notes'))}
            list={{ ...rootDrop.handlers, className: rootDrop.over ? 'drag-over' : undefined }}
            actions={
              <>
                {/* Already open: nothing to do. The field closes on blur,
                    so preventDefault on mousedown keeps the keyboard in it. */}
                <button
                  aria-label="Search in notes"
                  aria-pressed={searching === 'notes'}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => searching !== 'notes' && openSearch('notes')}
                >
                  <SearchIcon />
                </button>
                <button aria-label="Collapse all notes" onClick={() => folders.setAll(folderPaths, false)}>
                  <FoldAllIcon collapse />
                </button>
                <button aria-label="Expand all notes" onClick={() => folders.setAll(folderPaths, true)}>
                  <FoldAllIcon collapse={false} />
                </button>
                <button
                  aria-label="New note"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => creating.start('')}
                >
                  <PlusIcon />
                </button>
                {/* A note is locked from the moment it is made or never, so this is the
                    only way in. The note is made at the top and can be moved after. */}
                <button
                  aria-label="New locked note"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={creating.startLocked}
                >
                  <NoteIcon icon="lock" />
                </button>
              </>
            }
          >
            {searching === 'notes' && (
              <NoteSearch
                what="notes"
                query={query}
                hits={hits}
                onQuery={setQuery}
                onOpen={(file) => void openNote(file)}
                onClose={closeSearch}
              />
            )}
            {/* `where`: this is the left pane's tree. A name being
                typed belongs to the tree whose `+` was pressed. */}
            {(searching !== 'notes' || query.trim() === '') && (
              <FolderTree folder={vault.root} depth={1} where="tree" {...treeProps} />
            )}
          </SidebarSection>
          <SidebarSection
            name="Actions"
            open={folders.open.has('section:actions')}
            onToggle={() => folders.toggle('section:actions', folders.open.has('section:actions'))}
            actions={
              <>
                <button
                  aria-label="Search in actions"
                  aria-pressed={searching === 'actions'}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => searching !== 'actions' && openSearch('actions')}
                >
                  <SearchIcon />
                </button>
                <button aria-label="Collapse all actions" onClick={() => folders.setAll(groupPaths, false)}>
                  <FoldAllIcon collapse />
                </button>
                <button aria-label="Expand all actions" onClick={() => folders.setAll(groupPaths, true)}>
                  <FoldAllIcon collapse={false} />
                </button>
                <button
                  aria-label="New action"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => !namingAction && openActionMenu(event)}
                >
                  <PlusIcon />
                </button>
              </>
            }
          >
            {searching === 'actions' && (
              <NoteSearch
                what="actions"
                query={query}
                hits={null}
                onQuery={setQuery}
                onOpen={(file) => void openNote(file)}
                onClose={closeSearch}
              />
            )}
            <ActionsPane
              vaultPath={vault.vaultPath}
              depth={1}
              kinds={kinds}
              selectedPath={
                active?.kind === 'settingsFile'
                  ? `${CONFIG_DIR}/${SETTINGS_FILE}`
                  : (focusedNote?.path ?? null)
              }
              onSelect={openConfigFile}
              onError={setError}
              onView={view}
              viewing={
                active?.kind === 'property' ||
                active?.kind === 'tag'
                  ? { kind: active.kind, name: active.name }
                  : null
              }
              declared={actionsDeclared}
              openGroups={folders.open}
              onToggleGroup={folders.toggle}
              onNew={startNamingAction}
              query={searching === 'actions' ? query : ''}
              used={actionsUsed}
              revision={actionsRevision}
              naming={namingAction}
              typed={actionName}
              onTyped={setActionName}
              onCommit={() => void commitAction()}
              onCancel={() => setNamingAction(null)}
            />
          </SidebarSection>
          {/* The app's own views. The Graph row toggles: pressed
              while the graph shows, it goes back to the note. */}
          <SidebarSection
            name="Applications"
            open={folders.open.has('section:applications')}
            onToggle={() =>
              folders.toggle('section:applications', folders.open.has('section:applications'))
            }
          >
            <li style={{ paddingLeft: stepIn(1) }}>
              <NoteRow
                icon={<RowIcon><GraphIcon /></RowIcon>}
                name="Graph"
                className={active?.kind === 'graph' ? 'selected' : undefined}
                aria-label={active?.kind === 'graph' ? 'Close the note graph' : 'Open the note graph'}
                aria-pressed={active?.kind === 'graph'}
                onClick={() => setWs((current) => toggleTab(current, { kind: 'graph' }))}
              />
            </li>
            {(
              [
                // The coming days, read from `#event` lines.
                { kind: 'calendar', name: 'Calendar', icon: 'calendar', count: 0 },
                // The daily notes by time, today at the bottom.
                { kind: 'timeline', name: 'Timeline', icon: 'clock', count: 0 },
                // Every message the app has shown in this window.
                { kind: 'log', name: 'Log', icon: 'inbox', count: log.items.length },
              ] as const
            ).map(({ kind, name, icon, count }) => (
              <li key={kind} style={{ paddingLeft: stepIn(1) }}>
                <NoteRow
                  icon={<RowIcon icon={icon} />}
                  name={name}
                  className={active?.kind === kind ? 'selected' : undefined}
                  aria-label={name}
                  aria-pressed={active?.kind === kind}
                  trailing={count > 0 ? <span className="row-count">{count}</span> : undefined}
                  onClick={() => setWs((current) => openTab(current, { kind }))}
                />
              </li>
            ))}
            {/* Sync status in one line; opens its settings. */}
            <li style={{ paddingLeft: stepIn(1) }}>
              <NoteRow
                icon={<RowIcon icon="globe" />}
                name="Sync"
                aria-label="Sync"
                trailing={syncSentence ? <span className="row-count">{syncSentence}</span> : undefined}
                onClick={() => {
                  setSettingsSection('sync')
                  setSettingsOpen(true)
                }}
              />
            </li>
            {/* A shell in the vault folder. The row goes back to the shell
                that is open; a second one is on its right-click menu. */}
            {!onAndroid && (
              <li style={{ paddingLeft: stepIn(1) }}>
                <NoteRow
                  icon={<RowIcon><TerminalIcon /></RowIcon>}
                  name="Terminal"
                  aria-label="Terminal"
                  aria-pressed={active?.kind === 'terminal'}
                  onClick={() => setWs((current) => openTerminal(current))}
                  onContextMenu={openTerminalMenu}
                />
                {terminalMenu}
              </li>
            )}
            <li style={{ paddingLeft: stepIn(1) }}>
              <NoteRow
                icon={<RowIcon><SettingsIcon /></RowIcon>}
                name="Settings"
                aria-label="Settings"
                onClick={() => {
                  setSettingsSection('appearance')
                  setSettingsOpen(true)
                }}
              />
            </li>
          </SidebarSection>
        </div>
      </aside>

      <Resizer
        width={sidebarWidth}
        onWidth={setSidebarWidth}
        min={SIDEBAR_WIDTH.min}
        max={SIDEBAR_WIDTH.max}
        reset={SIDEBAR_WIDTH.start}
        label="Resize the sidebar"
      />

      <main className="workspace">
        {log.shown && (
          <div className="banner" role="alert">
            <span>{log.shown.text}</span>
            <button aria-label="Dismiss" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}
        <WorkspaceView
          ws={ws}
          onChange={setWs}
          onEndSession={(session) => void endTerminal(session, vault.vaultPath!)}
          empty={
            <p className="viewer-empty">Choose a note on the left, or press ⌘⇧O for today’s page.</p>
          }
          render={(tab, isActive) => {
            switch (tab.kind) {
              case 'note':
                return (
                  <NotePane
                    id={tab.id}
                    file={tab.file}
                    active={isActive}
                    vaultPath={vault.vaultPath!}
                    refresh={vault.refresh}
                    setError={setError}
                    buffers={buffers}
                    liveText={liveText}
                    settings={settings}
                    settingsOpen={settingsOpen}
                    notes={notes}
                    propertyTypes={propertyTypes.entries}
                    tagStructures={tagStructures.entries}
                    root={vault.root}
                    icons={icons}
                    backlinks={backlinks}
                    treeProps={treeProps}
                    onOpen={(file) => void openNote(file)}
                    onOpenLink={(target, wiki) => void openLinkTarget(target, wiki)}
                    onOpenTag={(tag) => view('tag', tag)}
                    onRename={(file, name) => void renameNote(file, name)}
                    onLock={(file) => void locks.lockNotes([file.path])}
                    onTyped={typed}
                  />
                )
              case 'file':
                return <FileView file={tab.file} onReveal={handleReveal} />
              case 'settingsFile':
                return (
                  <SettingsFile vaultPath={vault.vaultPath!} settings={settings} onChange={changeSettings} />
                )
              case 'property':
                return (
                  <PropertyView
                    name={tab.name}
                    values={propertyValues(tab.name)}
                    icons={icons}
                    loading={reading}
                    type={typeOf(propertyTypes.entries, tab.name)}
                    appOwned={isAppProperty(tab.name)}
                    onType={(type) => void setPropertyType(tab.name, type)}
                    onOpen={(file) => void openNote(file)}
                    onOpenLink={(target) => void openLinkTarget(target, true)}
                  />
                )
              case 'tag':
                return (
                  <TagView
                    name={tab.name}
                    collected={collectTag(tab.name)}
                    properties={propertiesOf(tagStructures.entries, tab.name)}
                    view={viewOf(tagStructures.entries, tab.name)}
                    onView={(next) => void tagStructures.write(tab.name.toLowerCase(), { view: next })}
                    typeOf={(property) => typeOf(propertyTypes.entries, property)}
                    icons={icons}
                    loading={reading}
                    onProperties={(next) => void tagStructures.write(tab.name.toLowerCase(), { properties: next })}
                    onError={setError}
                    onOpenProperty={(property) => view('property', property)}
                    onOpen={(file) => void openNote(file)}
                    onOpenLink={(target) => void openLinkTarget(target, true)}
                  />
                )
              case 'timeline':
                return (
                  <TimelineView
                    days={timeline}
                    tables={tablesOf(tagStructures.entries)}
                    typeOf={(name) => typeOf(propertyTypes.entries, name)}
                    typing={{
                      notes,
                      propertyTypes: propertyTypes.entries,
                      tagStructures: tagStructures.entries,
                      // Off while the settings are open, as in a
                      // note: the shortcut may be being changed.
                      insertTimeCombo: settingsOpen ? null : settings.shortcuts.insertTime,
                    }}
                    onEdit={(entry, text) => void editEntry(entry, text)}
                    onAdd={(text) => void addEntry(text)}
                    onOpen={(file) => void openNote(file)}
                    onOpenLink={(target) => void openLinkTarget(target, true)}
                    onOpenTag={(tag) => view('tag', tag)}
                  />
                )
              case 'log':
                return <LogView items={log.items} />
              case 'calendar':
                return (
                  <CalendarView
                    collected={collectTag(EVENT)}
                    propertyTypes={propertyTypes.entries}
                    dailyFolder={settings.dailyFolder}
                    days={settings.calendarDays}
                    feeds={settings.calendarFeeds.length}
                    syncing={calendar.syncing}
                    loading={reading}
                    onSync={() => void calendar.now(true)}
                    onOpen={(file) => void openNote(file)}
                    onOpenDay={(day) => void openDay(day)}
                  />
                )
              case 'terminal':
                return (
                  <Suspense fallback={null}>
                    <TerminalPane session={tab.session} cwd={vault.vaultPath!} />
                  </Suspense>
                )
              case 'graph':
                return (
                  <GraphView
                    graph={graph}
                    loading={reading}
                    currentId={lastNote.current ? pathKey(lastNote.current.path) : null}
                    shows={settings.graphShows}
                    onShows={(graphShows) => changeSettings({ ...settings, graphShows })}
                    onSelect={selectGraphNode}
                  />
                )
            }
          }}
        />
      </main>

      {panel}
    </div>
  )
}

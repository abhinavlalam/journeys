import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  CONFIG_DIR,
  convertToNested,
  createNote,
  ensureDailyNote,
  folderIcon,
  readVaultFile,
  safeName,
  vaultFileRef,
  writeNoteProperty,
  writePathProperty,
} from './vault'
import { folderNoteRef, isTextFile, knownPath, noteName, SETTINGS_FILE } from './vaultModel'
import { FileView } from './FileView'
import type { VaultFile, VaultFolder } from './vaultModel'
import { FolderTree, useDropTarget } from './FolderTree'
import { ActionsPane } from './ActionsPane'
import { BUILT_IN_KINDS, creatable, declares, createAction, groupKey, type ViewKind } from './actionKinds'
import { SettingsFile } from './SettingsFile'
import { NoteSearch } from './NoteSearch'
import { searchNotes } from './search'
import { openExternal, revealInFinder } from './reveal'
import { APP_PROPERTIES, readProperty, withProperty } from './properties'
import { GraphView } from './GraphView'
import { CollectionView } from './CollectionView'
import { PropertyView } from './PropertyView'
import { TagView } from './TagView'
import { CalendarView } from './CalendarView'
import { EVENT, EVENT_STRUCTURE, eventLine } from './calendar'
import { syncEvents } from './calendarSync'
import { fetchFeed } from './calendarFeed'
import { occurrences, parseIcs } from './ics'
import { dayDate, daysAfter, localDateStamp } from './clock'
import { useCollections } from './useCollections'
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
/** Loaded when a terminal opens, not with the app: xterm is the largest thing in
 *  the bundle and touches `window` as it loads, and most launches never open one. */
const TerminalPane = lazy(() => import('./TerminalPane').then((m) => ({ default: m.TerminalPane })))
import { SidebarSection } from './SidebarSection'
import { stepIn, NoteRow, RowIcon } from './rows'

const SIDEBAR_KEY = 'journeys:sidebar-width'
/** The left pane's sections, and the keys their open state is kept under — in
 *  `useFolderOpenState`'s own set, so a section shut by hand stays shut across
 *  launches like a folder does. Open to begin with, unlike a folder. */
const SECTIONS = ['section:notes', 'section:actions', 'section:applications'] as const

/**
 * How long the typing-to-a-view refresh waits, in milliseconds.
 *
 * A keystroke while a collection's page is open beside the note has to reach that
 * page, and every keystroke re-rendering the whole shell is what a throttle is for:
 * four times a second is faster than anyone reads a table and cheap enough to be
 * invisible. It was `250` written into the timer with the reason in a comment
 * elsewhere.
 */
const LIVE_REFRESH_MS = 250
/** The left pane's width, in px: where it starts, and how far the resizer takes it. */
const SIDEBAR_WIDTH = { start: 260, min: 180, max: 520 }

export default function App() {
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SectionId>('appearance')
  /** Which section's search field is open — Notes reads a note's text, Actions its
      rows' names — and what is in it. Empty is not closed: the field can be open
      and waiting, which is the state you type the first letter into. */
  const [searching, setSearching] = useState<'notes' | 'actions' | null>(null)
  const [query, setQuery] = useState('')
  /**
   * **What stands in the reading pane**: groups of tabs, split into panes, one
   * group focused. It was one `pane` flag naming what replaced the editor — the
   * graph, a collection, the settings file — and it is a tree now, whose every
   * operation is a pure function in `workspace.ts`. Nothing here decides what
   * "open" means; it asks.
   */
  const [ws, setWs] = useState<Workspace>(emptyWorkspace)
  const active = activeTab(ws)
  /** The note the focused group shows, if it shows one: what the tree marks, what
   *  the graph centres on, whose text `liveText` is about. */
  const focusedNote = active?.kind === 'note' ? active.file : null
  /** A view derived from the corpus is on screen in *any* pane — beside the note
   *  being typed into, as likely as not — so its text has to follow the typing. */
  const viewVisible = groups(ws.layout).some((group) => {
    const shown = group.tabs[group.active]
    return (
      shown?.kind === 'graph' ||
      shown?.kind === 'collection' ||
      shown?.kind === 'property' ||
      shown?.kind === 'tag' ||
      shown?.kind === 'calendar'
    )
  })
  /** Bumped, at most a few times a second, by a keystroke while such a view shows;
   *  `useVaultTexts` re-takes the live text on it. A ref for the throttle, because
   *  the whole shell re-renders on each bump and every keystroke would be too many. */
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
  /** Opens a collection's, a property's or a tag's page: the same act from a row in
   *  the pane, a keyword or a `#tag` pressed in a note, or the `+` that has just
   *  declared one. */
  const view = (kind: ViewKind, name: string) => open({ kind, name })

  /**
   * A file picked in the Actions pane. **`.config/settings.json` is the one that
   * is not just a file**: saving it reconfigures the app, so it opens in the tab
   * that has a Save rather than in one that writes as you type.
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
   * The vault flushes the open notes before it changes anything on disk, and empties
   * the workspace when another vault is picked; the buffers it flushes belong to
   * the note panes, which register with `buffers` as they mount. One direction has
   * to arrive late, and this is it — filled in the render body, which finishes
   * before any effect or event handler can call through it.
   */
  const bufferOps = useRef<VaultBufferOps>({ flush: async () => {}, close: () => {} })
  const vault = useVault(bufferOps, setError)
  /** Every open note's buffer, addressed as one — see `useBuffers`. A delete
   *  closes the tabs under it as it drops their queued writes. */
  const buffers = useBuffers({
    onDeleted: (prefix) => {
      setWs((current) => closeNotesUnder(current, prefix))
      // The one place a pick is dropped, so every way of deleting is covered by it.
      setPicked((current) => withoutUnder(current, prefix))
    },
  })
  bufferOps.current = { flush: buffers.flushPendingSave, close: () => setWs(emptyWorkspace()) }

  const folders = useFolderOpenState(vault.vaultPath, SECTIONS)

  /**
   * **The notes picked in the left pane to act on together** — see `picking.ts`.
   * ⌘-click adds one and ⇧-click takes a range, and neither opens anything; a
   * plain click opens the note and makes it the whole set.
   */
  const [picked, setPicked] = useState(nothingPicked)

  // Another vault is another set of rows to have picked.
  useEffect(() => setPicked(nothingPicked), [vault.vaultPath])
  /**
   * The open note's text as the *editor* has it.
   *
   * `buffer.body` is not that. The buffer hands the editor `initialMarkdown` once
   * and keys it on the note's path, so `body` is the text as of the last open or
   * disk re-read — never the keystroke. Autosave waits 800 ms, so a link typed and
   * then followed straight into the graph would be on neither the disk nor `body`.
   * This is tapped on the way past, and it is a **ref**: a state update here would
   * re-render the whole shell on every keypress, which is exactly what keying the
   * editor on the path was for.
   *
   * The path is stored with the text so a stale tap cannot be applied to the wrong
   * note. Once another note is opened this text is on disk anyway — `openNote`
   * flushes first — and the guard drops it.
   */
  const liveText = useRef<{ path: string; text: string } | null>(null)

  /** The vault's own `.config/settings.json`, and `localStorage` for the window
      before a vault is open. `useSettings` owns both. Above the vault read because
      the graph's hidden folders come from here. */
  const { settings, changeSettings } = useSettings(vault.vaultPath, setError)
  /**
   * The vault's sync: a round is flush, commit, pull, push, on a timer and on focus.
   * What a pull changes on disk is re-read the way any outside write is — the tree
   * walked again (which re-reads the corpus) and every open buffer of a changed
   * file told, the buffer declining while a save of its own is queued.
   */
  const sync = useSync({
    vaultPath: vault.vaultPath,
    everySeconds: settings.syncSeconds,
    flush: buffers.flushPendingSave,
    onPulled: async ({ changed }) => {
      if (!vault.vaultPath) return
      await vault.refresh(vault.vaultPath)
      for (const path of changed) await buffers.reread(vaultFileRef(vault.vaultPath, path))
    },
    onCommitted: async () => {
      if (vault.vaultPath) await vault.refresh(vault.vaultPath)
    },
    onError: setError,
  })
  const syncSentence = syncWord(sync)

  /**
   * **One read of the vault, and everything derived from it** — the notes, their
   * index, the icons, the graph, and what links here. `liveText` is the one input
   * that is not the disk's: the open note as the editor has it.
   */
  const {
    notes,
    noteIndex,
    icons,
    properties,
    collections: keywordsInUse,
    propertyValues,
    collect,
    collectTag,
    tags,
    graph,
    backlinks,
    reading,
    texts,
    patch,
  } = useVaultTexts({
    root: vault.root,
    graphHides: settings.graphHides,
    vaultPath: vault.vaultPath,
    openPath: focusedNote?.path ?? null,
    // A view derived from the corpus is open, so the open note's *typed* text is
    // wanted rather than the disk's: a `--expense` line written seconds ago has to
    // be in the collection it names.
    viewOpen: viewVisible,
    liveVersion,
    liveText,
    onError: setError,
  })

  /**
   * A folder's icon, and — when the setting is on — the notes inside it.
   *
   * Written into each note rather than derived while drawing the tree: the icon is
   * a property of the note, so it has to be *in* the note, or it is a thing this
   * app knows and the file does not. `claimsIcon` says which notes a set claims;
   * `existingNotesIn` is what keeps a bulk write from creating the folder notes
   * that have not been typed into yet.
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
    // Optimistic, so the tree redraws on the click rather than after the write —
    // and made by the *same* function the write uses, to the same text, so the
    // guess cannot drift from what lands on disk. Writing a property does not
    // change the tree, so no re-read follows to correct it.
    patch(new Set(files.map((file) => file.path)), (text) =>
      withProperty(text, APP_PROPERTIES.icon, icon)
    )
    // `mutate` flushes the pending write first: one of these may be the note that
    // is open, and its buffer holds text a write behind its back would strand. The
    // re-read that follows is what puts the new property in the buffer.
    await vault.mutate(
      async () => {
        // Together, not one after another: a folder that hands its icon down can
        // be twenty notes, and each write is a read and a write over IPC. They are
        // twenty different files, so there is no order to keep.
        await Promise.all(files.map((file) => writeNoteProperty(file, APP_PROPERTIES.icon, icon)))
      },
      // The re-read is what puts the new property in an open note's buffer.
      () => Promise.all(files.map((file) => buffers.reread(file)))
    )
  }


  /** Bumped when the app writes one of a kind's files, so the lists come straight
      back rather than waiting for the next window focus. */
  const [actionsRevision, actionWritten] = useReducer((n: number) => n + 1, 0)
  const kinds = BUILT_IN_KINDS

  /** The order a ⇧-click's range runs in: the rows the tree is showing, in the
      order it draws them. */
  const pickOrder = useMemo(
    () => visibleFiles(vault.root, folders.open).map((file) => file.path),
    [vault.root, folders.open]
  )

  /** A click on a leaf row: one gesture opens, the other two pick. */
  function selectFile(file: VaultFile, mode: PickMode) {
    setPicked((current) => pick(current, file.path, mode, pickOrder))
    if (mode === 'only') void openNote(file)
  }

  /** Every folder, for the one control that shuts or opens all of them at once. */
  const folderPaths = useMemo(() => (vault.root ? collectFolders(vault.root) : []), [vault.root])
  /** What the Actions section's pair acts on: its groups. Same `useFolderOpenState`
      as the tree's folders, so a group's chevron and the pair are one mechanism. */
  const groupPaths = kinds.map(groupKey)


  /** The matches, over the same corpus the graph and the backlinks are built from.
      `texts` and not `corpus`: the note being typed into is on the disk a moment
      later anyway, and a hit that appears and disappears as you type in another
      pane is worse than one that is a second old. */
  const hits = useMemo(() => searchNotes(texts ?? [], query), [texts, query])

  /**
   * The action being named, and the name so far — `App`'s, for the same reason the
   * tree's inline create is: the `+` that starts it is in the header and the field
   * that finishes it is in the pane.
   */
  const [namingAction, setNamingAction] = useState<string | null>(null)
  const [actionName, setActionName] = useState('')

  /**
   * What each collection declares, and the one place that writes it — the pane's
   * rows, the collection's own view and the editor's `--` popup all read it.
   */
  const collections = useCollections({
    vaultPath: vault.vaultPath,
    revision: actionsRevision,
    inUse: keywordsInUse,
    onWritten: actionWritten,
    onError: setError,
  })

  /** The Terminal row's menu: a second shell, under the next free session name. */
  const [terminalMenu, openTerminalMenu] = useContextMenu(() => [
    {
      label: 'New terminal',
      onSelect: () => setWs((current) => openTab(current, { kind: 'terminal', session: terminalName(current) })),
    },
  ])

  const [actionMenu, openActionMenu] = useContextMenu(() =>
    // What can be *made*: `settings.json` and the notes beside it arrive with the
    // app, so Config is not one of the answers to "a new what?".
    kinds.filter(creatable).map((kind) => ({
      label: kind.singular,
      icon: <NoteIcon icon={kind.icon} />,
      onSelect: () => startNamingAction(kind.key),
    }))
  )

  /** Starts naming one of a kind — from the rail's `+` by way of its menu, or from
   *  that kind's own `+` on its group row, which needs no menu because it knows. */
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

    // **A declaring kind's `+` writes an entry, not a file**, and lands on the page
    // where the rest of it is read: a collection's structure goes into
    // `collections.json` with no shape yet.
    if (declares(type)) {
      const name = safeName(typed)
      if (!name) return
      await collections.declare(name, '')
      view('collection', name)
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
   * **One field at a time, and the buttons are not toggles.**
   *
   * Search and `+` open the same kind of box in the same place, so two of them at
   * once is two answers to "what is the keyboard for" — the search bar with a name
   * field stacked under it, which is what clicking one after the other used to
   * give. Each of these three opens its own and shuts the others; leaving a field
   * (Escape, or a click anywhere outside it) shuts it, so there is no mode to be
   * left in.
   */
  function openSearch(which: 'notes' | 'actions') {
    creating.cancel()
    setNamingAction(null)
    setSearching(which)
  }

  /**
   * Opening a note, wherever the click came from: its tab, or a new one of the kind
   * the file is. The tab's `NotePane` reads the bytes before its editor mounts —
   * CLAUDE.md's first trap under Notes, because setting the file first makes the
   * next keystroke save the previous note's text into the new one. That corrupted
   * a file.
   */
  function openNote(file: VaultFile) {
    // **Opening a note opens the folders above it**, by writing them into the one
    // set the tree reads. It used to be derived per row from the selection, which
    // meant a folder could be open *because* a note in it was open — so clicking
    // another folder moved the selection and shut the first one.
    folders.reveal(knownPath(file.path))
    // **An encrypted note opens by being unlocked** — see `useLocks`.
    if (locks.asks(file)) return Promise.resolve()
    // **A tab of the kind the file is.** A note tab owns a buffer and an editor,
    // which is right for anything the app reads as text and wrong for a PDF: a
    // buffer over one is a file the first keystroke corrupts. `FileView` shows the
    // rest and writes nothing.
    open({ kind: isTextFile(file.path) ? 'note' : 'file', file })
    return Promise.resolve()
  }

  /**
   * **Locked notes**: the passphrase question under the note's row — it shuts the
   * other fields, and the note becomes the tree's selected path, which opens the
   * folders above it — and locking again, which closes the note's tabs and drops
   * the corpus's copy of its text.
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
   * ⌘⇧O: today's daily note, opened through `openNote` like any tree row — so it
   * reads the bytes before switching, which is the whole reason there is one path.
   */
  const openDay = (day?: string) =>
    vault.mutate(
      (v) => ensureDailyNote(v, settings.dailyFolder, day),
      async ({ file, created }) => {
        // A day already on disk is a note somebody has been writing in: what a new
        // note is given is given once.
        if (created) await inheritIcon(file)
        await openNote(file)
      }
    )
  const openToday = () => openDay()
  /**
   * **Sync**: every feed in `calendarFeeds`, read for the days the calendar shows,
   * written into those days' notes as `--event` lines. The `event` collection is
   * declared on the first sync if the vault has not, so the lines are read by the
   * same structure they were written with; after that the structure is the
   * vault's. A day made here is a note born like any other and takes the folder's
   * icon; the notes written are patched into the corpus and re-read by any editor
   * holding one, or the next keystroke would save the text from before the sync.
   */
  async function syncCalendar() {
    if (!vault.vaultPath) return
    const declared = await collections.declarationNow(EVENT)
    const declaration = declared ?? EVENT_STRUCTURE
    if (!declared) await collections.declare(EVENT, declaration)
    const today = localDateStamp()
    const from = dayDate(today)
    const to = dayDate(daysAfter(today, settings.calendarDays))
    // Every day read, the empty ones included, so a line whose event has gone can
    // be taken back; and every name a feed answers to — the one given here and its
    // own, which is what lines written before it was named say.
    const byDay = new Map(
      Array.from({ length: settings.calendarDays }, (_, at) => [daysAfter(today, at), [] as string[]] as const)
    )
    const sources = new Set<string>()
    for (const { name, url } of settings.calendarFeeds) {
      const feed = parseIcs(await fetchFeed(url))
      // Never an empty name: a hand-typed line with no `source::` is nobody's feed.
      for (const one of [name, feed.name]) if (one) sources.add(one)
      for (const one of occurrences(feed, from, to)) {
        byDay.get(localDateStamp(one.start))?.push(eventLine(declaration, one, name || feed.name))
      }
    }
    await vault.mutate(
      (v) => syncEvents(v, settings.dailyFolder, declaration, byDay, sources),
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
   * Show a row where it lives on disk.
   *
   * The failure is reported rather than swallowed: a folder note that has never
   * been typed in has no file yet, and `open -R` refuses a path that is not there.
   * That is a real answer to give someone — and a silent catch here is exactly what
   * the `.config` bug looked like.
   */
  const handleReveal = (absolutePath: string) =>
    void revealInFinder(absolutePath).catch((err: unknown) => setError(String(err)))

  /**
   * A clicked link. The editor hands over the raw target and whether it came from
   * `[[…]]`; resolution is this side's job, because it needs the note index.
   * A target with no note behind it opens nothing — the same answer a link-only
   * graph node gives, and for the same reason: creating a note is a separate act.
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
    // A link that is not a note goes to the OS: a journal is full of pasted URLs,
    // and a link the app draws as a link has to go somewhere when it is clicked.
    // The scheme is vetted in Rust — `http`, `https`, `mailto` — and anything else
    // comes back as an error, which is the honest answer for `[[…]]` pointing at
    // something this app cannot open.
    if (resolved.kind === 'external') {
      void openExternal(resolved.target).catch((err: unknown) => setError(String(err)))
      return
    }
    // A link to a note that is not there yet *makes* it, as Obsidian does. Writing
    // the link was the intention; refusing to follow it is the app arguing with the
    // user.
    if (resolved.kind !== 'new' || !vault.vaultPath) return
    const slash = resolved.path.lastIndexOf('/')
    const parent = slash === -1 ? '' : resolved.path.slice(0, slash)
    const name = noteName(slash === -1 ? resolved.path : resolved.path.slice(slash + 1))
    // Through `mutate`, which flushes the pending write and re-reads the tree, so
    // the new note is in the sidebar before it is opened. A target that names
    // folders — `[[Landmark Plaza/Northwind Office]]` — gets them: `createNote`
    // makes the path above the note, and each folder it makes is a nested note
    // whose own text nobody has typed yet.
    await vault.mutate(
      (v) => createNote(v, parent, name),
      async (created) => {
        await endowNote(created)
        await openNote(created)
      }
    )
  }

  /** A node was clicked. */
  function selectGraphNode(node: GraphNode) {
    const file = noteIndex.byKey.get(node.id)
    /**
     * One check, doing two jobs, and they are the same job: a link-only node —
     * `GraphNode.exists` false — is never in this map, because `buildNoteGraph`
     * derives `exists` from precisely it. So a node the user made before writing
     * the note ("link it anyway, resolve later") has nothing to read and nothing to
     * open, and the click is **inert**. Creating the note from a click on a graph is
     * a decision nobody has taken, and taking it silently would be the wrong way.
     *
     * An earlier version tested `node.exists` here as well. It read as two
     * behaviours and was one; no test could tell the halves apart, because there is
     * nothing to tell.
     */
    if (file) void openNote(file)
  }

  /** Moving, renaming and deleting, with what each drags along — see the hook. */
  const fileOps = useRelocation({
    vault,
    buffer: buffers,
    notes,
    noteIndex,
    setError,
    // The tabs' half of a move: the buffers follow the text, the tabs the name.
    onMoved: {
      file: (was, moved) => setWs((current) => followFileTabs(current, was, moved)),
      folder: (oldPrefix, newPrefix, moves) =>
        setWs((current) =>
          followFolderTabs(current, oldPrefix, newPrefix, moves, vault.vaultPath ?? '')
        ),
    },
  })

  /**
   * **Renaming the open note from its title.**
   *
   * A nested note *is* its folder — `Areas/Northwind/Northwind.md` pairs with
   * `Areas/Northwind/` — so renaming the file alone would leave the folder holding
   * a note of another name, which is a folder with no note and a stray child. The
   * tree renames such a row by renaming the folder, and this is the same act from
   * the other pane: one handler each, and the title picks which.
   */
  const renameNote = (file: VaultFile, name: string) => {
    const folder = folderWithNote(vault.root, file.path)
    return folder ? fileOps.renameFolder(folder, name) : fileOps.renameFile(file, name)
  }

  /** Opens a folder's own note, whether or not it is on disk yet. */
  function handleOpenFolderNote(folder: VaultFolder) {
    void openNote(folderNoteRef(folder))
  }

  /** The new-note field under a row. Opening it shuts the other two fields. */
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
   * **What a note is given the moment it exists**, wherever it was made.
   *
   * Its `path:`, and — when the setting says notes inherit one — the icon of the
   * folder it was made in. Three places make a note: a name typed in the tree, a
   * link followed to one that is not there yet, and ⌘⇧O. They had drifted: only the
   * first wrote `path:`, so a note made by following a link was the one note in the
   * vault that did not know where it was, and **none** of the three inherited an
   * icon — `inheritIcons` was a bulk write at the moment a folder's icon is *set*
   * and nothing after it, so every note made later came out bare. Reported that
   * way, and found from an empty file beside neighbours that all carried a block.
   *
   * The icon is written *into* the note rather than derived while drawing the row,
   * for the reason the setting already works that way: an icon is a property of the
   * note, and a property this app knows and the file does not is not one. A note
   * that already carries one — a declared default — keeps it.
   */
  async function endowNote(file: VaultFile) {
    fileOps.sayUnread(await writePathProperty([file]))
    await inheritIcon(file)
  }

  /**
   * The icon half on its own, for **today's page**: ⌘⇧O makes a note *for* you
   * every day, and a `path:` written into one is the app's words at the top of a
   * page you did not ask it to start — the folder and the name say where it is
   * anyway. The icon is different: it is the folder's, and the point of the setting
   * is that everything in the folder wears it.
   */
  async function inheritIcon(file: VaultFile) {
    if (!settings.inheritIcons || !vault.vaultPath) return
    const inherited = await folderIcon(vault.vaultPath, file.path)
    if (!inherited) return
    // A note that already carries one — a declared default — keeps it.
    if (readProperty(await readVaultFile(file).catch(() => ''), APP_PROPERTIES.icon)) return
    await writeNoteProperty(file, APP_PROPERTIES.icon, inherited)
    // The tree redraws on the write rather than at the next read of the vault.
    patch(new Set([file.path]), (raw) => withProperty(raw, APP_PROPERTIES.icon, inherited))
  }

  /**
   * **Giving a note children turns it into a folder**, and everything holding its
   * old path follows: the buffer that may be editing it, the tab it is open in, and
   * its own `path:`. `useInlineCreate` did the first and the third and not the
   * second, so converting a note that was open left a tab naming a file that no
   * longer existed — found while adding the second caller, which is what a second
   * caller is for.
   */
  async function convertNote(file: VaultFile, vaultPath: string): Promise<VaultFile> {
    const moved = await convertToNested(file, vaultPath)
    buffers.followFile(file.path, moved)
    setWs((current) => followFileTabs(current, file.path, moved))
    fileOps.sayUnread(await writePathProperty([moved]))
    return moved
  }

  /** Files and notes dropped onto the tree — see `useDrops`. */
  const { importFiles, importFilesInside, adoptFile, adoptFolder } = useDrops({
    vault,
    convertNote,
    relocateFile: fileOps.relocateFile,
    relocateFolder: fileOps.relocateFolder,
    setError,
  })

  /**
   * The tree's container is the **root** as a drop target.
   *
   * Every folder row is one; the root had none, so a note dragged out of a folder
   * had nowhere at the top of the vault to land — reported from the running app.
   * `''` is the root's path, which is what `moveFile` and `moveFolder` already
   * take.
   */
  const rootDrop = useDropTarget('', fileOps.moveFile, fileOps.moveFolder, importFiles)

  /**
   * Everything a tree needs but the folder it draws.
   *
   * Two places draw one: the left pane, and the *Inside* section at the end of a
   * nested note. One object, so a row in either behaves the same way — expands the
   * same, takes an icon the same, renames and moves the same — and so a new prop
   * cannot reach one and miss the other.
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
      // Read off the tree, not the set: the set is paths, and a delete needs the
      // files themselves — and a path picked before a pull from Drive may be gone.
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

  // One element, rendered from both branches: ⌘, works before a folder is picked
  // too, and without this the flag would be set with nothing on screen.
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
          {error && <p className="welcome-error">{error}</p>}
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
        {/* **Three sections, each with its controls on its heading.** They were two
            panes behind two icons and one shared row of controls; now Notes,
            Actions and Applications stack, open and shut like folders, and each
            heading shows its own search, collapse, expand and `+` on hover — the
            left pane of the editors the owner named. What a query *means* is the
            section's business: Notes lists the notes that carry it, Actions hides
            the rows that do not. */}
        <div className="sidebar-body">
          <SidebarSection
            name="Notes"
            open={folders.open.has('section:notes')}
            onToggle={() => folders.toggle('section:notes', folders.open.has('section:notes'))}
            list={{ ...rootDrop.handlers, className: rootDrop.over ? 'drag-over' : undefined }}
            actions={
              <>
                {/* **Already open is nothing to do.** These fields close when they
                    lose the keyboard, so a click on the button that opened one used
                    to blur it — closing it — and then reopen it a moment later.
                    `preventDefault` on mousedown keeps the keyboard in the field. */}
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
                {/* **A note is locked or it is not, from the moment it is made** —
                    so this is the one way in, here and not on a folder's row: the
                    note is made at the top and moved where it belongs. */}
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
            {/* `where`: the left pane's tree. A name being typed belongs to the tree
                the `+` was pressed in — see `FolderTreeProps.where`. */}
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
                active?.kind === 'collection' ||
                active?.kind === 'property' ||
                active?.kind === 'tag'
                  ? { kind: active.kind, name: active.name }
                  : null
              }
              declared={{ collection: collections.declared }}
              openGroups={folders.open}
              onToggleGroup={folders.toggle}
              onNew={startNamingAction}
              query={searching === 'actions' ? query : ''}
              // What the notes *use*, per kind: a property in a block, a
              // `--keyword` at the start of a line. Both read off the one vault read.
              used={{ property: properties, collection: keywordsInUse, tag: tags }}
              revision={actionsRevision}
              naming={namingAction}
              typed={actionName}
              onTyped={setActionName}
              onCommit={() => void commitAction()}
              onCancel={() => setNamingAction(null)}
            />
          </SidebarSection>
          {/* **The app's own views, as rows.** The graph and the settings were two
              icons in a footer; a section named for what they are puts them where a
              kind declaring its own view will land — see `actionKinds`. The graph
              row is a toggle, as its button was: pressed while the focused pane
              shows the graph, and closing it back to the note. */}
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
            {/* The days ahead, read out of the `--event` lines in the journal. */}
            <li style={{ paddingLeft: stepIn(1) }}>
              <NoteRow
                icon={<RowIcon icon="calendar" />}
                name="Calendar"
                className={active?.kind === 'calendar' ? 'selected' : undefined}
                aria-label="Calendar"
                aria-pressed={active?.kind === 'calendar'}
                onClick={() => setWs((current) => openTab(current, { kind: 'calendar' }))}
              />
            </li>
            {/* The vault's sync, in one sentence, and the way to its settings. */}
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
            {/* **A shell in the vault folder** — `claude`, `git`, whatever CLI the
                next use case is built on. The row goes back to the shell there is,
                and a second one is on its right-click menu: opening a fresh shell on
                every press read as `claude` restarting. */}
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
        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
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
                    // Every collection the vault has: the ones in use and the ones
                    // that have declared a structure, since `--` is also how you
                    // find out which exist. A declared one completes to its line.
                    completable={collections.completable}
                    root={vault.root}
                    icons={icons}
                    backlinks={backlinks}
                    treeProps={treeProps}
                    onOpen={(file) => void openNote(file)}
                    onOpenLink={(target, wiki) => void openLinkTarget(target, wiki)}
                    // A `--keyword` in a note names a collection and nothing else
                    // does, so pressing it is the shortest way to ask what else in
                    // the vault says that. The same act the pane's row performs.
                    onOpenCollection={(keyword) => view('collection', keyword)}
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
                    onOpen={(file) => void openNote(file)}
                    onOpenLink={(target) => void openLinkTarget(target, true)}
                  />
                )
              case 'tag':
                return (
                  <TagView
                    name={tab.name}
                    collected={collectTag(tab.name)}
                    icons={icons}
                    loading={reading}
                    onOpen={(file) => void openNote(file)}
                  />
                )
              case 'collection':
                return (
                  <CollectionView
                    keyword={tab.name}
                    collected={collect(tab.name)}
                    declaration={collections.declarationOf(tab.name)}
                    icons={icons}
                    loading={reading}
                    onOpen={(file) => void openNote(file)}
                    // A field declared inside `[[ ]]` holds a note's name: the same
                    // funnel a link in the editor goes through, so a name with no
                    // note yet is offered the same way.
                    onOpenLink={(target) => void openLinkTarget(target, true)}
                    onDeclare={(line) => void collections.declare(tab.name, line)}
                  />
                )
              case 'calendar':
                return (
                  <CalendarView
                    collected={collect(EVENT)}
                    declaration={collections.declarationOf(EVENT) ?? EVENT_STRUCTURE}
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
                    currentId={focusedNote ? pathKey(focusedNote.path) : null}
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

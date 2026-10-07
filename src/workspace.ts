// The reading pane as a workspace: groups of tabs, split into panes,
// one group focused. Pure: each operation takes a workspace and returns
// the next, so open, close and split are decided and tested here.
//
// A note is open in one place at a time. Two editors on one note
// would need keeping in step on every key. Opening a tab that is
// already open anywhere goes to it; other kinds follow the same rule.

import { pathKey } from './links'
import type { NoteMoves } from './links'
import { SETTINGS_FILE, type VaultFile } from './vaultModel'

export type Tab =
  | { kind: 'note'; id: number; file: VaultFile }
  | { kind: 'graph'; id: number }
  | { kind: 'property'; id: number; name: string }
  /** A tag's page: every line in the vault with `#name`. */
  | { kind: 'tag'; id: number; name: string }
  | { kind: 'calendar'; id: number }
  /** The daily notes as each day happened. */
  | { kind: 'timeline'; id: number }
  /** Every `#task` line, by when it is due. */
  | { kind: 'tasks'; id: number }
  /** Everything the app has said in this window. */
  | { kind: 'log'; id: number }
  | { kind: 'settingsFile'; id: number }
  /**
   * A file the pane shows rather than edits: a PDF, an image, anything else.
   * It carries the file so the tab follows a move and closes on a delete.
   */
  | { kind: 'file'; id: number; file: VaultFile }
  /**
   * A shell in the vault folder. `session` names its PTY. The
   * one kind that can be open twice.
   */
  | { kind: 'terminal'; id: number; session: string }

/**
 * A tab as asked for, before it has an id. `Omit` is applied to each member of
 * the union, or a `{ kind: 'graph' }` would type-check with a `file` on it.
 */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
export type TabRequest = WithoutId<Tab>

export interface Group {
  id: number
  tabs: Tab[]
  /** Index into `tabs`; unused when there are none. */
  active: number
}

export type Layout =
  | { kind: 'group'; group: Group }
  | {
      kind: 'split'
      id: number
      /** `row` is side by side, `column` one above the other. */
      direction: 'row' | 'column'
      first: Layout
      second: Layout
      /** The first child's share, 0.1–0.9. */
      ratio: number
    }

export interface Workspace {
  layout: Layout
  /** The group a click in the sidebar opens into. */
  focused: number
  /** Ids for groups, splits and tabs, from one counter. */
  nextId: number
}

export function emptyWorkspace(): Workspace {
  return { layout: { kind: 'group', group: { id: 1, tabs: [], active: 0 } }, focused: 1, nextId: 2 }
}

/** What makes two tabs the same: a note by its path, a page by its name. */
function tabKey(tab: TabRequest | Tab): string {
  switch (tab.kind) {
    case 'note':
    case 'file':
      return `${tab.kind}:${pathKey(tab.file.path)}`
    case 'property':
    case 'tag':
      return `${tab.kind}:${tab.name.toLowerCase()}`
    case 'terminal':
      return `terminal:${tab.session}`
    default:
      return tab.kind
  }
}

/** The tab's name on its strip. */
export function tabLabel(tab: Tab): string {
  switch (tab.kind) {
    case 'note':
    case 'file':
      return tab.file.name
    case 'graph':
      return 'Graph'
    case 'property':
      return `${tab.name}::`
    case 'tag':
      return `#${tab.name}`
    case 'calendar':
      return 'Calendar'
    case 'timeline':
      return 'Timeline'
    case 'tasks':
      return 'Tasks'
    case 'log':
      return 'Log'
    case 'settingsFile':
      return SETTINGS_FILE
    case 'terminal':
      return 'Terminal'
  }
}

/** Every group in reading order: left to right, top to bottom. */
export function groups(layout: Layout): Group[] {
  return layout.kind === 'group' ? [layout.group] : [...groups(layout.first), ...groups(layout.second)]
}

function groupById(ws: Workspace, id: number): Group | null {
  return groups(ws.layout).find((group) => group.id === id) ?? null
}

/** The focused group's active tab, or null. */
export function activeTab(ws: Workspace): Tab | null {
  const group = groupById(ws, ws.focused)
  return group?.tabs[group.active] ?? null
}

function findTab(ws: Workspace, key: string): { groupId: number; index: number } | null {
  for (const group of groups(ws.layout)) {
    const index = group.tabs.findIndex((tab) => tabKey(tab) === key)
    if (index !== -1) return { groupId: group.id, index }
  }
  return null
}

function mapGroups(layout: Layout, fn: (group: Group) => Group): Layout {
  return layout.kind === 'group'
    ? { kind: 'group', group: fn(layout.group) }
    : { ...layout, first: mapGroups(layout.first, fn), second: mapGroups(layout.second, fn) }
}

function withGroup(ws: Workspace, id: number, fn: (group: Group) => Group): Workspace {
  return { ...ws, layout: mapGroups(ws.layout, (group) => (group.id === id ? fn(group) : group)) }
}

export function focusGroup(ws: Workspace, groupId: number): Workspace {
  return groupById(ws, groupId) ? { ...ws, focused: groupId } : ws
}

export function activateTab(ws: Workspace, groupId: number, index: number): Workspace {
  return withGroup({ ...ws, focused: groupId }, groupId, (group) =>
    index >= 0 && index < group.tabs.length ? { ...group, active: index } : group
  )
}

/**
 * Opens a tab in the focused group after the active one, as a
 * browser does, or goes to the same tab if it is open anywhere.
 */
export function openTab(ws: Workspace, request: TabRequest): Workspace {
  const found = findTab(ws, tabKey(request))
  if (found) return activateTab(ws, found.groupId, found.index)
  const tab = { ...request, id: ws.nextId } as Tab
  return withGroup({ ...ws, nextId: ws.nextId + 1 }, ws.focused, (group) => {
    const at = group.tabs.length === 0 ? 0 : group.active + 1
    return { ...group, tabs: [...group.tabs.slice(0, at), tab, ...group.tabs.slice(at)], active: at }
  })
}

/** Whether two tabs are the same page: a note by its path, a page by its name. */
export const sameTab = (a: TabRequest | Tab, b: TabRequest | Tab) => tabKey(a) === tabKey(b)

/**
 * The phone's one page: the tab asked for, alone in the one group. The tab on
 * screen keeps its id when it is the one asked for, so its viewer stays mounted.
 */
export function openAlone(ws: Workspace, request: TabRequest): Workspace {
  const shown = activeTab(ws)
  const tab = shown && sameTab(shown, request) ? shown : ({ ...request, id: ws.nextId } as Tab)
  return {
    layout: { kind: 'group', group: { id: ws.focused, tabs: [tab], active: 0 } },
    focused: ws.focused,
    nextId: Math.max(ws.nextId, tab.id + 1),
  }
}

/** The prefix of every session the app owns, on its own tmux socket. */
const TERMINAL_PREFIX = 'journeys-'

/**
 * The session a new terminal tab attaches to: the lowest
 * `journeys-<n>` no open tab shows.
 *
 * Worked out rather than random, so a session survives a restart. With a random
 * name every launch started a fresh shell, `claude` included. The same name next
 * launch finds the session the tmux server still holds, so nothing needs saving.
 */
export function terminalName(ws: Workspace): string {
  const open = new Set(
    groups(ws.layout).flatMap((group) =>
      group.tabs.flatMap((tab) => (tab.kind === 'terminal' ? [tab.session] : []))
    )
  )
  for (let n = 1; ; n++) {
    const name = `${TERMINAL_PREFIX}${n}`
    if (!open.has(name)) return name
  }
}

/**
 * The Terminal row: go back to the last terminal, or open one if
 * there is none. A second shell is asked for from the row's
 * menu; opening one on each press read as `claude` restarting.
 */
export function openTerminal(ws: Workspace): Workspace {
  const last = groups(ws.layout)
    .flatMap((group) => group.tabs.map((tab, index) => ({ group, tab, index })))
    .filter(({ tab }) => tab.kind === 'terminal')
    .pop()
  return last
    ? activateTab(ws, last.group.id, last.index)
    : openTab(ws, { kind: 'terminal', session: terminalName(ws) })
}

/** The graph button: close the graph if the focused group shows it, else open it. */
export function toggleTab(ws: Workspace, request: TabRequest): Workspace {
  const group = groupById(ws, ws.focused)
  const active = group?.tabs[group.active]
  return group && active && tabKey(active) === tabKey(request)
    ? closeTab(ws, group.id, group.active)
    : openTab(ws, request)
}

/**
 * A split with an empty child becomes the other child, and a workspace
 * always has a group. Every operation that removes tabs ends here.
 */
function collapse(layout: Layout): Layout {
  if (layout.kind === 'group') return layout
  const first = collapse(layout.first)
  const second = collapse(layout.second)
  const empty = (side: Layout) => side.kind === 'group' && side.group.tabs.length === 0
  if (empty(first)) return second
  if (empty(second)) return first
  return { ...layout, first, second }
}

function settle(ws: Workspace): Workspace {
  const layout = collapse(ws.layout)
  const all = groups(layout)
  const focused = all.some((group) => group.id === ws.focused) ? ws.focused : all[0].id
  return { ...ws, layout, focused }
}

/**
 * Closes one tab. The one to its left becomes active. An empty
 * group folds out of its split, unless it is the only group.
 */
export function closeTab(ws: Workspace, groupId: number, index: number): Workspace {
  const next = withGroup(ws, groupId, (group) => {
    if (index < 0 || index >= group.tabs.length) return group
    const tabs = group.tabs.filter((_, i) => i !== index)
    const active = Math.min(index === 0 ? 0 : index - 1, Math.max(tabs.length - 1, 0))
    return { ...group, tabs, active }
  })
  return settle(next)
}

/** Every tab in a group but one. */
export function closeOtherTabs(ws: Workspace, groupId: number, index: number): Workspace {
  return settle(
    withGroup(ws, groupId, (group) =>
      group.tabs[index] ? { ...group, tabs: [group.tabs[index]], active: 0 } : group
    )
  )
}

/**
 * Splits a group: a new, empty group appears beside or below and takes the focus,
 * so the next thing opened lands there. Empty, because a note is open in one place.
 */
export function splitGroup(
  ws: Workspace,
  groupId: number,
  direction: 'row' | 'column',
  /** The new group goes before the split one: to its left, or above. */
  before = false
): Workspace {
  const fresh: Group = { id: ws.nextId, tabs: [], active: 0 }
  const place = (layout: Layout): Layout =>
    layout.kind === 'group'
      ? layout.group.id === groupId
        ? {
            kind: 'split',
            id: ws.nextId + 1,
            direction,
            first: before ? { kind: 'group', group: fresh } : layout,
            second: before ? layout : { kind: 'group', group: fresh },
            ratio: SPLIT.even,
          }
        : layout
      : { ...layout, first: place(layout.first), second: place(layout.second) }
  return { layout: place(ws.layout), focused: fresh.id, nextId: ws.nextId + 2 }
}

/** Where a dragged tab is dropped over a pane: one of its four edges, or the middle. */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'centre'

/**
 * A tab dropped on a pane: in the middle it joins the pane; at an edge the
 * pane splits and the tab moves into the new half. A group left empty folds
 * away, so a pane's only tab dropped on its own edge ends where it began.
 */
export function dropTab(
  ws: Workspace,
  from: { groupId: number; index: number },
  groupId: number,
  zone: DropZone
): Workspace {
  if (zone === 'centre') return moveTab(ws, from, { groupId })
  const split = splitGroup(
    ws,
    groupId,
    zone === 'left' || zone === 'right' ? 'row' : 'column',
    zone === 'left' || zone === 'top'
  )
  return moveTab(split, from, { groupId: split.focused })
}

/**
 * Moves a tab to another group, or another place in its own. It
 * arrives active and its group focused. `to.index` is where it
 * lands, the end when absent. A group left empty folds away.
 */
export function moveTab(
  ws: Workspace,
  from: { groupId: number; index: number },
  to: { groupId: number; index?: number }
): Workspace {
  const source = groupById(ws, from.groupId)
  const tab = source?.tabs[from.index]
  if (!source || !tab || !groupById(ws, to.groupId)) return ws
  const removed = withGroup(ws, from.groupId, (group) => {
    const tabs = group.tabs.filter((_, i) => i !== from.index)
    return { ...group, tabs, active: Math.min(from.index === 0 ? 0 : from.index - 1, Math.max(tabs.length - 1, 0)) }
  })
  const placed = withGroup(removed, to.groupId, (group) => {
    let at = to.index ?? group.tabs.length
    // A slot left behind in the same group shifts what comes after.
    if (from.groupId === to.groupId && from.index < at) at -= 1
    at = Math.max(0, Math.min(at, group.tabs.length))
    return { ...group, tabs: [...group.tabs.slice(0, at), tab, ...group.tabs.slice(at)], active: at }
  })
  return settle({ ...placed, focused: to.groupId })
}

/**
 * Removes an empty group by hand, the way out of a split nothing
 * was opened into. A group with tabs closes by closing them.
 */
export function closeGroup(ws: Workspace, groupId: number): Workspace {
  const all = groups(ws.layout)
  const group = all.find((one) => one.id === groupId)
  if (!group || group.tabs.length > 0 || all.length === 1) return ws
  return settle(ws)
}

/**
 * A split's first share: where a new split starts, where a
 * double-click resets it, and how far a drag may go.
 */
export const SPLIT = { even: 0.5, min: 0.1, max: 0.9 }

export function resizeSplit(ws: Workspace, splitId: number, ratio: number): Workspace {
  const clamped = Math.min(SPLIT.max, Math.max(SPLIT.min, ratio))
  const resize = (layout: Layout): Layout =>
    layout.kind === 'group'
      ? layout
      : {
          ...layout,
          ratio: layout.id === splitId ? clamped : layout.ratio,
          first: resize(layout.first),
          second: resize(layout.second),
        }
  return { ...ws, layout: resize(ws.layout) }
}

/**
 * Every tab holding a file, re-pointed by `fn` so a moved note
 * or PDF keeps its tab. A null answer closes the tab.
 */
function mapFileTabs(ws: Workspace, fn: (file: VaultFile) => VaultFile | null): Workspace {
  return settle({
    ...ws,
    layout: mapGroups(ws.layout, (group) => {
      const tabs: Tab[] = []
      let active = group.active
      group.tabs.forEach((tab, i) => {
        // Notes and files both follow a rename, and close on a delete.
        if (tab.kind !== 'note' && tab.kind !== 'file') return void tabs.push(tab)
        const next = fn(tab.file)
        if (next) tabs.push(next === tab.file ? tab : { ...tab, file: next })
        else if (i <= group.active) active = Math.max(0, active - 1)
      })
      return { ...group, tabs, active: Math.min(active, Math.max(tabs.length - 1, 0)) }
    }),
  })
}

/** After a rename or move: the tab holding `was` now holds `moved`. */
export function followFileTabs(ws: Workspace, was: string, moved: VaultFile): Workspace {
  return mapFileTabs(ws, (file) => (pathKey(file.path) === pathKey(was) ? moved : file))
}

/**
 * After a folder rename or move: every tab under it follows. The folder's
 * own note goes by the map, since its name changed; the rest by the prefix.
 */
export function followFolderTabs(
  ws: Workspace,
  oldPrefix: string,
  newPrefix: string,
  moves: NoteMoves,
  vaultPath: string
): Workspace {
  return mapFileTabs(ws, (file) => {
    const moved = moves.get(pathKey(file.path))
    if (moved) return moved
    if (file.path !== oldPrefix && !file.path.startsWith(`${oldPrefix}/`)) return file
    const path = newPrefix + file.path.slice(oldPrefix.length)
    return { ...file, path, absolutePath: `${vaultPath}/${path}` }
  })
}

/** After a delete: the note's tab, and every tab under a deleted folder, closes. */
export function closeNotesUnder(ws: Workspace, prefix: string): Workspace {
  return mapFileTabs(ws, (file) =>
    file.path === prefix || file.path.startsWith(`${prefix}/`) ? null : file
  )
}

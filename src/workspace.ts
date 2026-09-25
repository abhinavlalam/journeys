// **The reading pane is a workspace**: groups of tabs, split into panes, with one
// group focused. A pure model — every operation takes a workspace and answers with
// the next one — so what "open", "close" and "split" mean is decided here and
// tested here, and `App` only asks.
//
// **A note is open in one place at a time.** Two editors on one buffer is two
// copies of a text that have to be kept in step on every keystroke, which is a
// document model this app does not have; opening a note that is already open, in
// any group, focuses the tab it has. The other kinds — the graph, a collection's
// page, a property's, the settings file — are the same everywhere, so the same rule
// costs nothing and there is one rule.

import { pathKey } from './links'
import type { NoteMoves } from './links'
import type { VaultFile } from './vaultModel'

export type Tab =
  | { kind: 'note'; id: number; file: VaultFile }
  | { kind: 'graph'; id: number }
  | { kind: 'collection'; id: number; name: string }
  | { kind: 'property'; id: number; name: string }
  /** A tag's page: every line in the vault carrying `#name`. */
  | { kind: 'tag'; id: number; name: string }
  | { kind: 'calendar'; id: number }
  | { kind: 'settingsFile'; id: number }
  /** A file the pane shows rather than edits — a PDF, an image, anything else.
   *  It carries the file for the same reason a note tab does: the tab follows it
   *  when it moves, and closes when it is deleted. */
  | { kind: 'file'; id: number; file: VaultFile }
  /** A shell in the vault folder. `session` names its PTY; two terminals are two
   *  tabs, so the key carries it — the one kind that is never deduplicated. */
  | { kind: 'terminal'; id: number; session: string }

/**
 * A tab as something asks for it — before it has an id.
 *
 * `Omit` is applied to each member of the union rather than to the union, or the
 * kinds collapse into one object carrying every field and a `{ kind: 'graph' }`
 * would typecheck with a `file` on it. A naked type parameter in a conditional is
 * what distributes; it was written inline with an `infer` that did nothing.
 */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
export type TabRequest = WithoutId<Tab>

export interface Group {
  id: number
  tabs: Tab[]
  /** Index into `tabs`; meaningless when there are none. */
  active: number
}

export type Layout =
  | { kind: 'group'; group: Group }
  | {
      kind: 'split'
      id: number
      /** `row` puts the two side by side, `column` one above the other. */
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

/** What makes two tabs the same tab: a note by its path, a page by its name. */
function tabKey(tab: TabRequest | Tab): string {
  switch (tab.kind) {
    case 'note':
    case 'file':
      return `${tab.kind}:${pathKey(tab.file.path)}`
    case 'collection':
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
    case 'collection':
      return `--${tab.name}`
    case 'property':
      return `${tab.name}:`
    case 'tag':
      return `#${tab.name}`
    case 'calendar':
      return 'Calendar'
    case 'settingsFile':
      return 'settings.json'
    case 'terminal':
      return 'Terminal'
  }
}

/** Every group, in reading order — left to right, top to bottom. */
export function groups(layout: Layout): Group[] {
  return layout.kind === 'group' ? [layout.group] : [...groups(layout.first), ...groups(layout.second)]
}

function groupById(ws: Workspace, id: number): Group | null {
  return groups(ws.layout).find((group) => group.id === id) ?? null
}

/** The focused group's active tab, or null when it has none. */
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
 * Opens a tab in the focused group — **after** the active one, the way a browser
 * does — or, if the same tab is open anywhere, goes to it instead.
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

/**
 * The Terminal row's act: back to the terminal there is — the last one in reading
 * order — or a new one when there is none. Pressing the row to *return* to a shell
 * opened a fresh shell beside it, which read as `claude` restarting; a second shell
 * is asked for by name, from the row's menu.
 */
/** The prefix every session this app owns is named with, on its own tmux socket. */
const TERMINAL_PREFIX = 'journeys-'

/**
 * The session a new Terminal tab attaches to: the lowest `journeys-<n>` no open tab
 * is already showing.
 *
 * **Derived and not random, which is the whole of why a session survives a
 * restart.** It was `crypto.randomUUID()`, so every launch named a session nothing
 * had ever heard of and `new-session -A` created a fresh one each time — the app
 * reported as starting from scratch, `claude` included. A name that is a function of
 * the workspace is the *same* name next launch, and the tmux server is still holding
 * the session under it. So nothing is persisted to do this: the server is the state,
 * which is why this needs no file and cannot go stale.
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

export function openTerminal(ws: Workspace): Workspace {
  const last = groups(ws.layout)
    .flatMap((group) => group.tabs.map((tab, index) => ({ group, tab, index })))
    .filter(({ tab }) => tab.kind === 'terminal')
    .pop()
  return last
    ? activateTab(ws, last.group.id, last.index)
    : openTab(ws, { kind: 'terminal', session: terminalName(ws) })
}

/** The graph button's act: shut it if it is what the focused group shows, open it
 *  otherwise. */
export function toggleTab(ws: Workspace, request: TabRequest): Workspace {
  const group = groupById(ws, ws.focused)
  const active = group?.tabs[group.active]
  return group && active && tabKey(active) === tabKey(request)
    ? closeTab(ws, group.id, group.active)
    : openTab(ws, request)
}

/**
 * A split with an empty child is that child's sibling; a workspace is never
 * without a group. Every operation that removes tabs ends here, so the shape is
 * one rule rather than one per operation.
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
 * Closes one tab. The neighbour on the left becomes active — the tab that was
 * open before this one, most of the time. A group left empty is folded out of its
 * split, unless it is the only group, which stays as the empty pane.
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
 * Splits a group: it becomes the first half of a split, with a **new, empty**
 * group beside or below it, which takes the focus so the next thing opened lands
 * there. Empty rather than a copy of the active tab, because a note is open in one
 * place at a time (see the top of the file), and one rule is better than one per
 * kind of tab.
 */
export function splitGroup(
  ws: Workspace,
  groupId: number,
  direction: 'row' | 'column',
  /** The new group goes *before* the split one — to its left, or above it. */
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

/** Where a dragged tab is let go over a pane: one of its four edges, or the middle. */
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'centre'

/**
 * A tab dropped on a pane: in the middle it joins the pane; at an edge it gets a
 * pane of its own on that side — the pane is split and the tab moved into the new
 * half, which is what dragging a page to the right *means* in the editors the
 * owner named. A group left empty by the move folds away, so dragging a pane's
 * only tab to its own edge comes back to where it started.
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
 * Moves one tab to another place: another group, or another position in its own.
 * The tab arrives active and its new group focused — it was just put there by
 * hand. `to.index` is where it lands, the end when absent; a group left empty by
 * the move folds out of its split, as it does when its last tab closes.
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
    // Leaving a slot behind in the same group shifts what comes after it.
    if (from.groupId === to.groupId && from.index < at) at -= 1
    at = Math.max(0, Math.min(at, group.tabs.length))
    return { ...group, tabs: [...group.tabs.slice(0, at), tab, ...group.tabs.slice(at)], active: at }
  })
  return settle({ ...placed, focused: to.groupId })
}

/** Removes an empty group by hand — the one way out of a split nothing was opened
 *  into. A group with tabs is closed by closing them. */
export function closeGroup(ws: Workspace, groupId: number): Workspace {
  const all = groups(ws.layout)
  const group = all.find((one) => one.id === groupId)
  if (!group || group.tabs.length > 0 || all.length === 1) return ws
  return settle(ws)
}

/** A split's share for its first half: where a new one starts and a double-click
 *  puts it back, and how far a drag may take either half. */
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
 * Every tab that holds a file, re-pointed by `fn` — a moved note or PDF follows it,
 * and a null answer closes the tab. It was `mapNoteTabs`, from when a note was the
 * only tab with a file behind it.
 */
function mapFileTabs(ws: Workspace, fn: (file: VaultFile) => VaultFile | null): Workspace {
  return settle({
    ...ws,
    layout: mapGroups(ws.layout, (group) => {
      const tabs: Tab[] = []
      let active = group.active
      group.tabs.forEach((tab, i) => {
        // Both kinds hold a file, and both follow it: a photograph renamed in the
        // tree keeps its tab, and one deleted closes it.
        if (tab.kind !== 'note' && tab.kind !== 'file') return void tabs.push(tab)
        const next = fn(tab.file)
        if (next) tabs.push(next === tab.file ? tab : { ...tab, file: next })
        else if (i <= group.active) active = Math.max(0, active - 1)
      })
      return { ...group, tabs, active: Math.min(active, Math.max(tabs.length - 1, 0)) }
    }),
  })
}

/** After a rename or a move: the tab holding `was` now holds `moved`. */
export function followFileTabs(ws: Workspace, was: string, moved: VaultFile): Workspace {
  return mapFileTabs(ws, (file) => (pathKey(file.path) === pathKey(was) ? moved : file))
}

/** After a folder rename or move: every tab under it follows, the folder's own
 *  note by the map (its basename changed) and the rest by the prefix. */
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

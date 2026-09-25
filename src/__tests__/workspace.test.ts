import { describe, expect, it } from 'vitest'
import {
  activeTab,
  closeGroup,
  closeNotesUnder,
  closeOtherTabs,
  closeTab,
  dropTab,
  emptyWorkspace,
  followFileTabs,
  groups,
  moveTab,
  openTab,
  openTerminal,
  resizeSplit,
  splitGroup,
  tabLabel,
  terminalName,
  toggleTab,
  type Workspace,
} from '../workspace'

const note = (path: string) => ({
  kind: 'note' as const,
  file: { path, absolutePath: `/v/${path}`, name: path.replace(/\.md$/, '').split('/').pop()! },
})
const labels = (ws: Workspace) => groups(ws.layout).map((group) => group.tabs.map(tabLabel))
const actives = (ws: Workspace) => groups(ws.layout).map((group) => tabLabel(group.tabs[group.active]))

describe('tabs in one group', () => {
  it('opens after the active tab and makes the new one active', () => {
    let ws = openTab(emptyWorkspace(), note('a.md'))
    ws = openTab(ws, note('c.md'))
    ws = openTab(ws, { kind: 'graph' })
    expect(labels(ws)).toEqual([['a', 'c', 'Graph']])
    // Back to `a`, then open `b`: it lands beside `a`, not at the end.
    ws = openTab(ws, note('A.md'))
    ws = openTab(ws, note('b.md'))
    expect(labels(ws)).toEqual([['a', 'b', 'c', 'Graph']])
    expect(tabLabel(activeTab(ws)!)).toBe('b')
  })

  /** **A note is open in one place at a time.** The same path, whatever its case,
   *  is the same tab — as `pathKey` says for links. */
  it('goes to a tab that is already open rather than opening a second', () => {
    let ws = openTab(openTab(emptyWorkspace(), note('a.md')), note('b.md'))
    ws = openTab(ws, note('A.md'))
    expect(labels(ws)).toEqual([['a', 'b']])
    expect(tabLabel(activeTab(ws)!)).toBe('a')
  })

  it('closes to the neighbour on the left, and the only group stays as an empty pane', () => {
    let ws = openTab(openTab(openTab(emptyWorkspace(), note('a.md')), note('b.md')), note('c.md'))
    ws = closeTab(ws, 1, 2)
    expect(actives(ws)).toEqual(['b'])
    ws = closeTab(ws, 1, 0)
    expect(labels(ws)).toEqual([['b']])
    ws = closeTab(ws, 1, 0)
    expect(labels(ws)).toEqual([[]])
    expect(activeTab(ws)).toBeNull()
    expect(ws.focused).toBe(1)
  })

  it('toggles a page: shut when it is what is showing, opened otherwise', () => {
    let ws = openTab(emptyWorkspace(), note('a.md'))
    ws = toggleTab(ws, { kind: 'graph' })
    expect(actives(ws)).toEqual(['Graph'])
    ws = toggleTab(ws, { kind: 'graph' })
    expect(labels(ws)).toEqual([['a']])
    expect(actives(ws)).toEqual(['a'])
  })

  it('closes the others', () => {
    let ws = openTab(openTab(openTab(emptyWorkspace(), note('a.md')), note('b.md')), note('c.md'))
    ws = closeOtherTabs(ws, 1, 1)
    expect(labels(ws)).toEqual([['b']])
  })
})

describe('a terminal', () => {
  /** Two sessions are two tabs; the row goes back to the one there is. */
  it('is one tab per session, and the row returns to the last one', () => {
    let ws = openTerminal(emptyWorkspace())
    ws = openTab(ws, note('a.md'))
    ws = openTerminal(ws)
    expect(labels(ws)).toEqual([['Terminal', 'a']])
    expect(groups(ws.layout)[0].active).toBe(0)
    ws = openTab(ws, { kind: 'terminal', session: terminalName(ws) })
    expect(labels(ws)).toEqual([['Terminal', 'Terminal', 'a']])
    ws = openTerminal(openTab(ws, note('a.md')))
    expect(groups(ws.layout)[0].active).toBe(1)
  })

  /**
   * **The name is derived, and that is the whole of why a session survives a
   * restart.** It was `crypto.randomUUID()`, so a relaunch asked tmux for a session
   * nothing had heard of and got a fresh one — reported as everything starting from
   * scratch. The first terminal of a run is always `journeys-1`, so a relaunch
   * attaches to what the server is still holding, with nothing persisted to do it.
   */
  it('names the first session the same on every launch', () => {
    expect(terminalName(emptyWorkspace())).toBe('journeys-1')
    const first = openTerminal(emptyWorkspace())
    // A second launch, a fresh workspace: the same name, so the same session.
    expect(terminalName(emptyWorkspace())).toBe('journeys-1')
    // Within a run it steps past what is open rather than colliding.
    expect(terminalName(first)).toBe('journeys-2')
    const two = openTab(first, { kind: 'terminal', session: terminalName(first) })
    expect(terminalName(two)).toBe('journeys-3')
  })

  /** A closed tab frees its name, because the tab is what held it: the session is
   *  detached rather than ended, so the next Terminal reattaches to it. */
  it('reuses a name a closed tab gave up', () => {
    const one = openTerminal(emptyWorkspace())
    const two = openTab(one, { kind: 'terminal', session: terminalName(one) })
    expect(terminalName(two)).toBe('journeys-3')
    const shut = closeTab(two, groups(two.layout)[0].id, 0)
    expect(terminalName(shut)).toBe('journeys-1')
  })
})

describe('splitting', () => {
  it('puts an empty, focused group beside the split one', () => {
    let ws = openTab(emptyWorkspace(), note('a.md'))
    ws = splitGroup(ws, 1, 'row')
    expect(ws.layout.kind).toBe('split')
    expect(labels(ws)).toEqual([['a'], []])
    // The next thing opened lands in the new group.
    ws = openTab(ws, note('b.md'))
    expect(labels(ws)).toEqual([['a'], ['b']])
    // And a note open in the first group is focused there, not opened again.
    ws = openTab(ws, note('a.md'))
    expect(labels(ws)).toEqual([['a'], ['b']])
    expect(ws.focused).toBe(1)
  })

  it('folds a group out of its split when its last tab closes', () => {
    let ws = openTab(emptyWorkspace(), note('a.md'))
    ws = splitGroup(ws, 1, 'column')
    ws = openTab(ws, note('b.md'))
    const second = ws.focused
    ws = closeTab(ws, second, 0)
    expect(ws.layout.kind).toBe('group')
    expect(labels(ws)).toEqual([['a']])
    expect(ws.focused).toBe(1)
  })

  it('closes an empty group by hand, and never a full one or the last one', () => {
    let ws = openTab(emptyWorkspace(), note('a.md'))
    expect(closeGroup(ws, 1)).toBe(ws)
    ws = splitGroup(ws, 1, 'row')
    const fresh = ws.focused
    expect(groups(closeGroup(ws, 1).layout)).toHaveLength(2)
    ws = closeGroup(ws, fresh)
    expect(groups(ws.layout)).toHaveLength(1)
  })

  it('keeps a split’s ratio between a tenth and nine tenths', () => {
    let ws = splitGroup(openTab(emptyWorkspace(), note('a.md')), 1, 'row')
    ws = openTab(ws, note('b.md'))
    const split = ws.layout
    if (split.kind !== 'split') throw new Error('expected a split')
    expect((resizeSplit(ws, split.id, 0.3).layout as typeof split).ratio).toBe(0.3)
    expect((resizeSplit(ws, split.id, 0.01).layout as typeof split).ratio).toBe(0.1)
    expect((resizeSplit(ws, split.id, 2).layout as typeof split).ratio).toBe(0.9)
  })
})

describe('moving a tab', () => {
  it('carries it to another group, active there, and folds an emptied group away', () => {
    let ws = openTab(openTab(emptyWorkspace(), note('a.md')), note('b.md'))
    ws = splitGroup(ws, 1, 'row')
    const second = ws.focused
    ws = openTab(ws, note('c.md'))
    ws = moveTab(ws, { groupId: 1, index: 0 }, { groupId: second })
    expect(labels(ws)).toEqual([['b'], ['c', 'a']])
    expect(actives(ws)).toEqual(['b', 'a'])
    expect(ws.focused).toBe(second)
    ws = moveTab(ws, { groupId: 1, index: 0 }, { groupId: second, index: 0 })
    expect(ws.layout.kind).toBe('group')
    expect(labels(ws)).toEqual([['b', 'c', 'a']])
  })

  it('reorders within a group, in either direction', () => {
    let ws = openTab(openTab(openTab(emptyWorkspace(), note('a.md')), note('b.md')), note('c.md'))
    ws = moveTab(ws, { groupId: 1, index: 0 }, { groupId: 1, index: 3 })
    expect(labels(ws)).toEqual([['b', 'c', 'a']])
    ws = moveTab(ws, { groupId: 1, index: 2 }, { groupId: 1, index: 0 })
    expect(labels(ws)).toEqual([['a', 'b', 'c']])
    expect(actives(ws)).toEqual(['a'])
  })
})

describe('dropping a tab on a pane', () => {
  it('splits the pane to the side it was dropped at, and puts the tab there', () => {
    let ws = openTab(openTab(emptyWorkspace(), note('a.md')), note('b.md'))
    ws = dropTab(ws, { groupId: 1, index: 1 }, 1, 'right')
    expect(ws.layout.kind).toBe('split')
    if (ws.layout.kind !== 'split') throw new Error()
    expect(ws.layout.direction).toBe('row')
    expect(labels(ws)).toEqual([['a'], ['b']])
    expect(groups(ws.layout)[1].id).toBe(ws.focused)
    // To the left or above, the new pane comes first.
    ws = openTab(ws, note('c.md'))
    ws = dropTab(ws, { groupId: ws.focused, index: 1 }, 1, 'top')
    expect(labels(ws)).toEqual([['c'], ['a'], ['b']])
  })

  it('joins the pane when dropped in the middle, and comes back whole from its own edge', () => {
    let ws = openTab(emptyWorkspace(), note('a.md'))
    ws = splitGroup(ws, 1, 'row')
    const second = ws.focused
    ws = openTab(ws, note('b.md'))
    ws = dropTab(ws, { groupId: 1, index: 0 }, second, 'centre')
    expect(labels(ws)).toEqual([['b', 'a']])
    // A pane's only tab dragged to its own edge: the emptied half folds, one pane.
    ws = dropTab(ws, { groupId: second, index: 1 }, second, 'right')
    expect(labels(ws)).toEqual([['b'], ['a']])
    ws = dropTab(ws, { groupId: ws.focused, index: 0 }, ws.focused, 'bottom')
    expect(labels(ws)).toEqual([['b'], ['a']])
  })
})

describe('tabs following the tree', () => {
  it('re-points a moved note’s tab and closes a deleted one', () => {
    let ws = openTab(openTab(emptyWorkspace(), note('a.md')), note('Plans/b.md'))
    ws = followFileTabs(ws, 'a.md', note('Areas/a2.md').file)
    expect(labels(ws)).toEqual([['a2', 'b']])
    ws = closeNotesUnder(ws, 'Plans')
    expect(labels(ws)).toEqual([['a2']])
    expect(actives(ws)).toEqual(['a2'])
  })
})

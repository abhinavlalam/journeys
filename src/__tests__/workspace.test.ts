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
  openAlone,
  openTab,
  openTerminal,
  resizeSplit,
  splitGroup,
  stepTab,
  tabLabel,
  terminalName,
  toggleTab,
  type Workspace,
} from '../workspace'

const note = (path: string) => ({
  kind: 'note' as const,
  file: { path, absolutePath: `/v/${path}`, name: path.replace(/\.md$/, '').split('/').pop()! },
})
/** Opened as ⌘-click opens: in a new tab beside the one in front. */
const beside = (ws: Workspace, request: Parameters<typeof openTab>[1]) => openTab(ws, request, true)
/** The tab with `label` brought to front in its group. */
const activateTabByLabel = (ws: Workspace, label: string) => {
  const group = groups(ws.layout).find((one) => one.tabs.some((tab) => tabLabel(tab) === label))!
  return { ...ws, focused: group.id, layout: { kind: 'group' as const, group: { ...group, active: group.tabs.findIndex((tab) => tabLabel(tab) === label) } } }
}
const labels = (ws: Workspace) => groups(ws.layout).map((group) => group.tabs.map(tabLabel))
const actives = (ws: Workspace) => groups(ws.layout).map((group) => tabLabel(group.tabs[group.active]))

describe('tabs in one group', () => {
  /** A plain open takes the place of the tab in front; a new tab for every press made too many to keep track of. */
  it('opens in place of the tab in front, and beside it when asked', () => {
    let ws = openTab(emptyWorkspace(), note('a.md'))
    ws = openTab(ws, note('b.md'))
    ws = openTab(ws, { kind: 'graph' })
    expect(labels(ws)).toEqual([['Graph']])
    ws = openTab(ws, note('c.md'), true)
    expect([labels(ws), actives(ws)]).toEqual([[['Graph', 'c']], ['c']])
    // A note open elsewhere is gone to, not opened over the one in front.
    ws = openTab(ws, { kind: 'graph' })
    expect([labels(ws), actives(ws)]).toEqual([[['Graph', 'c']], ['Graph']])
  })

  /** Replaced, a tab remembers what it showed: back and forward walk it, as a browser's page does. */
  it('goes back to what the tab in front showed, and forward again', () => {
    let ws = openTab(openTab(openTab(emptyWorkspace(), note('a.md')), note('b.md')), { kind: 'graph' })
    ws = stepTab(ws, true)
    expect([labels(ws), activeTab(ws)!.forward?.map((one) => one.kind)]).toEqual([[['b']], ['graph']])
    ws = stepTab(stepTab(ws, true), true)
    // Nothing further back: the same workspace.
    expect(labels(ws)).toEqual([['a']])
    ws = stepTab(ws, false)
    expect(labels(ws)).toEqual([['b']])
    // Opening something new forgets the way forward.
    ws = openTab(ws, note('c.md'))
    expect([labels(stepTab(ws, false)), activeTab(ws)!.back?.map((one) => one.kind === 'note' && one.file.name)]).toEqual([[['c']], ['a', 'b']])
  })

  it('goes to a page open in another tab rather than opening it twice', () => {
    // `b` in place of `a`, then `a` beside it: back from `b` is the other tab.
    let ws = beside(openTab(openTab(emptyWorkspace(), note('a.md')), note('b.md')), note('a.md'))
    ws = stepTab(activateTabByLabel(ws, 'b'), true)
    expect([labels(ws), actives(ws)]).toEqual([[['b', 'a']], ['a']])
    expect(groups(ws.layout)[0].tabs[0].back).toEqual([])
  })

  it('follows a moved note back, and forgets a deleted one', () => {
    let ws = openTab(openTab(emptyWorkspace(), note('a.md')), note('b.md'))
    ws = followFileTabs(ws, 'a.md', note('Plans/a.md').file)
    expect(activeTab(ws)!.back?.map((one) => one.kind === 'note' && one.file.path)).toEqual(['Plans/a.md'])
    ws = closeNotesUnder(ws, 'Plans')
    expect(activeTab(ws)!.back).toEqual([])
  })

  /** A shell and an unsaved settings file are not put back once replaced, so they stay; a terminal is a tab of its own. */
  it('never opens over a terminal or the settings file, and opens a terminal beside', () => {
    let ws = openTab(emptyWorkspace(), { kind: 'terminal', session: 'journeys-1' })
    ws = openTab(ws, note('a.md'))
    expect(labels(ws)).toEqual([['Terminal', 'a']])
    ws = openTab(ws, { kind: 'terminal', session: 'journeys-2' })
    expect(labels(ws)).toEqual([['Terminal', 'a', 'Terminal']])
    ws = openTab(openTab(emptyWorkspace(), { kind: 'settingsFile' }), note('a.md'))
    expect(labels(ws)).toEqual([[tabLabel({ kind: 'settingsFile', id: 0 }), 'a']])
  })

  it('opens after the active tab and makes the new one active', () => {
    let ws = beside(emptyWorkspace(), note('a.md'))
    ws = beside(ws, note('c.md'))
    ws = beside(ws, { kind: 'graph' })
    expect(labels(ws)).toEqual([['a', 'c', 'Graph']])
    // Back to `a`, then open `b`: it lands beside `a`, not at the end.
    ws = beside(ws, note('A.md'))
    ws = beside(ws, note('b.md'))
    expect(labels(ws)).toEqual([['a', 'b', 'c', 'Graph']])
    expect(tabLabel(activeTab(ws)!)).toBe('b')
  })

  /**
   * A note is open in one place. The same path in any case is
   * the same tab, as `pathKey` says for links.
   */
  it('goes to a tab that is already open rather than opening a second', () => {
    let ws = beside(beside(emptyWorkspace(), note('a.md')), note('b.md'))
    ws = beside(ws, note('A.md'))
    expect(labels(ws)).toEqual([['a', 'b']])
    expect(tabLabel(activeTab(ws)!)).toBe('a')
  })

  it('closes to the neighbour on the left, and the only group stays as an empty pane', () => {
    let ws = beside(beside(beside(emptyWorkspace(), note('a.md')), note('b.md')), note('c.md'))
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
    let ws = beside(emptyWorkspace(), note('a.md'))
    ws = toggleTab(ws, { kind: 'graph' })
    expect(actives(ws)).toEqual(['Graph'])
    ws = toggleTab(ws, { kind: 'graph' })
    expect(labels(ws)).toEqual([['a']])
    expect(actives(ws)).toEqual(['a'])
  })

  it('closes the others', () => {
    let ws = beside(beside(beside(emptyWorkspace(), note('a.md')), note('b.md')), note('c.md'))
    ws = closeOtherTabs(ws, 1, 1)
    expect(labels(ws)).toEqual([['b']])
  })
})

describe('a terminal', () => {
  /** Two sessions are two tabs; the row goes back to the one there is. */
  it('is one tab per session, and the row returns to the last one', () => {
    let ws = openTerminal(emptyWorkspace())
    ws = beside(ws, note('a.md'))
    ws = openTerminal(ws)
    expect(labels(ws)).toEqual([['Terminal', 'a']])
    expect(groups(ws.layout)[0].active).toBe(0)
    ws = beside(ws, { kind: 'terminal', session: terminalName(ws) })
    expect(labels(ws)).toEqual([['Terminal', 'Terminal', 'a']])
    ws = openTerminal(beside(ws, note('a.md')))
    expect(groups(ws.layout)[0].active).toBe(1)
  })

  /**
   * The name is derived, which is why a session survives a restart. A random
   * name got a fresh session on every relaunch. The first terminal of a run is
   * always `journeys-1`, so a relaunch attaches to what the server still holds.
   */
  it('names the first session the same on every launch', () => {
    expect(terminalName(emptyWorkspace())).toBe('journeys-1')
    const first = openTerminal(emptyWorkspace())
    // A second launch, a fresh workspace: the same name, so the same session.
    expect(terminalName(emptyWorkspace())).toBe('journeys-1')
    // Within a run it steps past what is open.
    expect(terminalName(first)).toBe('journeys-2')
    const two = beside(first, { kind: 'terminal', session: terminalName(first) })
    expect(terminalName(two)).toBe('journeys-3')
  })

  /**
   * A closed tab frees its name: the session is detached, not
   * ended, so the next terminal reattaches to it.
   */
  it('reuses a name a closed tab gave up', () => {
    const one = openTerminal(emptyWorkspace())
    const two = beside(one, { kind: 'terminal', session: terminalName(one) })
    expect(terminalName(two)).toBe('journeys-3')
    const shut = closeTab(two, groups(two.layout)[0].id, 0)
    expect(terminalName(shut)).toBe('journeys-1')
  })
})

describe('splitting', () => {
  it('puts an empty, focused group beside the split one', () => {
    let ws = beside(emptyWorkspace(), note('a.md'))
    ws = splitGroup(ws, 1, 'row')
    expect(ws.layout.kind).toBe('split')
    expect(labels(ws)).toEqual([['a'], []])
    // The next thing opened lands in the new group.
    ws = beside(ws, note('b.md'))
    expect(labels(ws)).toEqual([['a'], ['b']])
    // A note open in the first group is focused there, not opened again.
    ws = beside(ws, note('a.md'))
    expect(labels(ws)).toEqual([['a'], ['b']])
    expect(ws.focused).toBe(1)
  })

  it('folds a group out of its split when its last tab closes', () => {
    let ws = beside(emptyWorkspace(), note('a.md'))
    ws = splitGroup(ws, 1, 'column')
    ws = beside(ws, note('b.md'))
    const second = ws.focused
    ws = closeTab(ws, second, 0)
    expect(ws.layout.kind).toBe('group')
    expect(labels(ws)).toEqual([['a']])
    expect(ws.focused).toBe(1)
  })

  it('closes an empty group by hand, and never a full one or the last one', () => {
    let ws = beside(emptyWorkspace(), note('a.md'))
    expect(closeGroup(ws, 1)).toBe(ws)
    ws = splitGroup(ws, 1, 'row')
    const fresh = ws.focused
    expect(groups(closeGroup(ws, 1).layout)).toHaveLength(2)
    ws = closeGroup(ws, fresh)
    expect(groups(ws.layout)).toHaveLength(1)
  })

  it('keeps a split’s ratio between a tenth and nine tenths', () => {
    let ws = splitGroup(beside(emptyWorkspace(), note('a.md')), 1, 'row')
    ws = beside(ws, note('b.md'))
    const split = ws.layout
    if (split.kind !== 'split') throw new Error('expected a split')
    expect((resizeSplit(ws, split.id, 0.3).layout as typeof split).ratio).toBe(0.3)
    expect((resizeSplit(ws, split.id, 0.01).layout as typeof split).ratio).toBe(0.1)
    expect((resizeSplit(ws, split.id, 2).layout as typeof split).ratio).toBe(0.9)
  })
})

describe('moving a tab', () => {
  it('carries it to another group, active there, and folds an emptied group away', () => {
    let ws = beside(beside(emptyWorkspace(), note('a.md')), note('b.md'))
    ws = splitGroup(ws, 1, 'row')
    const second = ws.focused
    ws = beside(ws, note('c.md'))
    ws = moveTab(ws, { groupId: 1, index: 0 }, { groupId: second })
    expect(labels(ws)).toEqual([['b'], ['c', 'a']])
    expect(actives(ws)).toEqual(['b', 'a'])
    expect(ws.focused).toBe(second)
    ws = moveTab(ws, { groupId: 1, index: 0 }, { groupId: second, index: 0 })
    expect(ws.layout.kind).toBe('group')
    expect(labels(ws)).toEqual([['b', 'c', 'a']])
  })

  it('reorders within a group, in either direction', () => {
    let ws = beside(beside(beside(emptyWorkspace(), note('a.md')), note('b.md')), note('c.md'))
    ws = moveTab(ws, { groupId: 1, index: 0 }, { groupId: 1, index: 3 })
    expect(labels(ws)).toEqual([['b', 'c', 'a']])
    ws = moveTab(ws, { groupId: 1, index: 2 }, { groupId: 1, index: 0 })
    expect(labels(ws)).toEqual([['a', 'b', 'c']])
    expect(actives(ws)).toEqual(['a'])
  })
})

describe('dropping a tab on a pane', () => {
  it('splits the pane to the side it was dropped at, and puts the tab there', () => {
    let ws = beside(beside(emptyWorkspace(), note('a.md')), note('b.md'))
    ws = dropTab(ws, { groupId: 1, index: 1 }, 1, 'right')
    expect(ws.layout.kind).toBe('split')
    if (ws.layout.kind !== 'split') throw new Error()
    expect(ws.layout.direction).toBe('row')
    expect(labels(ws)).toEqual([['a'], ['b']])
    expect(groups(ws.layout)[1].id).toBe(ws.focused)
    // To the left or above, the new pane comes first.
    ws = beside(ws, note('c.md'))
    ws = dropTab(ws, { groupId: ws.focused, index: 1 }, 1, 'top')
    expect(labels(ws)).toEqual([['c'], ['a'], ['b']])
  })

  it('joins the pane when dropped in the middle, and comes back whole from its own edge', () => {
    let ws = beside(emptyWorkspace(), note('a.md'))
    ws = splitGroup(ws, 1, 'row')
    const second = ws.focused
    ws = beside(ws, note('b.md'))
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
    let ws = beside(beside(emptyWorkspace(), note('a.md')), note('Plans/b.md'))
    ws = followFileTabs(ws, 'a.md', note('Areas/a2.md').file)
    expect(labels(ws)).toEqual([['a2', 'b']])
    ws = closeNotesUnder(ws, 'Plans')
    expect(labels(ws)).toEqual([['a2']])
    expect(actives(ws)).toEqual(['a2'])
  })
})

describe('the phone’s one page', () => {
  it('shows the tab asked for alone, and keeps the one on screen mounted', () => {
    const ws = openAlone(beside(beside(emptyWorkspace(), note('a.md')), note('b.md')), note('c.md'))
    expect(labels(ws)).toEqual([['c']])
    const id = activeTab(ws)!.id
    expect(activeTab(openAlone(ws, note('C.md')))!.id).toBe(id)
    const next = openAlone(ws, { kind: 'timeline' })
    expect(labels(next)).toEqual([['Timeline']])
    expect(activeTab(next)!.id).toBeGreaterThan(id)
  })
})

import { useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import {
  activateTab,
  closeGroup,
  closeOtherTabs,
  closeTab,
  dropTab,
  focusGroup,
  moveTab,
  resizeSplit,
  splitGroup,
  tabLabel,
  type DropZone,
  type Group,
  type Layout,
  type Tab,
  type Workspace,
  SPLIT,
} from './workspace'
import { useContextMenu } from './useContextMenu'
import { SplitIcon } from './icons'

/** The drag's payload: which tab is being carried, as `group:index`. */
const TAB_DRAG = 'application/x-journeys-tab'

function carried(event: DragEvent): { groupId: number; index: number } | null {
  const raw = event.dataTransfer.getData(TAB_DRAG)
  if (!raw) return null
  const [groupId, index] = raw.split(':').map(Number)
  return Number.isFinite(groupId) && Number.isFinite(index) ? { groupId, index } : null
}

/** A box, as fractions of the workspace: what the tree says about where a group is. */
interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Handle {
  id: number
  direction: 'row' | 'column'
  rect: Rect
  ratio: number
}

/**
 * **The tree is read for geometry, not drawn as DOM.** Every group is a box the
 * tree places, every split a handle on a line between two boxes — and the DOM is a
 * flat list of those boxes and handles, keyed by id. It was nested, one element per
 * split, and that is exactly what a split *is* in React terms: a new parent. So
 * splitting a pane, or dragging a tab out to a new one, re-parented every element
 * under it, React unmounted and remounted the lot, and a terminal in the pane lost
 * its shell — reported as the terminal restarting whenever anything moved across
 * panes. Flat, a group's box moves and nothing in it is touched.
 */
function measure(layout: Layout, rect: Rect, boxes: Map<number, Rect>, handles: Handle[]) {
  if (layout.kind === 'group') {
    boxes.set(layout.group.id, rect)
    return
  }
  const row = layout.direction === 'row'
  const first: Rect = row
    ? { ...rect, w: rect.w * layout.ratio }
    : { ...rect, h: rect.h * layout.ratio }
  const second: Rect = row
    ? { ...rect, x: rect.x + first.w, w: rect.w - first.w }
    : { ...rect, y: rect.y + first.h, h: rect.h - first.h }
  handles.push({ id: layout.id, direction: layout.direction, rect, ratio: layout.ratio })
  measure(layout.first, first, boxes, handles)
  measure(layout.second, second, boxes, handles)
}

const pct = (n: number) => `${n * 100}%`

/** How far into a pane, as a share of its side, a dropped tab makes a new pane on
 *  that side rather than joining this one: the outer quarter. */
const DROP_EDGE = 0.25

interface WorkspaceViewProps {
  ws: Workspace
  onChange: (next: (ws: Workspace) => Workspace) => void
  /** What stands in a tab. Called for every note and terminal tab whether or not it
   *  is the one showing — both keep something alive out of sight — and for other
   *  kinds only when they show. */
  render: (tab: Tab, active: boolean) => ReactNode
  /** A group with nothing open. */
  empty: ReactNode
  /** Ends a terminal tab's session — the app's to do, since a session belongs to
   *  the vault it runs in and the layout does not know which that is. */
  onEndSession: (session: string) => void
}

/**
 * The reading pane as panes: the tree measured into boxes, a tab strip over each
 * group, a handle on each split, and **every tab's viewer as its own element**
 * placed over its group's box — so a tab carried to another pane is the same
 * element in a new place, and a terminal carried across keeps its shell. Every act
 * here is an operation on the model; nothing is decided in the DOM.
 */
export function WorkspaceView({ ws, onChange, render, empty, onEndSession }: WorkspaceViewProps) {
  const boxes = new Map<number, Rect>()
  const handles: Handle[] = []
  measure(ws.layout, { x: 0, y: 0, w: 1, h: 1 }, boxes, handles)
  const many = boxes.size > 1
  /** A tab is being dragged: every pane grows a drop target over its body. */
  const [dragging, setDragging] = useState(false)
  const groups = [...boxes.entries()].map(([id, rect]) => ({
    group: findGroup(ws.layout, id)!,
    rect,
  }))

  return (
    <div className="workspace-body">
      {groups.map(({ group, rect }) => (
        <PaneGroup
          key={group.id}
          group={group}
          rect={rect}
          focused={group.id === ws.focused}
          many={many}
          dragging={dragging}
          onDragging={setDragging}
          onChange={onChange}
          empty={empty}
          onEndSession={onEndSession}
        />
      ))}
      {handles.map((handle) => (
        <SplitHandle
          key={handle.id}
          handle={handle}
          onRatio={(ratio) => onChange((current) => resizeSplit(current, handle.id, ratio))}
        />
      ))}
      {groups.flatMap(({ group, rect }) =>
        group.tabs.map((tab, index) => {
          const active = index === group.active
          // A note keeps its buffer and a terminal its shell out of sight; the
          // other kinds are the same everywhere and are drawn only when they show.
          if (!active && tab.kind !== 'note' && tab.kind !== 'terminal') return null
          return (
            <div
              key={tab.id}
              className="viewer"
              hidden={!active}
              data-focused={group.id === ws.focused}
              style={
                {
                  left: pct(rect.x),
                  width: pct(rect.w),
                  top: `calc(${pct(rect.y)} + var(--strip-h))`,
                  height: `calc(${pct(rect.h)} - var(--strip-h))`,
                } as CSSProperties
              }
              onMouseDownCapture={() =>
                group.id !== ws.focused && onChange((current) => focusGroup(current, group.id))
              }
            >
              {render(tab, active)}
            </div>
          )
        })
      )}
    </div>
  )
}

function findGroup(layout: Layout, id: number): Group | null {
  if (layout.kind === 'group') return layout.group.id === id ? layout.group : null
  return findGroup(layout.first, id) ?? findGroup(layout.second, id)
}

function PaneGroup({
  group,
  rect,
  focused,
  many,
  dragging,
  onDragging,
  onChange,
  empty,
  onEndSession,
}: {
  group: Group
  rect: Rect
  focused: boolean
  many: boolean
  dragging: boolean
  onDragging: (dragging: boolean) => void
  onChange: WorkspaceViewProps['onChange']
  empty: ReactNode
  onEndSession: WorkspaceViewProps['onEndSession']
}) {
  /** The tab a right-click landed on, read when the menu's items are built. */
  const menuFor = useRef(0)
  const [menu, openMenu] = useContextMenu(() => {
    const index = menuFor.current
    const tab = group.tabs[index]
    return [
      { label: 'Close', onSelect: () => onChange((ws) => closeTab(ws, group.id, index)) },
      { label: 'Close others', onSelect: () => onChange((ws) => closeOtherTabs(ws, group.id, index)) },
      /**
       * **Closing a terminal tab detaches, so ending one is its own item.** Without
       * this the sessions only accumulate: every tab you ever closed is still a
       * shell the tmux server is holding, with `claude` possibly still in it and no
       * way to reach it from here. The offer is on a terminal tab alone, because it
       * is the one kind whose tab and whose session are different lifetimes.
       */
      ...(tab?.kind === 'terminal'
        ? [
            {
              label: 'End session',
              onSelect: () => {
                onEndSession(tab.session)
                onChange((ws) => closeTab(ws, group.id, index))
              },
            },
          ]
        : []),
      { label: 'Split right', onSelect: () => onChange((ws) => splitGroup(ws, group.id, 'row')) },
      { label: 'Split down', onSelect: () => onChange((ws) => splitGroup(ws, group.id, 'column')) },
    ]
  })
  /** A tab is being dragged over this strip. */
  const [receiving, setReceiving] = useState(false)
  /** A tab is being dragged over the pane's body, and where it would land. */
  const [zone, setZone] = useState<DropZone | null>(null)

  /**
   * **A tab is moved by dragging it** — onto another tab to land before it, or onto
   * a strip's empty end to land last — between panes or within one. The model does
   * the move; this only says where the pointer let go.
   */
  const dropAt = (index?: number) => (event: DragEvent) => {
    const from = carried(event)
    if (!from) return
    event.preventDefault()
    event.stopPropagation()
    setReceiving(false)
    onDragging(false)
    onChange((ws) => moveTab(ws, from, { groupId: group.id, index }))
  }
  const allowDrop = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(TAB_DRAG)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setReceiving(true)
  }
  /**
   * **Dragging a page to a pane's edge gives it a pane of its own there.** The
   * outer quarter of the body on each side is that side; the middle joins the
   * pane. The target is an overlay that exists only while a tab is being dragged,
   * over the viewer, so what is under it is never touched.
   */
  const zoneAt = (event: DragEvent): DropZone => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return 'centre'
    const x = (event.clientX - box.left) / box.width
    const y = (event.clientY - box.top) / box.height
    if (x < DROP_EDGE) return 'left'
    if (x > 1 - DROP_EDGE) return 'right'
    if (y < DROP_EDGE) return 'top'
    if (y > 1 - DROP_EDGE) return 'bottom'
    return 'centre'
  }
  const active = group.tabs[group.active] ?? null

  return (
    <section
      className="pane-group"
      data-focused={focused}
      style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
      // Capture, so a press anywhere in the pane — a tab, the strip, the empty body
      // — focuses the group before the press does its own work.
      onMouseDownCapture={() => !focused && onChange((ws) => focusGroup(ws, group.id))}
    >
      <div
        className={receiving ? 'tab-strip drag-over' : 'tab-strip'}
        role="tablist"
        onDragOver={allowDrop}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setReceiving(false)
        }}
        onDrop={dropAt()}
      >
        {group.tabs.map((tab, index) => {
          const label = tabLabel(tab)
          return (
            // A `div` with the role, not a `<button>`: the close control inside it
            // is a button, and a button cannot hold one.
            <div
              key={tab.id}
              role="tab"
              className="tab"
              aria-selected={index === group.active}
              title={tab.kind === 'note' ? tab.file.path : label}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(TAB_DRAG, `${group.id}:${index}`)
                event.dataTransfer.effectAllowed = 'move'
                onDragging(true)
              }}
              onDragEnd={() => onDragging(false)}
              onDragOver={allowDrop}
              onDrop={dropAt(index)}
              onMouseDown={(event) => {
                if (event.button !== 0) return
                onChange((ws) => activateTab(ws, group.id, index))
              }}
              onContextMenu={(event) => {
                menuFor.current = index
                openMenu(event)
              }}
            >
              <span className="tab-name">{label}</span>
              <button
                className="tab-close"
                aria-label={`Close ${label}`}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => onChange((ws) => closeTab(ws, group.id, index))}
              >
                ×
              </button>
            </div>
          )
        })}
        {/* `sidebar-actions` for the icon button's box, colours and hover, which
            are measured there — the rail and the footer borrow it the same way. */}
        <span className="tab-strip-actions sidebar-actions">
          <button aria-label="Split right" onClick={() => onChange((ws) => splitGroup(ws, group.id, 'row'))}>
            <SplitIcon direction="row" />
          </button>
          <button aria-label="Split down" onClick={() => onChange((ws) => splitGroup(ws, group.id, 'column'))}>
            <SplitIcon direction="column" />
          </button>
          {many && group.tabs.length === 0 && (
            <button aria-label="Close pane" onClick={() => onChange((ws) => closeGroup(ws, group.id))}>
              ×
            </button>
          )}
        </span>
      </div>
      {menu}
      <div className="pane-body">
        {!active && <div className="viewer viewer-inline">{empty}</div>}
        {dragging && (
          <div
            className="pane-drop"
            data-zone={zone ?? undefined}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(TAB_DRAG)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setZone(zoneAt(event))
            }}
            onDragLeave={() => setZone(null)}
            onDrop={(event) => {
              const from = carried(event)
              setZone(null)
              onDragging(false)
              if (!from) return
              event.preventDefault()
              event.stopPropagation()
              const at = zoneAt(event)
              onChange((ws) => dropTab(ws, from, group.id, at))
            }}
          />
        )}
      </div>
    </section>
  )
}

/**
 * The handle on the line between a split's halves, placed by the split's own box.
 * Pointer capture, as the sidebar's resizer: the matching `pointerup` then arrives
 * even if the pointer leaves the strip. The ratio is the pointer's place along the
 * split's own extent.
 */
function SplitHandle({ handle, onRatio }: { handle: Handle; onRatio: (ratio: number) => void }) {
  const dragging = useRef(false)
  const row = handle.direction === 'row'
  const { rect, ratio } = handle
  const style: CSSProperties = row
    ? { left: pct(rect.x + rect.w * ratio), top: pct(rect.y), height: pct(rect.h) }
    : { top: pct(rect.y + rect.h * ratio), left: pct(rect.x), width: pct(rect.w) }
  return (
    <div
      className="split-handle"
      role="separator"
      aria-label="Resize the panes"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      style={style}
      onPointerDown={(event) => {
        event.preventDefault()
        dragging.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        // The handle is laid over the workspace body and measures the ratio in it;
        // asked before the tree is in the document, there is nothing to measure.
        const workspace = dragging.current ? event.currentTarget.parentElement : null
        if (!workspace) return
        const body = workspace.getBoundingClientRect()
        const along = row
          ? (event.clientX - body.left) / body.width
          : (event.clientY - body.top) / body.height
        onRatio(row ? (along - rect.x) / rect.w : (along - rect.y) / rect.h)
      }}
      onPointerUp={(event) => {
        dragging.current = false
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
      onDoubleClick={() => onRatio(SPLIT.even)}
    />
  )
}

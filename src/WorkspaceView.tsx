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

/** The drag's payload: the carried tab, as `group:index`. */
const TAB_DRAG = 'application/x-journeys-tab'

function carried(event: DragEvent): { groupId: number; index: number } | null {
  const raw = event.dataTransfer.getData(TAB_DRAG)
  if (!raw) return null
  const [groupId, index] = raw.split(':').map(Number)
  return Number.isFinite(groupId) && Number.isFinite(index) ? { groupId, index } : null
}

/** A box as fractions of the workspace: where the tree puts a group. */
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
 * The tree is read for boxes, not drawn as nested DOM. Every group is a box and every
 * split a handle, all in one flat list keyed by id. Nested, a split made a new parent,
 * React remounted everything under it, and a terminal in the pane lost its shell.
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

/**
 * How far into a pane, as a share of its side, a dropped tab
 * makes a new pane on that side: the outer quarter.
 */
const DROP_EDGE = 0.25

interface WorkspaceViewProps {
  ws: Workspace
  onChange: (next: (ws: Workspace) => Workspace) => void
  /**
   * What a tab shows. Called for every note and terminal tab, shown or not, since
   * both keep something alive out of sight; for other kinds only when shown.
   */
  render: (tab: Tab, active: boolean) => ReactNode
  /** A group with nothing open. */
  empty: ReactNode
  /**
   * Ends a terminal tab's session. The app does it, since the
   * session belongs to the vault.
   */
  onEndSession: (session: string) => void
}

/**
 * The reading pane as panes: the tree measured into boxes, a tab strip over each
 * group, a handle on each split, and each tab's viewer as its own element over its
 * group's box. A tab moved to another pane is the same element in a new place, so
 * a terminal keeps its shell. Every change is an operation on the model.
 */
export function WorkspaceView({ ws, onChange, render, empty, onEndSession }: WorkspaceViewProps) {
  const boxes = new Map<number, Rect>()
  const handles: Handle[] = []
  measure(ws.layout, { x: 0, y: 0, w: 1, h: 1 }, boxes, handles)
  const many = boxes.size > 1
  /** A tab is being dragged: every pane shows a drop target. */
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
          // A note keeps its buffer and a terminal its shell
          // while hidden; other kinds are drawn only when shown.
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
  /** The tab that was right-clicked, read when the menu is built. */
  const menuFor = useRef(0)
  const [menu, openMenu] = useContextMenu(() => {
    const index = menuFor.current
    const tab = group.tabs[index]
    return [
      { label: 'Close', onSelect: () => onChange((ws) => closeTab(ws, group.id, index)) },
      { label: 'Close others', onSelect: () => onChange((ws) => closeOtherTabs(ws, group.id, index)) },
      /**
       * Closing a terminal tab only detaches, so ending the session is its own
       * item. Otherwise sessions pile up in the tmux server with no way back
       * to them. Only on terminal tabs, whose tab and session live apart.
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
   * Drag a tab onto another tab to put it before that one, or onto a
   * strip's empty end to put it last, in any pane. The model does the move.
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
   * Drag a tab to a pane's edge to give it a pane there: the
   * outer quarter on each side is that side; the middle joins the
   * pane. The target is an overlay shown only while dragging.
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
      // Capture, so a press anywhere in the pane focuses the group first.
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
            // A `div` with the role, not a `<button>`: it holds
            // the close button, and a button cannot hold a button.
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
        {/* `sidebar-actions` gives the icon buttons their box,
            colours and hover, as the rail and footer use it. */}
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
 * The handle between a split's halves, placed by the split's box.
 * Pointer capture, as in the sidebar's resizer, so `pointerup` arrives
 * even off the strip. The ratio is the pointer's place along the split.
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
        // The handle measures the ratio in the workspace body. Before
        // the tree is in the document there is nothing to measure.
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

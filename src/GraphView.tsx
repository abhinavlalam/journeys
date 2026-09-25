import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { boundsOf, initialLayout, settle, stepLayout } from './graph'
import type { GraphNode, LayoutState, NoteGraph } from './graph'

/**
 * The note graph, drawn.
 *
 * **Presentational, and deliberately given no filesystem.** `vault.ts` is the only
 * module allowed to import `@tauri-apps/plugin-fs`, and `App` is the only caller
 * with a vault to read — so the graph arrives here already built and this file
 * mounts under a test with no disk mocked at all.
 *
 * What it owns is the one thing `graph.ts` refuses to: the frame. The model exposes
 * `stepLayout` as a pure step precisely so the animation lives out here, which means
 * the two failure modes are out here too — a `requestAnimationFrame` loop that never
 * stops, and one that outlives the component holding a stale graph. Both are
 * addressed in `useAnimatedLayout` below, and both have a test.
 */

/** Room for a node's own radius plus the label under it, so neither is clipped. */
const BOX_PADDING = 40
/** Radius at degree 0, and how fast it grows, clamped by `NODE_R_MAX`. */
const NODE_R = 4.5
const NODE_R_STEP = 0.9
const NODE_R_MAX = 11
/** Where a label sits below the circle it belongs to, in screen pixels. */
const LABEL_OFFSET = 6
/**
 * **The zoom range, and why there is one at all.** The layout used to be re-fitted
 * into the pane on every frame: the whole graph squeezed into the pane, which for anything past a handful
 * of notes is a knot of overlapping discs with every label on at once — reported as
 * unusable, and it was. A graph is read by moving around it, so the pane now owns a
 * transform the pointer drives and the layout is left in its own space.
 */
const ZOOM_MIN = 0.15
const ZOOM_MAX = 5
/** Wheel notch to scale factor. Small enough that a trackpad is not a jump cut. */
const ZOOM_RATE = 0.0015
/** What `+` and `−` multiply the zoom by. */
const ZOOM_STEP = 1.3
/** An edge thickens by this share of a hairline for every link past the first, up to
 *  the most; two notes that cite each other ten times are not ten lines thick. */
const EDGE_WIDTH = { step: 0.5, max: 3 }
/** The zoom a `Fit` lands on at most, so a two-note graph is not drawn enormous. */
const FIT_MAX = 1.2

/** Opacity for what is not connected to the hovered node. */
const DIM = 0.12

/**
 * The label's size on screen, in pixels, and **the only place it is written.**
 *
 * It has to be here rather than in the sheet: a label is counter-scaled by the zoom
 * so a name keeps one readable size at every magnification, which is arithmetic the
 * renderer does. It was in three places — this, a bare `11` at the point of use, and
 * a `font-size` in `.graph-label` that never applied because the inline attribute
 * beats it. The sheet's rule now sets everything about a label except its size.
 */
const LABEL_PX = 11
/**
 * Width of a character as a share of the size, for deciding which labels fit.
 *
 * The same 0.516 `settings.ts` falls back to when there is no document to measure
 * in — and this is that case, because a label is drawn into an SVG before anything
 * has laid it out. It only has to be close: it decides whether two names *collide*,
 * and a name that is a few pixels out either way is a name that nearly collided.
 */
const EM_PER_CHARACTER = 0.516
/** Air around a label before it counts as touching its neighbour. */
const LABEL_GAP = 4

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/** jsdom has no `matchMedia`, and neither does a plain Node import of this file. */
function reducedMotionQuery(): MediaQueryList | null {
  return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(REDUCED_MOTION) : null
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false)
  useEffect(() => {
    const query = reducedMotionQuery()
    // A stub that answers `matches` and nothing else is the normal shape of one in
    // a test, so the listener is optional rather than assumed.
    if (!query?.addEventListener) return
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * The animated layout for a graph, and the whole lifetime of the frame loop.
 *
 * Four properties, each of which has been a bug in some graph view somewhere:
 *
 * - **It stops.** The next frame is scheduled only while `converged` is false, and
 *   `graph.ts` anneals specifically so that is reached in a bounded number of
 *   steps. A loop still requesting frames over a settled picture is a battery bug,
 *   not a cosmetic one.
 * - **It is cancelled.** The effect's teardown cancels the pending frame, so
 *   closing the pane or unmounting ends it. Otherwise a callback already queued
 *   fires once more, against a graph nobody is showing.
 * - **It does not restart.** Positions carry across a graph change through
 *   `carried`, because the open note's edges are rebuilt live as the user types and
 *   re-seeding from `initialLayout` would throw the picture away every time. `step`
 *   goes back to 0 with them: the cooling clamp has to reopen or a node that has
 *   just appeared can never travel to its place, and reheating a near-settled
 *   layout is cheap because the forces on it are already small.
 * - **Frame zero is derived, not effected.** `seed` is a `useMemo` rather than the
 *   effect's first `setState`, because an effect commits a frame *late*: the render
 *   that first has a graph would draw an `.graph-canvas` with nothing in it, and
 *   then fill it in. It showed up as a flaky test — the canvas was on screen a
 *   render before any node was — and it would have been a visible blank flash.
 *   `state` therefore falls back to `seed` whenever the advanced state belongs to
 *   an older graph, which is what tagging it with `graph` is for.
 *
 * The box is deliberately **not** a dependency. Resizing re-maps the layout through
 * the view transform, which is pure, and must never re-simulate.
 */
function useAnimatedLayout(
  graph: NoteGraph | null,
  animate: boolean
): {
  state: LayoutState | null
  /** Hold a node at a point in simulation space. The sim keeps running around it. */
  hold: (id: string, x: number, y: number) => void
  /** Let go, so the forces have it again. */
  release: () => void
} {
  /** What the frames have made of `seed`, tagged with the graph it belongs to. */
  const [advanced, setAdvanced] = useState<{ graph: NoteGraph; state: LayoutState } | null>(null)
  /** The last committed state, for the next graph to start from. Written only from
      the effect, so the render stays a function of its inputs. */
  const carried = useRef<LayoutState | null>(null)
  /**
   * The node the pointer is holding, if any.
   *
   * **Pinning is a post-step override, and that is not a shortcut — it is what
   * pinning means.** The forces this node exerts on its neighbours are computed from
   * where the pointer put it, which is what makes them follow; the forces *on* it
   * are computed and then discarded, which is what makes it stay. So `stepLayout`
   * needs to know nothing about dragging and stays the pure step it is tested as.
   */
  const pinned = useRef<{ id: string; x: number; y: number } | null>(null)
  /** Bumped to reheat a settled layout: a drag has to restart the frame loop, and
      the loop's own termination condition is the thing standing in the way. */
  const [kick, setKick] = useState(0)

  const seed = useMemo(() => {
    if (!graph) return null
    const previous = carried.current
    const start: LayoutState = previous
      ? { ...previous, step: 0, maxSpeed: 0, converged: graph.nodes.length === 0 }
      : initialLayout(graph)
    // Reduced motion never animates, so its frame zero *is* the settled layout.
    return animate ? start : settle(graph, start)
  }, [graph, animate])

  // Frame zero, on its own effect and **before** the loop's, so a reheat does not
  // reset the progress the loop has made — which assigning this inside the loop's
  // effect would do on every `kick`.
  useEffect(() => {
    carried.current = seed
  }, [seed])

  useEffect(() => {
    const start = carried.current ?? seed
    if (!graph || !start || !animate) return
    if (start.converged && !pinned.current) return

    let frame = requestAnimationFrame(function tick() {
      const next = withPin(stepLayout(graph, carried.current ?? start), pinned.current)
      carried.current = next
      setAdvanced({ graph, state: next })
      // The one line that makes this terminate. A held node keeps it alive, which
      // is why `withPin` reports a pinned state as never converged.
      frame = next.converged ? 0 : requestAnimationFrame(tick)
    })
    return () => {
      if (frame) cancelAnimationFrame(frame)
    }
  }, [graph, seed, animate, kick])

  const hold = useCallback((id: string, x: number, y: number) => {
    pinned.current = { id, x, y }
    // Written straight in as well, so the node is under the pointer on this render
    // rather than one frame behind it — and so a reduced-motion view, which runs no
    // frames at all, can still be dragged.
    const from = carried.current
    if (from) {
      const next = withPin(from, pinned.current)
      carried.current = next
      setAdvanced((was) => (was ? { ...was, state: next } : was))
    }
    setKick((n) => n + 1)
  }, [])

  const release = useCallback(() => {
    if (!pinned.current) return
    pinned.current = null
    setKick((n) => n + 1)
  }, [])

  const state = advanced && advanced.graph === graph ? advanced.state : seed
  return { state, hold, release }
}

/** The held node put back where the pointer has it, and the layout declared unsettled
 *  so the loop keeps going while a drag is in progress. */
function withPin(
  state: LayoutState,
  pin: { id: string; x: number; y: number } | null
): LayoutState {
  if (!pin) return state
  return {
    ...state,
    converged: false,
    nodes: state.nodes.map((node) =>
      node.id === pin.id ? { ...node, x: pin.x, y: pin.y, vx: 0, vy: 0 } : node
    ),
  }
}

/** The pane's own size, for the view transform. Zero until something lays it out,
    which in jsdom is never, so everything downstream has to survive a 0x0 box. */
function useBoxSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      // The clamp and the finiteness check together are the only reason a NaN
      // cannot reach the view transform from here.
      const width = Number.isFinite(rect.width) ? Math.max(rect.width, 0) : 0
      const height = Number.isFinite(rect.height) ? Math.max(rect.height, 0) : 0
      setSize((was) => (was.width === width && was.height === height ? was : { width, height }))
    }
    measure()
    // jsdom has no `ResizeObserver` either.
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/** The map from simulation space to the pane: `screen = world * k + (x, y)`. */
interface View {
  x: number
  y: number
  k: number
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

const EMPTY: ReadonlySet<string> = new Set()

/** The view that puts `state` in the middle of a `width`×`height` box. */
function fitView(state: LayoutState, width: number, height: number): View | null {
  const bounds = boundsOf(state)
  if (!bounds || width <= 0 || height <= 0) return null
  const innerW = Math.max(width - BOX_PADDING * 2, 1)
  const innerH = Math.max(height - BOX_PADDING * 2, 1)
  const spanX = bounds.maxX - bounds.minX
  const spanY = bounds.maxY - bounds.minY
  // A single node, or several on one point, has no span — scale 1 and centre it.
  const k = clamp(
    Math.min(spanX > 0 ? innerW / spanX : FIT_MAX, spanY > 0 ? innerH / spanY : FIT_MAX),
    ZOOM_MIN,
    FIT_MAX
  )
  return {
    k,
    x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
    y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
  }
}

/**
 * Which notes are named when nothing is hovered: **the ones that earn it**, most
 * connected first, skipping any whose name would land on a name already placed.
 *
 * The resting graph was the complaint — the hover reads well and the rest did not —
 * and the measurement said why. On the vault this was found in: 108 nodes, 198
 * edges, and a fit zoom of 0.663 against a threshold of 0.75, so **no labels at
 * all**. A hundred anonymous dots in a web of two hundred lines is a picture of
 * nothing; the threshold was meant to stop a soup of overlapping names and instead
 * removed every name there was.
 *
 * Both were the same mistake, which is deciding by *zoom* — a number that says
 * nothing about whether two particular names are on top of each other. Deciding by
 * collision says exactly that, so the graph names as much as it has room for and no
 * more, at every zoom, and more names simply appear as you zoom in. Measured on the
 * same vault: 27 of the 108 labels collided with another, so a greedy pass drops
 * about a quarter and keeps the hubs.
 *
 * Degree is the order because a hub is what orients you in a graph — if only one
 * name can be drawn in a region, it should be the one the region is about. The open
 * note is placed first whatever its degree, since "where am I" outranks that.
 */
export function decluttered(
  graph: NoteGraph,
  at: ReadonlyMap<string, { x: number; y: number }>,
  k: number,
  currentId: string | null
): ReadonlySet<string> {
  const order = [...graph.nodes].sort((a, b) => {
    if (a.id === currentId) return -1
    if (b.id === currentId) return 1
    return (graph.degree.get(b.id) ?? 0) - (graph.degree.get(a.id) ?? 0)
  })
  const placed: { l: number; r: number; t: number; b: number }[] = []
  const shown = new Set<string>()
  for (const node of order) {
    const p = at.get(node.id)
    if (!p) continue
    // Screen space, translation left out: it shifts every box alike and so cannot
    // change which two of them touch.
    const width = Math.max(node.name.length * LABEL_PX * EM_PER_CHARACTER, LABEL_PX) + LABEL_GAP
    const x = p.x * k
    const y = p.y * k
    const box = { l: x - width / 2, r: x + width / 2, t: y, b: y + LABEL_PX + LABEL_GAP }
    if (placed.some((one) => box.l < one.r && one.l < box.r && box.t < one.b && one.t < box.b)) {
      continue
    }
    placed.push(box)
    shown.add(node.id)
  }
  return shown
}

/**
 * Who is next to whom, for the hover.
 *
 * **Hovering a node names it and everything it touches**, and dims the rest — asked
 * for in those words, and it is the one interaction that turns a hairball into
 * something you can read: a graph answers "what is this connected to", and pointing
 * is how you ask. Built off the edges the graph already has, both ways, because an
 * edge is a connection whichever end you are standing on.
 */
function neighboursOf(graph: NoteGraph | null): ReadonlyMap<string, ReadonlySet<string>> {
  const near = new Map<string, Set<string>>()
  if (!graph) return near
  const pair = (from: string, to: string) => {
    const set = near.get(from) ?? new Set<string>()
    set.add(to)
    near.set(from, set)
  }
  for (const edge of graph.edges) {
    pair(edge.from, edge.to)
    pair(edge.to, edge.from)
  }
  return near
}

interface GraphViewProps {
  /** Null before the first read has finished. */
  graph: NoteGraph | null
  /** True while the vault is being read, so the pane can say so. */
  loading: boolean
  /** `pathKey` of the open note, marked `.current`. Null when none is open. */
  currentId: string | null
  /**
   * A node was clicked. Every node reports, `exists: false` included: what to do
   * about a link with no note behind it is the caller's decision and not the
   * renderer's.
   */
  onSelect: (node: GraphNode) => void
}

export function GraphView({ graph, loading, currentId, onSelect }: GraphViewProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const size = useBoxSize(boxRef)
  const reduced = usePrefersReducedMotion()
  const { state, hold, release } = useAnimatedLayout(graph, !reduced)
  const near = useMemo(() => neighboursOf(graph), [graph])

  const [view, setView] = useState<View | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  /**
   * The gesture in progress. A node drag and a pan are the same three events, so
   * they are one piece of state; `moved` is what tells a click from a drag, because
   * a press that travelled is not a press on a note.
   */
  const gesture = useRef<
    | { kind: 'pan'; startX: number; startY: number; from: View }
    | { kind: 'node'; id: string; node: GraphNode; moved: boolean }
    | null
  >(null)
  /** Set on the pointer-up of a gesture that travelled, read and cleared by the
      click that follows it. See `onUp`. */
  const dragged = useRef(false)
  /** Fitted once, when there is first both a layout and a box to fit it in. After
      that the view is the user's: a graph is rebuilt on every keystroke in a note,
      and re-fitting on that would snatch the picture back each time. */
  const fitted = useRef(false)

  /** By id, because the edge loop asks for both ends of every edge. */
  const placed = useMemo(
    () => (state ? new Map(state.nodes.map((node) => [node.id, node])) : null),
    [state]
  )

  // The first fit, and the only automatic one.
  useEffect(() => {
    if (fitted.current || !state || size.width <= 0) return
    const next = fitView(state, size.width, size.height)
    if (!next) return
    fitted.current = true
    setView(next)
  }, [state, size.width, size.height])

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect()
      const current = view
      if (!rect || !current) return null
      return {
        x: (clientX - rect.left - current.x) / current.k,
        y: (clientY - rect.top - current.y) / current.k,
      }
    },
    [view]
  )

  /**
   * One pointer gesture, on the window rather than on the element.
   *
   * A drag that leaves the pane still has to finish: listeners on the node would
   * stop firing the moment the pointer outran it, which is exactly when a graph is
   * being pulled apart. Registered per gesture and removed with it.
   */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const active = gesture.current
      if (!active) return
      if (active.kind === 'pan') {
        setView({
          ...active.from,
          x: active.from.x + (event.clientX - active.startX),
          y: active.from.y + (event.clientY - active.startY),
        })
        return
      }
      // Marked before the mapping, because the pointer moved whether or not we can
      // say where to: with no laid-out box there is no view to map through, and a
      // drag would otherwise still be reported as a click.
      active.moved = true
      const world = toWorld(event.clientX, event.clientY)
      if (!world) return
      hold(active.id, world.x, world.y)
    }
    const onUp = () => {
      const active = gesture.current
      gesture.current = null
      if (!active) return
      if (active.kind === 'node') {
        release()
        // **A drag is not a click**, and the browser will send one anyway: a press
        // and a release on the same element is a click however far the pointer went
        // in between. So the click that follows a *moved* gesture is swallowed,
        // rather than selection being moved off `click` altogether — which would
        // cost the keyboard and every assistive path that synthesises one.
        dragged.current = active.moved
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [toWorld, hold, release])

  /**
   * The wheel zooms **about the pointer**, so whatever is under it stays under it.
   *
   * Solve `screen = world * k + t` for the new translation with `world` fixed. Zoom
   * that ignores the pointer and scales about a corner is the thing that makes a
   * graph view feel broken, because the node you were reading leaves the pane.
   *
   * Not React's `onWheel`: that is passive, so `preventDefault` there is refused and
   * the whole pane scrolls behind the zoom.
   */
  useEffect(() => {
    const element = svgRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      setView((current) => {
        if (!current) return current
        const k = clamp(current.k * Math.exp(-event.deltaY * ZOOM_RATE), ZOOM_MIN, ZOOM_MAX)
        const rect = element.getBoundingClientRect()
        const sx = event.clientX - rect.left
        const sy = event.clientY - rect.top
        return {
          k,
          x: sx - ((sx - current.x) / current.k) * k,
          y: sy - ((sy - current.y) / current.k) * k,
        }
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  /** Zoom by a factor about the middle of the pane, for the buttons. */
  const zoomBy = (factor: number) =>
    setView((current) => {
      if (!current) return current
      const k = clamp(current.k * factor, ZOOM_MIN, ZOOM_MAX)
      const cx = size.width / 2
      const cy = size.height / 2
      return {
        k,
        x: cx - ((cx - current.x) / current.k) * k,
        y: cy - ((cy - current.y) / current.k) * k,
      }
    })

  if (!graph || graph.nodeCount === 0) {
    return (
      <div className="graph-view" ref={boxRef}>
        <p className="graph-empty">
          {loading ? 'Reading every note…' : 'No links yet. Type [[ in a note to make one.'}
        </p>
      </div>
    )
  }

  const k = view?.k ?? 1
  const lit = hovered ? new Set([hovered, ...(near.get(hovered) ?? [])]) : null
  // Only when nothing is hovered: the hover names its own set and dims the rest, so
  // there is nothing to declutter against.
  const names = lit || !placed ? EMPTY : decluttered(graph, placed, k, currentId)
  // Constant on screen whatever the zoom: a hairline is a hairline, and a name has
  // one readable size. Positions scale, these do not.
  const hair = 1 / k
  const labelSize = LABEL_PX / k

  return (
    <div className="graph-view" ref={boxRef}>
      <svg
        className="graph-canvas"
        ref={svgRef}
        width={size.width}
        height={size.height}
        aria-label="Note graph"
        data-panning={gesture.current?.kind === 'pan' ? '' : undefined}
        onPointerDown={(event) => {
          // The background: a press here moves the view. A node stops this from
          // reaching us, so anything that gets here is empty space.
          if (event.button !== 0 || !view) return
          gesture.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, from: view }
        }}
      >
        <g transform={`translate(${view?.x ?? 0},${view?.y ?? 0}) scale(${k})`}>
          {graph.edges.map((edge) => {
            const from = placed?.get(edge.from)
            const to = placed?.get(edge.to)
            if (!from || !to) return null
            // **The hovered node's own edges, not every edge between lit nodes.**
            // Read off `hovered` rather than the lit set, which also holds the
            // neighbours — so hovering a spoke lit the hub's *other* edge too, and
            // the highlight said "these are connected" about a pair that only
            // shared an acquaintance. Caught by a test that counted the faded ones.
            const on = !hovered || edge.from === hovered || edge.to === hovered
            return (
              <line
                key={`${edge.from} ${edge.to}`}
                className="graph-edge"
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                strokeWidth={Math.min(1 + (edge.weight - 1) * EDGE_WIDTH.step, EDGE_WIDTH.max) * hair}
                opacity={on ? 1 : DIM}
              />
            )
          })}
          {graph.nodes.map((node) => {
            const at = placed?.get(node.id)
            if (!at) return null
            const degree = graph.degree.get(node.id) ?? 0
            const radius = Math.min(NODE_R + degree * NODE_R_STEP, NODE_R_MAX)
            const classes = ['graph-node']
            if (!node.exists) classes.push('missing')
            if (node.id === currentId) classes.push('current')
            const on = !lit || lit.has(node.id)
            // Named when the pointer asks, or when nothing is hovered and the name
            // has room — see `decluttered`.
            const named = lit ? lit.has(node.id) : names.has(node.id)
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={node.exists ? node.name : `${node.name} (no note yet)`}
                opacity={on ? 1 : DIM}
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  // Or the background would pan at the same time.
                  event.stopPropagation()
                  gesture.current = { kind: 'node', id: node.id, node, moved: false }
                }}
                onClick={() => {
                  if (dragged.current) {
                    dragged.current = false
                    return
                  }
                  onSelect(node)
                }}
                onPointerEnter={() => setHovered(node.id)}
                onPointerLeave={() => setHovered((was) => (was === node.id ? null : was))}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSelect(node)
                }}
              >
                <circle className={classes.join(' ')} cx={at.x} cy={at.y} r={radius} />
                {named && (
                  <text
                    className="graph-label"
                    x={at.x}
                    y={at.y + radius + LABEL_OFFSET * hair}
                    fontSize={labelSize}
                    strokeWidth={3 * hair}
                  >
                    {node.name}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>
      <div className="graph-controls">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </button>
        <button
          type="button"
          aria-label="Fit to view"
          onClick={() => state && setView(fitView(state, size.width, size.height))}
        >
          Fit
        </button>
      </div>
      <p className="graph-stats">
        {loading ? 'Reading every note…' : `${graph.nodeCount} notes · ${graph.edgeCount} links`}
      </p>
    </div>
  )
}

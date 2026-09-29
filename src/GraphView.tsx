import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { around, boundsOf, clustersOf, connectionsOf, EDGE_KINDS, everything, polar, REGION_PAD, ringLayout } from './graph'
import type { EdgeKind, GraphNode, NoteGraph, Placed, Region, Sector } from './graph'
import { countOf } from './rows'

/**
 * The note graph, drawn. It is given the graph already built, so
 * it mounts in a test with no disk.
 *
 * The picture is laid out before it is drawn, is the same every time,
 * and moves only when what is asked changes. Around this note, or
 * everything; three checkboxes choose what counts as a connection.
 */

/** Room for a node's radius and the label under it, so neither is clipped. */
const BOX_PADDING = 40
/**
 * Radius with no connections, and how much each connection adds, up to `NODE_R_MAX`.
 */
const NODE_R = 4.5
const NODE_R_STEP = 0.9
const NODE_R_MAX = 11
/** How far below its circle a label sits, in screen pixels. */
const LABEL_OFFSET = 6
/**
 * The zoom range. The pane has a transform the pointer drives,
 * rather than squeezing the layout into the pane.
 */
const ZOOM_MIN = 0.15
const ZOOM_MAX = 5
/** Wheel movement to scale factor, small enough that a trackpad scrolls smoothly. */
const ZOOM_RATE = 0.0015
/** What `+` and `−` multiply the zoom by. */
const ZOOM_STEP = 1.3
/** An edge gets this much thicker per link past the first, up to `max`. */
const EDGE_WIDTH = { step: 0.5, max: 3 }
/** The most a Fit zooms in, so a two-note graph isn't enormous. */
const FIT_MAX = 1.2

/** Opacity of what isn't connected to the hovered node. */
const DIM = 0.12

/**
 * A label's size on screen and its halo's width, set as attributes scaled against the
 * zoom. Only here: a stylesheet rule would win over the attribute and undo the scaling.
 */
const LABEL_PX = 11
const LABEL_HALO = 3
/** A link held in a property is drawn dashed: dash and gap, on screen. */
const PROPERTY_DASH = [4, 3]
/**
 * A character's width as a share of the font size, for deciding which labels
 * fit. Labels are placed before layout, so this uses `settings.ts`'s
 * estimate; close is enough to tell whether two names overlap.
 */
const EM_PER_CHARACTER = 0.516
/** Space around a label before it counts as touching another. */
const LABEL_GAP = 4
/** The most of a name a label shows at rest. Hovering shows the rest. */
const LABEL_CHARS = 24

/**
 * A name as a label shows it at rest: whole if it fits, otherwise the words that do.
 */
export function shortName(name: string): string {
  if (name.length <= LABEL_CHARS) return name
  const words = name.slice(0, Math.max(name.lastIndexOf(' ', LABEL_CHARS - 1), 0)).replace(/[\s\-–—:,;]+$/, '')
  return `${words || name.slice(0, LABEL_CHARS - 1)}…`
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/** jsdom has no `matchMedia`, and nor does a plain Node import of this file. */
function reducedMotionQuery(): MediaQueryList | null {
  return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(REDUCED_MOTION) : null
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false)
  useEffect(() => {
    const query = reducedMotionQuery()
    // A test's stub may only have `matches`, so the listener is optional.
    if (!query?.addEventListener) return
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * Opacity of a line that is context rather than structure (across
 * the rings, or from a day or tag) until one of its ends is hovered.
 */
const QUIET = 0.3

/**
 * How long a glide to a new arrangement takes, in ms. It is animation
 * arithmetic, so it lives here, not in the sheet's `--motion`.
 */
const GLIDE_MS = 320

/** What each checkbox is called. */
const SHOWS_LABEL: Record<EdgeKind, string> = { text: 'Links in text', property: 'Links in properties', tag: 'Tags' }

/**
 * Calls `frame(eased)` on each frame of a glide, eased out, and returns
 * a way to stop it. A glide has a fixed length, so it always ends.
 */
function glideFrames(frame: (eased: number) => void): () => void {
  const start = performance.now()
  let handle = requestAnimationFrame(function tick() {
    const done = Math.min(1, (performance.now() - start) / GLIDE_MS)
    frame(1 - (1 - done) ** 3)
    handle = done < 1 ? requestAnimationFrame(tick) : 0
  })
  return () => cancelAnimationFrame(handle)
}

/**
 * Where each node is drawn: its target, reached by a glide from
 * where it was. A new node appears at its place. The first picture
 * is drawn in the first render, so the pane is never empty.
 */
function useGlide(targets: ReadonlyMap<string, Placed> | null, animate: boolean): ReadonlyMap<string, Placed> | null {
  const [shown, setShown] = useState(targets)
  const last = useRef(targets)
  useEffect(() => {
    const from = last.current
    if (from === targets) return
    if (!targets || !from || !animate) {
      last.current = targets
      setShown(targets)
      return
    }
    return glideFrames((eased) => {
      const next = new Map<string, Placed>()
      for (const [id, to] of targets) {
        const was = from.get(id)
        next.set(id, was ? { x: was.x + (to.x - was.x) * eased, y: was.y + (to.y - was.y) * eased } : to)
      }
      last.current = next
      setShown(next)
    })
  }, [targets, animate])
  return shown
}

/**
 * The pane's size, for the view transform. Zero until laid out, which
 * jsdom never does, so everything after this must handle a 0×0 box.
 */
function useBoxSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      // Clamped and checked for finite values, so no NaN reaches the view transform.
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

/** The map from layout space to the pane: `screen = world * k + (x, y)`. */
interface View {
  x: number
  y: number
  k: number
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

const EMPTY: ReadonlySet<string> = new Set()

/**
 * The gap between neighbouring sectors, along the inner rim;
 * without it, a ring of them reads as one band.
 */
const SECTOR_GAP = 6

/**
 * A sector's outline: the band between its radii over its angle, less the gap
 * each side, and short of a full turn (an arc whose ends meet draws nothing).
 */
function sectorPath({ inner, outer, ...sector }: Sector): string {
  const from = sector.from + SECTOR_GAP / inner
  const to = Math.min(sector.to - SECTOR_GAP / inner, from + 2 * Math.PI - 1e-3)
  const large = to - from > Math.PI ? 1 : 0
  const at = (r: number, angle: number) => `${polar(r, angle).x} ${polar(r, angle).y}`
  return `M ${at(outer, from)} A ${outer} ${outer} 0 ${large} 1 ${at(outer, to)} L ${at(inner, to)} A ${inner} ${inner} 0 ${large} 0 ${at(inner, from)} Z`
}

/** What a fit frames: every node, every region's disc, and every sector's name. */
const extentOf = (picture: { targets: ReadonlyMap<string, Placed>; regions: readonly Region[]; sectors: readonly Sector[] }) => [
  ...picture.targets.values(),
  ...picture.regions.flatMap((one) => [
    { x: one.x - one.r, y: one.y - one.r },
    { x: one.x + one.r, y: one.y + one.r },
  ]),
  ...picture.sectors.flatMap((one) => [one.from, (one.from + one.to) / 2, one.to].map((angle) => polar(one.outer + REGION_PAD, angle))),
]

/** The view that centres `points` in a `width` × `height` box. */
function fitView(points: Iterable<Placed>, width: number, height: number, top = 0): View | null {
  const bounds = boundsOf(points)
  if (!bounds || width <= 0 || height <= 0) return null
  const innerW = Math.max(width - BOX_PADDING * 2, 1)
  const innerH = Math.max(height - top - BOX_PADDING * 2, 1)
  const spanX = bounds.maxX - bounds.minX
  const spanY = bounds.maxY - bounds.minY
  // A single node, or several at one point, has no span: scale 1 and centre it.
  const k = clamp(
    Math.min(spanX > 0 ? innerW / spanX : FIT_MAX, spanY > 0 ? innerH / spanY : FIT_MAX),
    ZOOM_MIN,
    FIT_MAX
  )
  return {
    k,
    x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
    y: top + (height - top) / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
  }
}

/**
 * Which nodes are named when nothing is hovered. Decided by collision,
 * not zoom: a zoom threshold once left a hundred notes unnamed. The open
 * note goes first, then the most connected; a name that would overlap
 * one already placed is skipped. Zooming in makes room for more.
 */
export function decluttered(
  graph: NoteGraph,
  at: ReadonlyMap<string, Placed>,
  k: number,
  currentId: string | null,
  /** Already named by the region they are the hub of. */
  hubs: ReadonlySet<string> = EMPTY
): ReadonlySet<string> {
  const order = [...graph.nodes].sort((a, b) => {
    if (a.id === currentId) return -1
    if (b.id === currentId) return 1
    // Notes before days and tags, however busy: those connect
    // the groups, and a group is named by its notes.
    const bridges = Number(a.kind !== 'note') - Number(b.kind !== 'note')
    return bridges || (graph.degree.get(b.id) ?? 0) - (graph.degree.get(a.id) ?? 0)
  })
  const placed: { l: number; r: number; t: number; b: number }[] = []
  const shown = new Set<string>()
  for (const node of order) {
    const p = at.get(node.id)
    // A day is named only when pointed at: dates were a fifth of all the text.
    if (!p || ((node.kind === 'day' || hubs.has(node.id)) && node.id !== currentId)) continue
    // In screen space, without the translation, which shifts every box equally.
    const width = Math.max(shortName(node.name).length * LABEL_PX * EM_PER_CHARACTER, LABEL_PX) + LABEL_GAP
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
 * Who is next to whom, both ways, for the hover: hovering a node
 * names it and everything it touches, and dims the rest.
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

/**
 * Which kinds of connection are drawn: the checkboxes, stored as `settings.graphShows`.
 */
export type Shows = Readonly<Record<EdgeKind, boolean>>

interface GraphViewProps {
  /** Null until the first read finishes. */
  graph: NoteGraph | null
  /** True while the vault is being read, so the pane can say so. */
  loading: boolean
  /** `pathKey` of the open note: the centre, marked `.current`. */
  currentId: string | null
  shows: Shows
  onShows: (next: Shows) => void
  /**
   * A node was clicked. Every node reports, including `exists: false`; the
   * caller decides what to do about a link to a note that doesn't exist.
   */
  onSelect: (node: GraphNode) => void
}

export function GraphView({ graph, loading, currentId, shows, onShows, onSelect }: GraphViewProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const size = useBoxSize(boxRef)
  // The bar sits over the top of the picture, so a fit frames what is below it.
  const barRef = useRef<HTMLDivElement>(null)
  const barSize = useBoxSize(barRef)
  const reduced = usePrefersReducedMotion()
  const [scope, setScope] = useState<'around' | 'all'>('around')
  const [listing, setListing] = useState(false)

  const shown = useMemo(() => (graph ? connectionsOf(graph, shows) : null), [graph, shows])
  // The same graph means the same picture. Typing beside the graph
  // rebuilds it on every key; without this key, each keystroke
  // would re-run the layout, glide, and drop any dragged node.
  const shape = useMemo(() => shown && JSON.stringify([shown.graph.nodes, shown.graph.edges]), [shown])
  // Centred on the open note when it has connections.
  const centred = currentId && shown?.graph.byId.has(currentId) ? currentId : null
  const centre = scope === 'around' ? centred : null
  const picture = useMemo(() => {
    if (!shown) return null
    const clusters = clustersOf(shown.graph)
    if (centre) {
      const near = around(shown.graph, centre, clusters)
      const rings = ringLayout(near.rings, near.parents, clusters)
      const regions: Region[] = []
      return { graph: near.graph, targets: rings.at, parents: near.parents, regions, sectors: rings.sectors }
    }
    const all = everything(shown.graph, clusters)
    const sectors: Sector[] = []
    return { graph: shown.graph, targets: all.at, parents: null, regions: all.regions, sectors }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, centre])
  const glided = useGlide(picture?.targets ?? null, !reduced)
  /** Nodes the pointer has moved, where it left them, until the picture changes. */
  const [held, setHeld] = useState<ReadonlyMap<string, Placed>>(new Map())
  useEffect(() => setHeld(new Map()), [picture])
  const placed = useMemo(() => (glided && held.size > 0 ? new Map([...glided, ...held]) : glided), [glided, held])
  const near = useMemo(() => neighboursOf(picture?.graph ?? null), [picture])

  const [view, setView] = useState<View | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  /**
   * The gesture in progress. A node drag and a pan use the same
   * events, so they share state; `moved` tells a click from a drag.
   */
  const gesture = useRef<
    | { kind: 'pan'; startX: number; startY: number; from: View }
    | { kind: 'node'; id: string; node: GraphNode; moved: boolean }
    | null
  >(null)
  /**
   * Set when a gesture that moved ends; read and cleared by the
   * click that follows (see `onUp`).
   */
  const dragged = useRef(false)

  /**
   * Framed when what is looked at changes (scope, centre,
   * checkboxes), with a glide. Not when the same picture is
   * rebuilt by typing, which would snap the view back each time.
   */
  const framing = `${centre ?? ''}|${EDGE_KINDS.map((kind) => (shows[kind] ? 1 : 0)).join('')}`
  const framed = useRef<string | null>(null)
  useEffect(() => {
    if (!picture || size.width <= 0 || framed.current === framing) return
    const next = fitView(extentOf(picture), size.width, size.height, barSize.height)
    if (!next) return
    const from = framed.current === null || reduced ? null : view
    framed.current = framing
    if (!from) {
      setView(next)
      return
    }
    return glideFrames((eased) =>
      setView({
        k: from.k + (next.k - from.k) * eased,
        x: from.x + (next.x - from.x) * eased,
        y: from.y + (next.y - from.y) * eased,
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picture, framing, size.width, size.height, barSize.height, reduced])

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
   * The pointer's gestures, on the window rather than the node,
   * so a drag that outruns its node still finishes.
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
      // Marked moved before mapping: with no laid-out box there is no view
      // to map through, and the drag would otherwise count as a click.
      active.moved = true
      const world = toWorld(event.clientX, event.clientY)
      if (!world) return
      setHeld((was) => new Map(was).set(active.id, world))
    }
    const onUp = () => {
      const active = gesture.current
      gesture.current = null
      if (!active) return
      if (active.kind === 'node') {
        // A drag isn't a click, though the browser sends one: the
        // click after a moved gesture is ignored. Selection stays
        // on `click`, which the keyboard and assistive tools send.
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
  }, [toWorld])

  /**
   * The wheel zooms about the pointer (`screen = world * k + t` solved for the new
   * `t` with `world` fixed), so what is under it stays put. Not React's `onWheel`,
   * which is passive, so `preventDefault` would be refused and the pane would scroll.
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

  /** Zooms by a factor about the middle of the pane, for the buttons. */
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

  const bar = (
    <div className="graph-bar" ref={barRef}>
      <span className="view-switch" role="group" aria-label="What the graph shows">
        <button
          type="button"
          className="header-action"
          aria-pressed={centre !== null}
          disabled={!centred}
          onClick={() => setScope('around')}
        >
          Around this note
        </button>
        <button type="button" className="header-action" aria-pressed={centre === null} onClick={() => setScope('all')}>
          Everything
        </button>
      </span>
      {EDGE_KINDS.map((kind) => (
        <label key={kind} className="graph-check">
          <input
            type="checkbox"
            checked={shows[kind]}
            onChange={(event) => onShows({ ...shows, [kind]: event.target.checked })}
          />
          {SHOWS_LABEL[kind]}
        </label>
      ))}
      {shown && shown.unconnected.length > 0 && (
        <button type="button" className="header-action" aria-expanded={listing} onClick={() => setListing((was) => !was)}>
          {countOf(shown.unconnected.length, 'unconnected note')}
        </button>
      )}
    </div>
  )
  // The notes with no connection of the chosen kinds: not drawn, but listed.
  const unconnected = listing && shown && shown.unconnected.length > 0 && (
    <ul className="graph-unconnected" aria-label="Unconnected notes">
      {shown.unconnected.map((node) => (
        <li key={node.id}>
          <button type="button" onClick={() => onSelect(node)}>
            {node.name}
          </button>
        </li>
      ))}
    </ul>
  )

  if (!picture || picture.graph.nodeCount === 0) {
    return (
      <div className="graph-view" ref={boxRef}>
        {bar}
        {unconnected}
        <p className="graph-empty">
          {loading || !graph
            ? 'Reading every note…'
            : graph.nodeCount === 0
              ? 'No links yet. Type [[ in a note to make one.'
              : 'Nothing is connected by what is ticked.'}
        </p>
      </div>
    )
  }

  const drawn = picture.graph
  const k = view?.k ?? 1
  const lit = hovered ? new Set([hovered, ...(near.get(hovered) ?? [])]) : null
  // Only when nothing is hovered: a hover names its own set. A
  // region's busiest note is always inside it, so the region names it.
  const hubs = new Set(picture.regions.map((region) => region.members[0]))
  const names = lit || !placed ? EMPTY : decluttered(drawn, placed, k, currentId, hubs)
  // Constant on screen at any zoom: positions scale, line widths and label sizes don't.
  const hair = 1 / k
  const labelSize = LABEL_PX / k

  return (
    <div className="graph-view" ref={boxRef}>
      {bar}
      {unconnected}
      <svg
        className="graph-canvas"
        ref={svgRef}
        width={size.width}
        height={size.height}
        aria-label="Note graph"
        data-panning={gesture.current?.kind === 'pan' ? '' : undefined}
        onPointerDown={(event) => {
          // A press on the background pans. A node stops the
          // event, so anything reaching here is empty space.
          if (event.button !== 0 || !view) return
          gesture.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, from: view }
        }}
      >
        <g transform={`translate(${view?.x ?? 0},${view?.y ?? 0}) scale(${k})`}>
          {picture.regions.map((region) => {
            // Centred on its members where they are now, so a
            // region moves with a glide.
            const at = region.members.flatMap((id) => placed?.get(id) ?? [])
            const x = at.reduce((sum, p) => sum + p.x, 0) / at.length
            const y = at.reduce((sum, p) => sum + p.y, 0) / at.length
            return (
              <g key={region.members[0]} className="graph-region">
                <circle cx={x} cy={y} r={region.r} strokeWidth={hair} />
                <text x={x} y={y - region.r + REGION_PAD / 2} dominantBaseline="middle" fontSize={labelSize}>
                  {shortName(drawn.byId.get(region.members[0])!.name)}
                </text>
              </g>
            )
          })}
          {picture.sectors.map((sector) => {
            // Outside the rim, clear of the outer ring's labels.
            const name = polar(sector.outer + REGION_PAD / 2, (sector.from + sector.to) / 2)
            return (
              <g key={sector.members[0]} className="graph-region">
                <path d={sectorPath(sector)} strokeWidth={hair} />
                <text x={name.x} y={name.y} dominantBaseline="middle" fontSize={labelSize}>
                  {shortName(shown!.graph.byId.get(sector.members[0])!.name)}
                </text>
              </g>
            )
          })}
          {drawn.edges.map((edge) => {
            const from = placed?.get(edge.from)
            const to = placed?.get(edge.to)
            if (!from || !to) return null
            // Only the hovered node's own edges, not every edge between
            // lit nodes: hovering a spoke lit the hub's other edges too.
            const on = !hovered || edge.from === hovered || edge.to === hovered
            // The lines the picture is built on are full strength. Around a note:
            // from the centre, and from each outer node to its parent. In Everything:
            // links between notes. The rest are faint until an end is hovered.
            const { parents } = picture
            const leads = parents
              ? edge.from === centre || edge.to === centre || parents.get(edge.from) === edge.to || parents.get(edge.to) === edge.from
              : drawn.byId.get(edge.from)?.kind === 'note' && drawn.byId.get(edge.to)?.kind === 'note'
            const opacity = hovered ? (on ? 1 : DIM) : leads ? 1 : QUIET
            return (
              <line
                key={`${edge.from} ${edge.to} ${edge.kind}`}
                className={`graph-edge ${edge.kind}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                strokeWidth={Math.min(1 + (edge.weight - 1) * EDGE_WIDTH.step, EDGE_WIDTH.max) * hair}
                // A link held in a property is drawn dashed.
                strokeDasharray={edge.kind === 'property' ? PROPERTY_DASH.map((one) => one * hair).join(' ') : undefined}
                opacity={opacity}
              />
            )
          })}
          {drawn.nodes.map((node) => {
            const at = placed?.get(node.id)
            if (!at) return null
            // A note grows with its connections; a day or tag,
            // which connects everything, stays small.
            const degree = node.kind === 'note' ? (drawn.degree.get(node.id) ?? 0) : 0
            const radius = Math.min(NODE_R + degree * NODE_R_STEP, NODE_R_MAX)
            const classes = ['graph-node', node.kind]
            if (!node.exists) classes.push('missing')
            if (node.id === currentId) classes.push('current')
            const on = !lit || lit.has(node.id)
            // Named when hovered, or at rest when it has room (see `decluttered`).
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
                  // Or the background would pan too.
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
                    strokeWidth={LABEL_HALO * hair}
                  >
                    {node.id === hovered ? node.name : shortName(node.name)}
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
          onClick={() => setView(fitView(extentOf(picture), size.width, size.height, barSize.height))}
        >
          Fit
        </button>
      </div>
      <p className="graph-stats">
        {loading ? 'Reading every note…' : `${countOf(drawn.nodeCount, 'node')} · ${countOf(drawn.edgeCount, 'connection')}`}
      </p>
    </div>
  )
}

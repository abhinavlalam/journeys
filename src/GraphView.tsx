import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { around, boundsOf, clustersOf, connectionsOf, EDGE_KINDS, everything, polar, REGION_PAD, ringLayout } from './graph'
import type { EdgeKind, GraphNode, NoteGraph, Placed, Region, Sector } from './graph'
import { countOf } from './rows'

/**
 * The note graph, drawn.
 *
 * **Presentational, and deliberately given no filesystem.** `vault.ts` is the only
 * module allowed to import `@tauri-apps/plugin-fs`, and `App` is the only caller
 * with a vault to read — so the graph arrives here already built and this file
 * mounts under a test with no disk mocked at all.
 *
 * **Still.** It was a force simulation animated in front of the reader — the swirl,
 * and the crowd, since it drew every note at once — and was called confusing, with
 * "nothing visually smooth or understandable about it". Now the picture is laid out
 * before it is drawn, the same every time, and moves only when what is asked of it
 * changes, gliding from the old places to the new. **Around this note** is the note
 * in the middle, what it touches on a ring, and what those touch beyond; **Every­
 * thing** is the whole vault, settled first. Three checkboxes along the top say what
 * a connection is.
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
/** The most of a name a label shows at rest: a long one was a line of text across
 *  the picture, and the hover says the rest. */
const LABEL_CHARS = 24

/** A name as a label shows it at rest: whole if it fits, else the words that do. */
export function shortName(name: string): string {
  if (name.length <= LABEL_CHARS) return name
  const words = name.slice(0, Math.max(name.lastIndexOf(' ', LABEL_CHARS - 1), 0)).replace(/[\s\-–—:,;]+$/, '')
  return `${words || name.slice(0, LABEL_CHARS - 1)}…`
}

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

/** Opacity for a line that is context rather than structure — across the rings, or
 *  from a day or a tag — until one of its ends is hovered. */
const QUIET = 0.3

/** How long the picture takes to glide to a new arrangement, in milliseconds. It is
 *  arithmetic in the renderer, so it is here and not the sheet's `--motion`. */
const GLIDE_MS = 320

/** What each checkbox is called. */
const SHOWS_LABEL: Record<EdgeKind, string> = { text: 'Links in text', property: 'Links in properties', tag: 'Tags' }

/**
 * `frame(eased)` for each frame of a glide, eased out, and a way to stop it. The
 * one loop the view runs, and it **ends**: a glide is a fixed number of frames, so
 * nothing asks for another once the picture is where it is going.
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
 * Where each node is drawn: its place, reached by a glide from wherever it was. A
 * node new to the picture is simply at its place. The first picture is drawn where
 * it is — in the very first render, before any effect, so the pane is never empty.
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

/** The air between two sectors side by side, along the inner rim: touching, a ring
 *  of them read as one band. */
const SECTOR_GAP = 6

/** A sector's outline: the band between its radii over its angle less the gap each
 *  side, and short of a full turn, where an arc's two ends meet and draw nothing. */
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

/** The view that puts `points` in the middle of a `width`×`height` box. */
function fitView(points: Iterable<Placed>, width: number, height: number, top = 0): View | null {
  const bounds = boundsOf(points)
  if (!bounds || width <= 0 || height <= 0) return null
  const innerW = Math.max(width - BOX_PADDING * 2, 1)
  const innerH = Math.max(height - top - BOX_PADDING * 2, 1)
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
    y: top + (height - top) / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
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
  at: ReadonlyMap<string, Placed>,
  k: number,
  currentId: string | null,
  /** Named already, by the region each is the hub of. */
  hubs: ReadonlySet<string> = EMPTY
): ReadonlySet<string> {
  const order = [...graph.nodes].sort((a, b) => {
    if (a.id === currentId) return -1
    if (b.id === currentId) return 1
    // A note before a day or a tag, however busy: those join the groups, and a
    // group is named by its notes.
    const bridges = Number(a.kind !== 'note') - Number(b.kind !== 'note')
    return bridges || (graph.degree.get(b.id) ?? 0) - (graph.degree.get(a.id) ?? 0)
  })
  const placed: { l: number; r: number; t: number; b: number }[] = []
  const shown = new Set<string>()
  for (const node of order) {
    const p = at.get(node.id)
    // A day is named when it is pointed at: its date was a fifth of the text.
    if (!p || ((node.kind === 'day' || hubs.has(node.id)) && node.id !== currentId)) continue
    // Screen space, translation left out: it shifts every box alike and so cannot
    // change which two of them touch.
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

/** Which kinds of connection are drawn — the checkboxes, and `settings.graphShows`. */
export type Shows = Readonly<Record<EdgeKind, boolean>>

interface GraphViewProps {
  /** Null before the first read has finished. */
  graph: NoteGraph | null
  /** True while the vault is being read, so the pane can say so. */
  loading: boolean
  /** `pathKey` of the open note: the centre, and marked `.current`. */
  currentId: string | null
  shows: Shows
  onShows: (next: Shows) => void
  /**
   * A node was clicked. Every node reports, `exists: false` included: what to do
   * about a link with no note behind it is the caller's decision and not the
   * renderer's.
   */
  onSelect: (node: GraphNode) => void
}

export function GraphView({ graph, loading, currentId, shows, onShows, onSelect }: GraphViewProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const size = useBoxSize(boxRef)
  // The bar lies over the top of the picture, so a fit frames what is below it.
  const barRef = useRef<HTMLDivElement>(null)
  const barSize = useBoxSize(barRef)
  const reduced = usePrefersReducedMotion()
  const [scope, setScope] = useState<'around' | 'all'>('around')
  const [listing, setListing] = useState(false)

  const shown = useMemo(() => (graph ? connectionsOf(graph, shows) : null), [graph, shows])
  // **The same graph is the same picture.** A note typed into beside the graph
  // rebuilds it on every key; laid out again each time, it was a layout run, a glide
  // and a dragged node let go, per keystroke.
  const shape = useMemo(() => shown && JSON.stringify([shown.graph.nodes, shown.graph.edges]), [shown])
  // Around the open note when it has connections to be around.
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
  /** Nodes the pointer has moved, where it left them — until the picture changes. */
  const [held, setHeld] = useState<ReadonlyMap<string, Placed>>(new Map())
  useEffect(() => setHeld(new Map()), [picture])
  const placed = useMemo(() => (glided && held.size > 0 ? new Map([...glided, ...held]) : glided), [glided, held])
  const near = useMemo(() => neighboursOf(picture?.graph ?? null), [picture])

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

  /**
   * **Framed when what is looked at changes** — the scope, the centre, the
   * checkboxes — and gliding there, and not when the same picture is rebuilt as a
   * note is typed into: re-framing on that would snatch the view back each time.
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
      setHeld((was) => new Map(was).set(active.id, world))
    }
    const onUp = () => {
      const active = gesture.current
      gesture.current = null
      if (!active) return
      if (active.kind === 'node') {
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
  }, [toWorld])

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
  // **Not drawn, and not lost**: the notes with no connection of the kinds shown.
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
  // Only when nothing is hovered: the hover names its own set and dims the rest, so
  // there is nothing to declutter against.
  // A region's busiest note, always inside it, is named once: by the region.
  const hubs = new Set(picture.regions.map((region) => region.members[0]))
  const names = lit || !placed ? EMPTY : decluttered(drawn, placed, k, currentId, hubs)
  // Constant on screen whatever the zoom: a hairline is a hairline, and a name has
  // one readable size. Positions scale, these do not.
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
          // The background: a press here moves the view. A node stops this from
          // reaching us, so anything that gets here is empty space.
          if (event.button !== 0 || !view) return
          gesture.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, from: view }
        }}
      >
        <g transform={`translate(${view?.x ?? 0},${view?.y ?? 0}) scale(${k})`}>
          {picture.regions.map((region) => {
            // Round its members where they are now, so a region travels with a glide.
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
            // Past the rim, clear of the outer ring's names, which hang toward it below.
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
            // **The hovered node's own edges, not every edge between lit nodes**:
            // hovering a spoke lit the hub's *other* edge too, and said "these are
            // connected" about a pair that only shared an acquaintance.
            const on = !hovered || edge.from === hovered || edge.to === hovered
            // **The lines the picture rests on lead.** Around a note: from the centre,
            // and from each outer node to the one it sits beside; the rest cross the
            // picture. In everything: the links between notes; a day's or a tag's
            // run between the groups. The others step back until an end is hovered.
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
                // A link held in a property is drawn broken: a fact about a line,
                // where a link in the text is something written on purpose.
                strokeDasharray={edge.kind === 'property' ? `${4 * hair} ${3 * hair}` : undefined}
                opacity={opacity}
              />
            )
          })}
          {drawn.nodes.map((node) => {
            const at = placed?.get(node.id)
            if (!at) return null
            // A note grows with its connections; a day or a tag, which connects
            // everything, stays small.
            const degree = node.kind === 'note' ? (drawn.degree.get(node.id) ?? 0) : 0
            const radius = Math.min(NODE_R + degree * NODE_R_STEP, NODE_R_MAX)
            const classes = ['graph-node', node.kind]
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

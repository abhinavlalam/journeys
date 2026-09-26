// The note graph: one node per note, one edge per *pair* of notes that link.
//
// Two halves, and they do not know about each other:
//
// - **The model** — `buildNoteGraph` folds notes and their text into nodes and
//   weighted directed edges. One call, every time: the open note's own text is
//   substituted into the corpus first, so what the user sees is always a rebuild.
// - **The layout** — a hand-rolled force simulation over that graph, exposed as
//   pure steps so the renderer animates it and a test runs it to convergence.
//
// Like `links.ts` this module is **pure**: no filesystem, no React, no timers. It
// takes note text as *input*, so the caller decides when to pay for reading the
// vault, and it never calls `requestAnimationFrame` — driving a frame is the
// renderer's business. The imports from `links.ts` are pure, but `links.ts` reaches
// `vault.ts`, which imports `@tauri-apps/plugin-fs` at module scope, so a test of
// this file still needs that seam mocked — see `graph.test.ts`.

import { parseNoteLinks, pathKey, resolveTarget } from './links'
import type { NoteIndex } from './links'
import { baseName, isEncrypted, noteName } from './vaultModel'
import type { VaultFile } from './vaultModel'

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * One note in the graph.
 *
 * Folder notes are nodes like any other: `Ideas/` *is* the note `Ideas/Ideas.md`
 * (CLAUDE.md), `collectNotes` already hands it over as one, and the two spellings
 * share an `id`, so a folder note cannot appear twice or split its edges in half.
 */
export interface GraphNode {
  /** The `pathKey` normal form — the key edges and lookups use. */
  id: string
  /** The vault's own spelling, `.md` included, for an existing note. */
  path: string
  /** The basename without `.md` — what a label would show. */
  name: string
  /**
   * True when the note index knows this path — which includes a folder note whose
   * `.md` is not written yet, because the tree opens it and a link resolves to it
   * either way.
   *
   * False for a **link-only** node: the user chose "link it anyway, resolve later",
   * so the link is real and the note is not there yet. Those are kept as nodes
   * deliberately — they are what the vault is about to become, and dropping them
   * would also drop the edge that is the user's whole intent. The renderer is
   * expected to draw them differently (hollow, dashed) rather than identically.
   */
  exists: boolean
}

/**
 * Every link from one note to another, collapsed into one edge.
 *
 * Three links from A to B are **one** edge of weight 3, not three edges: the layout
 * treats an edge as a spring, and three springs between one pair would haul them
 * together three times as hard for no reason a reader could see.
 */
interface GraphEdge {
  /** `GraphNode.id` of the note holding the links. */
  from: string
  /** `GraphNode.id` of the note they point at. Never equal to `from`. */
  to: string
  /** How many links in `from` point at `to`. At least 1. */
  weight: number
}

/**
 * A built graph. Every field is derived, and every one is stable: nodes sorted by
 * `id`, edges by `(from, to)`, using plain `<` rather than `localeCompare` so the
 * order cannot shift with the host's collation. That is what lets the renderer
 * diff one rebuild against the next by identity, and there is a test for it.
 *
 * Invariant the renderer may rely on: both endpoints of every edge are in `nodes`.
 */
export interface NoteGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  byId: ReadonlyMap<string, GraphNode>
  /**
   * Incident edge records per node — every id in `nodes` is present, orphans as 0.
   * A mutual pair counts twice on each side, because it is two edges; `weight` is
   * deliberately *not* summed in here, so this is "how many notes does this touch"
   * and not "how many times was it mentioned".
   */
  degree: ReadonlyMap<string, number>
  nodeCount: number
  edgeCount: number
  /** Nodes with no edge in either direction. Link-only nodes can never be here. */
  orphans: GraphNode[]
}

/** One note and its current text. The caller schedules the reads. */
export interface NoteText {
  note: VaultFile
  text: string
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** What a node is *called*: the path's last segment, without the note's extension.
 *  It was `baseName` too, which is `vaultModel`'s word for the segment itself. */
function displayName(path: string): string {
  return noteName(baseName(path))
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The node for a note being read. Existing or not, it is always a node. */
function sourceNode(note: VaultFile, index: NoteIndex): GraphNode {
  const known = index.byKey.get(pathKey(note.path))
  const file = known ?? note
  return { id: pathKey(file.path), path: file.path, name: file.name, exists: !!known }
}

/** One note's outgoing edges, and the nodes they land on. */
function linksFrom(from: GraphNode, text: string, index: NoteIndex) {
  const targets = new Map<string, GraphNode>()
  const weights = new Map<string, number>()

  for (const link of parseNoteLinks(text)) {
    // The whole link, not `link.target`: a wikilink resolves by *name* across the
    // vault and a markdown link resolves by path, and passing the bare string gets
    // markdown semantics for both. That is what made a vault of `[[wikilinks]]`
    // produce a graph of phantom nodes with every real note left an orphan.
    const resolved = resolveTarget(link, from.path, index)
    // An external destination is not a note, so it is not a node and not an edge.
    if (resolved.kind === 'external') continue
    const node: GraphNode =
      resolved.kind === 'note'
        ? {
            id: pathKey(resolved.note.path),
            path: resolved.note.path,
            name: resolved.note.name,
            exists: true,
          }
        : {
            id: pathKey(resolved.path),
            path: resolved.path,
            name: displayName(resolved.path),
            exists: false,
          }
    // A note does not link to itself here, matching the backlink index: the graph
    // answers "what connects to what", and a loop connects nothing. Compared by
    // `id` rather than `isSamePath`, which is what makes `from === to` impossible.
    if (node.id === from.id) continue
    weights.set(node.id, (weights.get(node.id) ?? 0) + 1)
    if (!targets.has(node.id)) targets.set(node.id, node)
  }

  return {
    edges: [...weights].map(([to, weight]) => ({ from: from.id, to, weight })),
    targets: [...targets.values()],
  }
}

/** Sorts, indexes and counts. The only place a `NoteGraph` is made. */
function assemble(nodeMap: Map<string, GraphNode>, found: GraphEdge[]): NoteGraph {
  const nodes = [...nodeMap.values()].sort((a, b) => compare(a.id, b.id))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = found.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to))

  const degree = new Map(nodes.map((node) => [node.id, 0]))
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }

  return {
    nodes,
    edges,
    byId,
    degree,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    orphans: nodes.filter((node) => !degree.get(node.id)),
  }
}

/**
 * The whole graph, from every note and its text.
 *
 * O(total text + links) plus the sorts. Cheap enough to run on a vault read; the
 * expensive part is the reads themselves, which happen outside this module.
 */
export function buildNoteGraph(
  notes: Iterable<NoteText>,
  index: NoteIndex,
  hidden: readonly string[] = []
): NoteGraph {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []

  for (const { note, text } of notes) {
    const from = sourceNode(note, index)
    // Unconditional: a note read as a source is authoritative over the same node
    // guessed earlier from a link that pointed at it.
    nodes.set(from.id, from)
    const found = linksFrom(from, text, index)
    for (const target of found.targets) if (!nodes.has(target.id)) nodes.set(target.id, target)
    edges.push(...found.edges)
  }

  // **Folders left out of the picture, with the edges that touched them.** Measured
  // on the vault this was built for: the two most linked notes were a currency code
  // and a credit card, because every expense line links both, so the graph was a
  // diagram of a schema and not of anything anyone thinks about. `graphHides` in
  // settings names the folders; a note under one is dropped *after* the walk, so a
  // link into it does not come back as a hollow "missing" node the way filtering
  // the corpus would make it. An encrypted note goes the same way: the corpus has
  // no text of one, but a link from another note would still draw it.
  const left = (path: string) =>
    isEncrypted(path) || hidden.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  for (const [id, node] of nodes) if (left(node.path)) nodes.delete(id)
  return assemble(nodes, edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to)))
}

// ---------------------------------------------------------------------------
// Layout: a hand-rolled force simulation
// ---------------------------------------------------------------------------
//
// Repulsion between every pair, a spring along every edge, a gentle pull to the
// centre, damped velocities, integrated one step at a time. `d3-force` would do
// this better; it would also be a sixth runtime dependency for ~120 lines, which is
// the trade that was declined.
//
// **Cost.** Repulsion is O(n^2) per step — n(n-1)/2 pairs — and everything else is
// O(n + e). At the ~23 notes this vault holds that is 253 pairs, immeasurable. The
// measured numbers are in `graph.test.ts` beside the big-graph test; the shape of
// them is that ~700 nodes is the last size whose step still fits a 60 fps frame,
// and past ~1,500 a step costs more than 10 ms and an animation visibly stutters.
// That is where a Barnes-Hut quadtree earns its complexity. Below it, a quadtree is
// slower than the loop it would replace.
//
// **Determinism is a hard requirement**: opening the graph twice on an unchanged
// vault must give the same picture. So every initial position comes from a hash of
// the note's own id through a seeded PRNG, never `Math.random()`, and the force
// loops walk `graph.nodes` — sorted by id — so even the floating-point summation
// order is fixed. Hashing *per node* rather than drawing from one shared stream is
// deliberate: adding a note only rescales the starting disc, and every note keeps
// its place in it, rather than the whole set being reshuffled by one insertion.

/** What the simulation can be tuned by. Every field has a default in `DEFAULT_LAYOUT`. */
interface LayoutOptions {
  /** Coulomb constant: repulsion is `repulsion / d^2`. Bigger spreads the graph. */
  repulsion: number
  /** Hooke constant: an edge pulls with `spring * (d - springLength)`. */
  spring: number
  /** An edge's rest length, and the unit the initial spread is measured in. */
  springLength: number
  /** Pull to the origin, `gravity * distance`. What keeps a component on screen. */
  gravity: number
  /** Velocity kept per step. Below 1, or the simulation never settles. */
  damping: number
  /** Integration step. */
  dt: number
  /**
   * The floor on the distance used in a force. **This is the NaN guard.** Two nodes
   * at the same point have no direction between them and `dx / 0` is `NaN`, which
   * reaches every node through the pair loop in one frame and never leaves. Clamped
   * again internally, so even `0` here is safe.
   */
  minDistance: number
  /** Speed clamp, so one crowded frame cannot fling a node to infinity. */
  maxVelocity: number
  /**
   * Annealing. The speed clamp is `maxVelocity * cooling ** step`, so the graph is
   * free early and fine-tunes late. Without it a long chain or a dense web never
   * quite settles — it drifts under `tolerance`'s threshold and back out, measured
   * — and the renderer would animate forever, which is a battery bug. With it,
   * `converged` is reached in a **bounded** number of steps for any graph, because
   * the clamp itself eventually falls under `tolerance`. Set it to 1 to disable.
   */
  cooling: number
  /** A `maxSpeed` at or under this counts as converged. */
  tolerance: number
  /** Extra salt on the position hash. Change it to reshuffle a layout on purpose. */
  seed: number
}

const DEFAULT_LAYOUT: LayoutOptions = {
  repulsion: 4000,
  spring: 0.02,
  springLength: 60,
  gravity: 0.005,
  damping: 0.85,
  dt: 1,
  minDistance: 1,
  maxVelocity: 20,
  cooling: 0.99,
  tolerance: 0.05,
  seed: 0,
}

export interface LayoutNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
}

export interface LayoutState {
  /** Same order as `graph.nodes`: sorted by id, so the summation order is fixed. */
  nodes: LayoutNode[]
  /** Frames advanced. */
  step: number
  /** The fastest node's speed in the last frame. 0 for a fresh state. */
  maxSpeed: number
  /** True once `maxSpeed` is within `tolerance` — where the renderer stops animating. */
  converged: boolean
}

/** FNV-1a over the note id. It only has to spread, not to resist anything. */
function hashString(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** mulberry32, inline, because the alternative is a dependency for nine lines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Where a node starts: uniform in a disc whose radius grows with the square root of
 * the node count, so the starting density stays about the same however big the
 * vault gets.
 */
function seedPosition(id: string, count: number, options: LayoutOptions): { x: number; y: number } {
  const random = mulberry32(hashString(id) ^ (options.seed >>> 0))
  const angle = random() * Math.PI * 2
  const radius = Math.sqrt(random()) * options.springLength * Math.sqrt(Math.max(count, 1))
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function withDefaults(options?: Partial<LayoutOptions>): LayoutOptions {
  return options ? { ...DEFAULT_LAYOUT, ...options } : DEFAULT_LAYOUT
}

/** Frame zero. Same graph, same options, same positions, every time. */
export function initialLayout(graph: NoteGraph, options?: Partial<LayoutOptions>): LayoutState {
  const opts = withDefaults(options)
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      ...seedPosition(node.id, graph.nodes.length, opts),
      vx: 0,
      vy: 0,
    })),
    step: 0,
    maxSpeed: 0,
    // Nothing to move is already settled; anything else has to earn it.
    converged: graph.nodes.length === 0,
  }
}

function finite(node: LayoutNode): boolean {
  return (
    Number.isFinite(node.x) &&
    Number.isFinite(node.y) &&
    Number.isFinite(node.vx) &&
    Number.isFinite(node.vy)
  )
}

/**
 * One frame. Pure: the state handed in is not touched and a new one comes back, so
 * the renderer can drive it from a frame callback and a test can drive it in a loop
 * with no DOM and no timers.
 *
 * A node in the incoming state that is not in the graph is dropped, and a node in
 * the graph with no incoming position is seeded — so a state survives a note being
 * added or deleted mid-animation without the caller re-initialising.
 */
export function stepLayout(
  graph: NoteGraph,
  state: LayoutState,
  options?: Partial<LayoutOptions>
): LayoutState {
  const opts = withDefaults(options)
  // Even a hostile `minDistance` of 0 cannot divide by zero past here.
  const floor = Math.max(opts.minDistance, 1e-6)
  const count = graph.nodes.length

  const previous = new Map(state.nodes.map((node) => [node.id, node]))
  // Scrubbed on the way *in*: one non-finite coordinate that arrived from anywhere
  // would otherwise reach every other node through the pair loop in a single frame.
  const nodes: LayoutNode[] = graph.nodes.map((node) => {
    const was = previous.get(node.id)
    if (was && finite(was)) return { id: node.id, x: was.x, y: was.y, vx: was.vx, vy: was.vy }
    return { id: node.id, ...seedPosition(node.id, count, opts), vx: 0, vy: 0 }
  })
  const at = new Map(nodes.map((node, i) => [node.id, i]))
  const fx = new Float64Array(count)
  const fy = new Float64Array(count)

  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      let dx = nodes[j].x - nodes[i].x
      let dy = nodes[j].y - nodes[i].y
      let d = Math.sqrt(dx * dx + dy * dy)
      if (d < floor) {
        // Exactly coincident, or as good as: there is no direction to push along.
        // Take one from the pair's ids, so the nudge is the same on every run.
        const angle = (hashString(`${nodes[i].id} ${nodes[j].id}`) % 62832) / 10000
        dx = Math.cos(angle) * floor
        dy = Math.sin(angle) * floor
        d = floor
      }
      // `/ d` a third time turns (dx, dy) into a unit vector.
      const push = opts.repulsion / (d * d) / d
      fx[i] -= dx * push
      fy[i] -= dy * push
      fx[j] += dx * push
      fy[j] += dy * push
    }
  }

  for (const edge of graph.edges) {
    const i = at.get(edge.from)
    const j = at.get(edge.to)
    if (i === undefined || j === undefined) continue
    const dx = nodes[j].x - nodes[i].x
    const dy = nodes[j].y - nodes[i].y
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), floor)
    // `weight` deliberately does **not** stiffen the spring. Collapsing three links
    // into one edge was the whole point; scaling stiffness by the count would put
    // the three springs straight back. The renderer has the weight for stroke width.
    const pull = (opts.spring * (d - opts.springLength)) / d
    fx[i] += dx * pull
    fy[i] += dy * pull
    fx[j] -= dx * pull
    fy[j] -= dy * pull
  }

  const limit = opts.maxVelocity * Math.pow(opts.cooling, state.step)
  let maxSpeed = 0
  for (let i = 0; i < count; i++) {
    const node = nodes[i]
    let vx = (node.vx + (fx[i] - node.x * opts.gravity) * opts.dt) * opts.damping
    let vy = (node.vy + (fy[i] - node.y * opts.gravity) * opts.dt) * opts.damping
    let speed = Math.sqrt(vx * vx + vy * vy)
    if (speed > limit) {
      const scale = limit / speed
      vx *= scale
      vy *= scale
      speed = limit
    }
    node.vx = vx
    node.vy = vy
    node.x += vx * opts.dt
    node.y += vy * opts.dt
    maxSpeed = Math.max(maxSpeed, speed)
  }

  return { nodes, step: state.step + 1, maxSpeed, converged: maxSpeed <= opts.tolerance }
}

/** How many steps a layout may take to settle before it is drawn as it stands. */
const SETTLE_STEPS = 800

/**
 * Run the simulation to rest, or to `maxSteps`, whichever comes first — what a test
 * wants, and what the renderer wants for a graph it opens without animating.
 */
export function settle(
  graph: NoteGraph,
  from: LayoutState,
  options?: Partial<LayoutOptions>,
  maxSteps = SETTLE_STEPS
): LayoutState {
  let state = from
  for (let i = 0; i < maxSteps && !state.converged; i++) state = stepLayout(graph, state, options)
  return state
}

/**
 * The settled layout from scratch: `settle` from frame zero.
 *
 * The loop was written twice, here and in `GraphView` — the renderer needs to settle
 * a layout that is already part-way, which is the only thing that differed. It is a
 * starting state, so it is an argument.
 */
export const layout = (
  graph: NoteGraph,
  options?: Partial<LayoutOptions>,
  maxSteps = SETTLE_STEPS
): LayoutState => settle(graph, initialLayout(graph, options), options, maxSteps)

/**
 * The layout's extents in simulation space, or null when there is nothing to bound.
 *
 * The renderer owns a **view transform** the user pans and zooms, so it needs the
 * extents once, to work out where to start, rather than a picture squeezed into the
 * pane every frame. `fitToBox` used to do that squeezing and is gone with it: a
 * graph fitted for you is not a graph you can move around in.
 */
export function boundsOf(
  state: LayoutState
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  if (state.nodes.length === 0) return null
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const node of state.nodes) {
    minX = Math.min(minX, node.x)
    maxX = Math.max(maxX, node.x)
    minY = Math.min(minY, node.y)
    maxY = Math.max(maxY, node.y)
  }
  return { minX, maxX, minY, maxY }
}


// The note graph: one node per note or tag, one edge per *pair* that connect, by kind.
//
// Two halves, and they do not know about each other:
//
// - **The model** — `buildNoteGraph` folds notes and their text into nodes and
//   weighted directed edges. One call, every time: the open note's own text is
//   substituted into the corpus first, so what the user sees is always a rebuild.
// - **The layouts** — rings around one note (`ringLayout`), and a hand-rolled force
//   simulation over the whole graph, run to rest before anything is drawn.
//
// Like `links.ts` this module is **pure**: no filesystem, no React, no timers. It
// takes note text as *input*, so the caller decides when to pay for reading the
// vault, and it never calls `requestAnimationFrame` — driving a frame is the
// renderer's business. The imports from `links.ts` are pure, but `links.ts` reaches
// `vault.ts`, which imports `@tauri-apps/plugin-fs` at module scope, so a test of
// this file still needs that seam mocked — see `graph.test.ts`.

import { isDailyNote } from './daily'
import { parseNoteLinks, pathKey, resolveTarget } from './links'
import type { NoteIndex } from './links'
import { blockProperties, type PropertyType } from './properties'
import { tagNames } from './tags'
import { baseName, isEncrypted, noteName } from './vaultModel'
import type { VaultFile } from './vaultModel'

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** What a node stands for: a note, a day's note, or a tag. */
export type NodeKind = 'note' | 'day' | 'tag'

/**
 * **What a connection is**: a link written in the text, a link held in a property's
 * value (`merchant:: [[Harbour Bistro]]`), or a note carrying a tag. The graph shows
 * any of the three, as the owner chooses — the second were a third of a vault's
 * links and made its busiest hubs.
 */
export const EDGE_KINDS = ['text', 'property', 'tag'] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

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
  kind: NodeKind
}

/**
 * Every link of one kind from one note to another, collapsed into one edge.
 *
 * Three links in A's text to B are **one** edge of weight 3, not three edges: the layout
 * treats an edge as a spring, and three springs between one pair would haul them
 * together three times as hard for no reason a reader could see.
 */
export interface GraphEdge {
  /** `GraphNode.id` of the note holding the links. */
  from: string
  /** `GraphNode.id` of the note they point at. Never equal to `from`. */
  to: string
  /** How many links in `from` point at `to`. At least 1. */
  weight: number
  kind: EdgeKind
}

/**
 * A built graph. Every field is derived, and every one is stable: nodes sorted by
 * `id`, edges by `(from, to, kind)`, using plain `<` rather than `localeCompare` so the
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

/** What a graph is read with: each property's type, for where a value holding a
 *  link ends, and the daily folder, for which notes are days. */
export interface GraphOptions {
  typeOf?: (name: string) => PropertyType
  dailyFolder?: string
}

/** The node for a note being read. Existing or not, it is always a node. */
function sourceNode(note: VaultFile, index: NoteIndex, dailyFolder: string): GraphNode {
  const known = index.byKey.get(pathKey(note.path))
  const file = known ?? note
  const kind = isDailyNote(file.path, dailyFolder) ? 'day' : 'note'
  return { id: pathKey(file.path), path: file.path, name: file.name, exists: !!known, kind }
}

/** Where a note's block properties hold their values, as offsets into its text. */
function propertyValues(text: string, typeOf: (name: string) => PropertyType): [number, number][] {
  const spans: [number, number][] = []
  let at = 0
  for (const line of text.split('\n')) {
    for (const one of blockProperties(line, typeOf)) {
      if (one.valid) spans.push([at + one.valueFrom, at + one.valueTo])
    }
    at += line.length + 1
  }
  return spans
}

/** One note's outgoing edges, and the nodes they land on: its links, each by where
 *  it is written, and its tags. */
function linksFrom(from: GraphNode, text: string, index: NoteIndex, options: Required<GraphOptions>) {
  const targets = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const held = propertyValues(text, options.typeOf)
  const count = (node: GraphNode, kind: EdgeKind) => {
    const key = `${node.id}\n${kind}`
    const edge = edges.get(key) ?? { from: from.id, to: node.id, weight: 0, kind }
    edge.weight += 1
    edges.set(key, edge)
    if (!targets.has(node.id)) targets.set(node.id, node)
  }

  for (const link of parseNoteLinks(text)) {
    // The whole link, not `link.target`: a wikilink resolves by *name* across the
    // vault and a markdown link resolves by path, and passing the bare string gets
    // markdown semantics for both. That is what made a vault of `[[wikilinks]]`
    // produce a graph of phantom nodes with every real note left an orphan.
    const resolved = resolveTarget(link, from.path, index)
    // An external destination is not a note, so it is not a node and not an edge.
    if (resolved.kind === 'external') continue
    const path = resolved.kind === 'note' ? resolved.note.path : resolved.path
    const node: GraphNode = {
      id: pathKey(path),
      path,
      name: resolved.kind === 'note' ? resolved.note.name : displayName(path),
      exists: resolved.kind === 'note',
      kind: isDailyNote(path, options.dailyFolder) ? 'day' : 'note',
    }
    // A note does not link to itself here, matching the backlink index: the graph
    // answers "what connects to what", and a loop connects nothing. Compared by
    // `id` rather than `isSamePath`, which is what makes `from === to` impossible.
    if (node.id === from.id) continue
    count(node, held.some(([start, end]) => link.start >= start && link.start < end) ? 'property' : 'text')
  }
  // A tag is a node of its own, joined to every note that carries it.
  for (const tag of new Set(tagNames(text))) {
    count({ id: `tag:${tag}`, path: '', name: `#${tag}`, exists: true, kind: 'tag' }, 'tag')
  }

  return { edges: [...edges.values()], targets: [...targets.values()] }
}

/** Sorts, indexes and counts. The only place a `NoteGraph` is made. */
function assemble(nodeMap: Map<string, GraphNode>, found: GraphEdge[]): NoteGraph {
  const nodes = [...nodeMap.values()].sort((a, b) => compare(a.id, b.id))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = found.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.kind, b.kind))

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
  hidden: readonly string[] = [],
  options: GraphOptions = {}
): NoteGraph {
  const read: Required<GraphOptions> = { typeOf: options.typeOf ?? (() => 'text'), dailyFolder: options.dailyFolder ?? '' }
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []

  for (const { note, text } of notes) {
    const from = sourceNode(note, index, read.dailyFolder)
    // Unconditional: a note read as a source is authoritative over the same node
    // guessed earlier from a link that pointed at it.
    nodes.set(from.id, from)
    const found = linksFrom(from, text, index, read)
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
  for (const [id, node] of nodes) if (node.kind !== 'tag' && left(node.path)) nodes.delete(id)
  return assemble(nodes, edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to)))
}

/**
 * The graph with only the connections chosen, and **the notes that are left with
 * none, apart**: not drawn, but counted, so a note is never silently missing. A tag
 * with no note is not a thing, and a note that exists only as a link's target
 * leaves with its link.
 */
export function connectionsOf(
  graph: NoteGraph,
  shown: Readonly<Record<EdgeKind, boolean>>
): { graph: NoteGraph; unconnected: GraphNode[] } {
  const edges = graph.edges.filter((edge) => shown[edge.kind])
  const touched = new Set(edges.flatMap((edge) => [edge.from, edge.to]))
  const nodes = new Map(graph.nodes.filter((node) => touched.has(node.id)).map((node) => [node.id, node]))
  const unconnected = graph.nodes.filter((node) => !touched.has(node.id) && node.exists && node.kind !== 'tag')
  return { graph: assemble(nodes, edges), unconnected }
}

const KIND_ORDER: Record<NodeKind, number> = { note: 0, day: 1, tag: 2 }

/**
 * **The graph around one note**: the note, what it touches — links either way, its
 * tags — and what those touch, as three rings. Each on the second ring belongs to
 * the first on the first ring that reached it, so it can be laid beside it. A ring
 * runs by kind, then cluster, so a group's notes sit together on it.
 */
export function around(
  graph: NoteGraph,
  centre: string,
  clusters: readonly string[][] = []
): { graph: NoteGraph; rings: string[][]; parents: Map<string, string> } {
  const near = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]))
  for (const edge of graph.edges) {
    near.get(edge.from)?.add(edge.to)
    near.get(edge.to)?.add(edge.from)
  }
  const home = new Map(clusters.flatMap((members, c) => members.map((id) => [id, c] as const)))
  const ordered = (ids: Iterable<string>) =>
    [...ids].sort((a, b) => {
      const x = graph.byId.get(a)!
      const y = graph.byId.get(b)!
      return (
        KIND_ORDER[x.kind] - KIND_ORDER[y.kind] ||
        (home.get(a) ?? clusters.length) - (home.get(b) ?? clusters.length) ||
        compare(x.name.toLowerCase(), y.name.toLowerCase())
      )
    })
  const first = graph.byId.has(centre) ? ordered(near.get(centre)!) : []
  const seen = new Set([centre, ...first])
  const parents = new Map<string, string>()
  const second: string[] = []
  for (const parent of first) {
    for (const id of ordered(near.get(parent)!)) {
      if (seen.has(id)) continue
      seen.add(id)
      parents.set(id, parent)
      second.push(id)
    }
  }
  const nodes = new Map([...seen].filter((id) => graph.byId.has(id)).map((id) => [id, graph.byId.get(id)!]))
  const edges = graph.edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to))
  return { graph: assemble(nodes, edges), rings: [[centre], first, second], parents }
}

/** A point in the layout's own space. */
export interface Placed {
  x: number
  y: number
}

/** The least distance between two rings, and the arc a node takes on one — room
 *  for a node and the start of its name. */
const RING_GAP = 150
const NODE_ARC = 48

/**
 * **Rings, laid out and not simulated**, so the picture is still and the same every
 * time. The first ring shares the circle out by what hangs off each of its nodes —
 * one with twelve on the second ring gets twelve shares of the angle, one with none
 * a single share — and the second ring's nodes sit in their parent's share, so a
 * note's own neighbours are beside it. Each ring is wide enough for its nodes.
 */
export function ringLayout(rings: readonly string[][], parents: ReadonlyMap<string, string>): Map<string, Placed> {
  const at = new Map<string, Placed>()
  const [[centre] = [], first = [], second = []] = rings
  if (centre === undefined) return at
  at.set(centre, { x: 0, y: 0 })
  if (first.length === 0) return at
  const children = new Map(first.map((id) => [id, [] as string[]]))
  for (const id of second) children.get(parents.get(id)!)?.push(id)
  const shares = first.map((id) => Math.max(1, children.get(id)!.length))
  const total = shares.reduce((sum, one) => sum + one, 0)
  const inner = Math.max(RING_GAP, (total * NODE_ARC) / (2 * Math.PI))
  const outer = inner + RING_GAP
  const polar = (r: number, angle: number) => ({ x: r * Math.cos(angle), y: r * Math.sin(angle) })
  let start = -Math.PI / 2 - (Math.PI * shares[0]) / total
  first.forEach((id, i) => {
    const share = (2 * Math.PI * shares[i]) / total
    at.set(id, polar(inner, start + share / 2))
    const under = children.get(id)!
    under.forEach((child, j) => at.set(child, polar(outer, start + (share * (j + 0.5)) / under.length)))
    start += share
  })
  return at
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
// measured numbers are in `graph.test.ts` beside the big-graph test. Run to rest,
// a web of 150 notes took 42 ms, 300 took 100 ms and 700 took 0.5 s (2026-09-28):
// paid once per change to the graph's shape, not per frame. Past that is where a
// Barnes-Hut quadtree earns its complexity; below it, a quadtree is slower than
// the loop it would replace.
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
   * — and a layout would run to its step limit every time. With it,
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
  /** True once `maxSpeed` is within `tolerance` — where `layout` stops. */
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
 * One step. Pure: the state handed in is not touched and a new one comes back, so
 * a test can drive it in a loop with no DOM and no timers.
 *
 * A node in the incoming state that is not in the graph is dropped, and a node in
 * the graph with no incoming position is seeded — so a state survives a note being
 * added or deleted between steps without the caller re-initialising.
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

/** The simulation from frame zero to rest, or to `maxSteps`, whichever comes first. */
export function layout(graph: NoteGraph, options?: Partial<LayoutOptions>, maxSteps = SETTLE_STEPS): LayoutState {
  let state = initialLayout(graph, options)
  for (let i = 0; i < maxSteps && !state.converged; i++) state = stepLayout(graph, state, options)
  return state
}

/**
 * **No two nodes on top of each other**: each node has its `room`, and a pair nearer
 * than their two rooms is pushed apart along the line between them, rounds at a
 * time, in a fixed order — so a settled layout whose hubs were pulled into one knot
 * opens out, and does so the same way every time. A pair on one point parts along x.
 */
export function spread(
  points: ReadonlyMap<string, Placed>,
  room: (id: string) => number,
  rounds = 300
): Map<string, Placed> {
  const ids = [...points.keys()].sort(compare)
  const at = new Map(ids.map((id) => [id, { ...points.get(id)! }]))
  for (let round = 0; round < rounds; round++) {
    let moved = false
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = at.get(ids[i])!
        const b = at.get(ids[j])!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.hypot(dx, dy)
        const gap = room(ids[i]) + room(ids[j])
        if (d >= gap) continue
        // The smaller gives way: a day pushed off a region moves, the region hardly.
        const share = room(ids[j]) / gap
        const [ux, uy] = d > 0 ? [dx / d, dy / d] : [1, 0]
        a.x -= ux * (gap - d) * share
        a.y -= uy * (gap - d) * share
        b.x += ux * (gap - d) * (1 - share)
        b.y += uy * (gap - d) * (1 - share)
        moved = true
      }
    }
    if (!moved) break
  }
  return at
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

/**
 * Louvain's communities over `n` nodes and weighted pairs `[a, b, w]`: each node,
 * in index order, joins the neighbouring community that most raises modularity,
 * until none moves; then each community becomes one node and it runs again, until
 * nothing merges. The same pairs give the same communities every time.
 */
function communities(n: number, pairs: [number, number, number][]): number[] {
  let of = Array.from({ length: n }, (_, i) => i)
  let size = n
  let links = pairs
  for (;;) {
    const moved = localMoving(size, links)
    const count = new Set(moved).size
    if (count === size) return of
    of = of.map((c) => moved[c])
    const merged = new Map<string, [number, number, number]>()
    for (const [a, b, w] of links) {
      const [x, y] = [moved[a], moved[b]].sort((p, q) => p - q)
      const one = merged.get(`${x} ${y}`) ?? [x, y, 0]
      one[2] += w
      merged.set(`${x} ${y}`, one)
    }
    links = [...merged.values()]
    size = count
  }
}

/** Louvain's first phase: each node's community, numbered from 0 as first met. */
function localMoving(n: number, links: [number, number, number][]): number[] {
  const near = Array.from({ length: n }, () => new Map<number, number>())
  const degree = new Array<number>(n).fill(0)
  let twice = 0
  for (const [a, b, w] of links) {
    degree[a] += w
    degree[b] += w
    twice += 2 * w
    if (a === b) continue
    near[a].set(b, (near[a].get(b) ?? 0) + w)
    near[b].set(a, (near[b].get(a) ?? 0) + w)
  }
  const of = Array.from({ length: n }, (_, i) => i)
  const total = [...degree]
  for (let moved = twice > 0; moved; ) {
    moved = false
    for (let i = 0; i < n; i++) {
      const own = of[i]
      total[own] -= degree[i]
      const toward = new Map<number, number>()
      for (const [j, w] of near[i]) toward.set(of[j], (toward.get(of[j]) ?? 0) + w)
      const gain = (c: number) => (toward.get(c) ?? 0) - (total[c] * degree[i]) / twice
      let best = own
      for (const c of toward.keys()) if (gain(c) > gain(best) + 1e-12) best = c
      total[best] += degree[i]
      if (best !== own) {
        of[i] = best
        moved = true
      }
    }
  }
  const number = new Map<number, number>()
  for (const c of of) if (!number.has(c)) number.set(c, number.size)
  return of.map((c) => number.get(c)!)
}

/** The fewest notes a cluster is drawn for: a pair is a link, not a group. */
const CLUSTER_MIN = 3

/**
 * **The groups the notes make**: communities over the links between notes alone,
 * largest first. Days and tags take no part — each touches every group, and let in,
 * they made the whole vault one — and neither does a note linked only through them.
 */
export function clustersOf(graph: NoteGraph): string[][] {
  const notes = graph.nodes.filter((node) => node.kind === 'note')
  const index = new Map(notes.map((node, i) => [node.id, i]))
  const pairs = new Map<string, [number, number, number]>()
  for (const edge of graph.edges) {
    const a = index.get(edge.from)
    const b = index.get(edge.to)
    if (a === undefined || b === undefined) continue
    const [x, y] = [a, b].sort((p, q) => p - q)
    pairs.set(`${x} ${y}`, [x, y, 1])
  }
  const of = communities(notes.length, [...pairs.values()])
  const groups = new Map<number, string[]>()
  notes.forEach((node, i) => groups.set(of[i], [...(groups.get(of[i]) ?? []), node.id]))
  return [...groups.values()]
    .filter((members) => members.length >= CLUSTER_MIN)
    .sort((a, b) => b.length - a.length || compare(a[0], b[0]))
}

/** A cluster where it is drawn: a disc round its members, named for the most
 *  connected of them. */
export interface Region {
  members: string[]
  name: string
  x: number
  y: number
  r: number
}

/** The simulation's options for a picture with room in it: a longer rest length and
 *  a stronger push than the defaults. */
const ROOMY = { repulsion: 12000, springLength: 90 }
/** Half the least distance between two nodes: a disc and the start of a name. */
const NODE_ROOM = 22
/** Air inside a region's rim past its outermost member, where its name sits. */
export const REGION_PAD = 40

const positionsOf = (state: LayoutState) => new Map(state.nodes.map((node) => [node.id, { x: node.x, y: node.y }]))

/**
 * **Everything, by cluster.** Each cluster is laid out on its own, then stands as
 * one node, as wide as it is, in the layout of the rest — the days, the tags and
 * the notes in no cluster — so a day sits between the groups it touches and no
 * group is pulled into another through it. Nothing is left inside a region that
 * is not one of its members.
 */
export function everything(graph: NoteGraph, clusters: readonly string[][]): { at: Map<string, Placed>; regions: Region[] } {
  const home = new Map(clusters.flatMap((members, c) => members.map((id) => [id, `cluster:${c}`] as const)))
  const shapes = clusters.map((members) => {
    const inside = new Set(members)
    const own = assemble(
      new Map(members.map((id) => [id, graph.byId.get(id)!])),
      graph.edges.filter((edge) => inside.has(edge.from) && inside.has(edge.to))
    )
    const at = spread(positionsOf(layout(own)), () => NODE_ROOM)
    const mid = [...at.values()].reduce((sum, p) => ({ x: sum.x + p.x / at.size, y: sum.y + p.y / at.size }), { x: 0, y: 0 })
    for (const p of at.values()) {
      p.x -= mid.x
      p.y -= mid.y
    }
    return { at, r: Math.max(...[...at.values()].map((p) => Math.hypot(p.x, p.y))) + REGION_PAD }
  })
  // A region's room is its disc and a node's room more, so regions stand apart.
  const rooms = new Map(shapes.map((shape, c) => [`cluster:${c}`, shape.r + NODE_ROOM]))
  const nodes = new Map(graph.nodes.filter((node) => !home.has(node.id)).map((node) => [node.id, node]))
  for (const id of rooms.keys()) nodes.set(id, { id, path: '', name: '', exists: true, kind: 'note' })
  const joined = new Map<string, GraphEdge>()
  for (const edge of graph.edges) {
    const from = home.get(edge.from) ?? edge.from
    const to = home.get(edge.to) ?? edge.to
    if (from === to) continue
    joined.set(`${from}\n${to}`, { from, to, weight: 1, kind: edge.kind })
  }
  const top = spread(positionsOf(layout(assemble(nodes, [...joined.values()]), ROOMY)), (id) => rooms.get(id) ?? NODE_ROOM)
  const at = new Map([...top].filter(([id]) => !rooms.has(id)))
  const regions = clusters.map((members, c) => {
    const mid = top.get(`cluster:${c}`)!
    for (const [id, p] of shapes[c].at) at.set(id, { x: mid.x + p.x, y: mid.y + p.y })
    const named = members.reduce((best, id) => ((graph.degree.get(id) ?? 0) > (graph.degree.get(best) ?? 0) ? id : best))
    return { members, name: graph.byId.get(named)!.name, x: mid.x, y: mid.y, r: shapes[c].r }
  })
  return { at, regions }
}

/**
 * The layout's extents in simulation space, or null when there is nothing to bound.
 *
 * The renderer owns a **view transform** the user pans and zooms, so it needs the
 * extents once, to work out where to start, rather than a picture squeezed into the
 * pane every frame. `fitToBox` used to do that squeezing and is gone with it: a
 * graph fitted for you is not a graph you can move around in.
 */
export function boundsOf(
  points: Iterable<Placed>
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const node of points) {
    minX = Math.min(minX, node.x)
    maxX = Math.max(maxX, node.x)
    minY = Math.min(minY, node.y)
    maxY = Math.max(maxY, node.y)
  }
  return minX === Infinity ? null : { minX, maxX, minY, maxY }
}


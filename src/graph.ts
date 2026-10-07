// The note graph: a node per note, day or tag, and an edge per connected pair,
// by kind (`buildNoteGraph`); its clusters; and its layouts, rings around one
// note and everything by cluster, computed before anything is drawn.
//
// Pure: no filesystem, React or timers; note text is the input.
// `links.ts` reaches `vault.ts`, which imports the Tauri fs
// plugin, so a test of this file still mocks that.

import { isDailyNote } from './daily'
import { parseNoteLinks, pathKey, resolveTarget } from './links'
import type { NoteIndex } from './links'
import { blockProperties, splitPageProperties, type PropertyType } from './properties'
import { tagNames } from './tags'
import { baseName, isEncrypted, isTextFile, isWithin, noteName } from './vaultModel'
import type { VaultFile } from './vaultModel'

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** What a node stands for: a note, a day's note, or a tag. */
export type NodeKind = 'note' | 'day' | 'tag'

/**
 * What a connection is: a link in the text, a link in a property's value (`merchant::
 * [[Harbour Bistro]]`), or a note carrying a tag. The graph shows any of the three.
 */
export const EDGE_KINDS = ['text', 'property', 'tag'] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

/**
 * One note in the graph. A folder note is one node: `Ideas/` and
 * `Ideas/Ideas.md` share an `id`, so it can't appear twice or split its edges.
 */
export interface GraphNode {
  /** The `pathKey` form, which edges and lookups use. */
  id: string
  /** The vault's own spelling, `.md` included, for an existing note. */
  path: string
  /** The basename without `.md`, which a label shows. */
  name: string
  /**
   * True when the note index knows this path, including a folder note not written
   * yet, since a link resolves to it either way. False for a link to a note that
   * doesn't exist yet. Those are kept, since the link is real, and drawn hollow.
   */
  exists: boolean
  kind: NodeKind
}

/**
 * Every link of one kind from one note to another, as one edge. Three links
 * from A to B are one edge of weight 3: the layout treats an edge as a
 * spring, and three springs would pull them together three times as hard.
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
 * A built graph, every field derived and stable: nodes by `id`, edges by
 * `(from, to, kind)`, sorted with `<` rather than `localeCompare`, which
 * varies with the host. The same vault gives the same graph, which the view's
 * shape key and the layouts depend on. Both ends of every edge are in `nodes`.
 */
export interface NoteGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  byId: ReadonlyMap<string, GraphNode>
  /**
   * Edges touching each node; every id is present, with 0 for none.
   * A mutual pair counts twice. `weight` isn't summed in, so this
   * is how many notes it touches, not how often it is mentioned.
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

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * What a graph is read with: each property's type, for where a value
 * holding a link ends, and the daily folder, for which notes are days.
 */
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

/**
 * Where a note's properties hold their values, as offsets into its text: the page
 * block whole (`key:: value` or YAML), then each block property's value on a line.
 */
function propertyValues(text: string, typeOf: (name: string) => PropertyType): [number, number][] {
  const spans: [number, number][] = [[0, splitPageProperties(text).prefix.length]]
  let at = 0
  for (const line of text.split('\n')) {
    for (const one of blockProperties(line, typeOf)) {
      if (one.valid) spans.push([at + one.valueFrom, at + one.valueTo])
    }
    at += line.length + 1
  }
  return spans
}

/**
 * One note's outgoing edges and the nodes they reach: its links,
 * each by where it is written, and its tags.
 */
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
    // The whole link, not `link.target`: a wikilink resolves by name and a
    // markdown link by path, and a bare string gets the markdown rule for both.
    const resolved = resolveTarget(link, from.path, index)
    // An external destination isn't a note, so it is neither a node nor an edge.
    if (resolved.kind === 'external') continue
    const path = resolved.kind === 'note' ? resolved.note.path : resolved.path
    const node: GraphNode = {
      id: pathKey(path),
      path,
      name: resolved.kind === 'note' ? resolved.note.name : noteName(baseName(path)),
      exists: resolved.kind === 'note',
      kind: isDailyNote(path, options.dailyFolder) ? 'day' : 'note',
    }
    // No self-links, as in the backlinks. Compared by `id`, so
    // `from === to` can't happen.
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
 * The whole graph, from every note and its text. O(text + links) plus the
 * sorts; the reads themselves are the expensive part and happen elsewhere.
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
    // A note read as a source replaces the same node guessed earlier from a link to it.
    nodes.set(from.id, from)
    const found = linksFrom(from, text, index, read)
    for (const target of found.targets) if (!nodes.has(target.id)) nodes.set(target.id, target)
    edges.push(...found.edges)
  }

  // Folders in `graphHides` are left out with their edges, for notes like a
  // currency that every line links. They are dropped after the walk, so a link
  // into one doesn't come back as a missing node. Locked notes go the same way,
  // and so does a file that is not text, such as a photo a day links to.
  const left = (path: string) =>
    isEncrypted(path) || !isTextFile(path) || hidden.some((folder) => isWithin(path, folder))
  for (const [id, node] of nodes) if (node.kind !== 'tag' && left(node.path)) nodes.delete(id)
  return assemble(nodes, edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to)))
}

/**
 * The graph with only the chosen kinds of connection, and the notes left
 * with none listed apart, so no note silently disappears. A tag with no
 * notes goes, and so does a note that exists only as a link's target.
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
 * The graph around one note: the note, what it touches (links either way,
 * and its tags), and what those touch, as three rings. Each second-ring
 * node belongs to the first-ring node that reached it, so it can sit beside
 * it. A ring is ordered by kind, then cluster, so a group sits together.
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

/** A point `r` out from the centre at `angle`. */
export const polar = (r: number, angle: number): Placed => ({ x: r * Math.cos(angle), y: r * Math.sin(angle) })

/**
 * The least distance between rings, and the arc a node takes on
 * one: room for a node and the start of its name.
 */
const RING_GAP = 150
const NODE_ARC = 48

/**
 * Rings, laid out rather than simulated, so the picture is the same every
 * time. The first ring shares the circle by what hangs off each node:
 * twelve children get twelve shares, none gets one. Second-ring nodes sit
 * in their parent's share. Each ring is wide enough for its nodes. A
 * cluster's run on the first ring, with its children, is a sector.
 */
export function ringLayout(
  rings: readonly string[][],
  parents: ReadonlyMap<string, string>,
  clusters: readonly string[][] = []
): { at: Map<string, Placed>; sectors: Sector[] } {
  const at = new Map<string, Placed>()
  const sectors: Sector[] = []
  const [[centre] = [], first = [], second = []] = rings
  if (centre === undefined) return { at, sectors }
  at.set(centre, { x: 0, y: 0 })
  if (first.length === 0) return { at, sectors }
  const children = new Map(first.map((id) => [id, [] as string[]]))
  for (const id of second) children.get(parents.get(id)!)?.push(id)
  const shares = first.map((id) => Math.max(1, children.get(id)!.length))
  const total = shares.reduce((sum, one) => sum + one, 0)
  const inner = Math.max(RING_GAP, (total * NODE_ARC) / (2 * Math.PI))
  const outer = inner + RING_GAP
  const home = new Map(clusters.flatMap((members) => members.map((id) => [id, members] as const)))
  let start = -Math.PI / 2 - (Math.PI * shares[0]) / total
  first.forEach((id, i) => {
    const share = (2 * Math.PI * shares[i]) / total
    at.set(id, polar(inner, start + share / 2))
    const under = children.get(id)!
    under.forEach((child, j) => at.set(child, polar(outer, start + (share * (j + 0.5)) / under.length)))
    const members = home.get(id)
    if (members && i > 0 && home.get(first[i - 1]) === members) sectors[sectors.length - 1].to += share
    else if (members) sectors.push({ members, from: start, to: start + share, inner: inner - RING_GAP / 2, outer: outer + RING_GAP / 2 })
    start += share
  })
  return { at, sectors }
}

// ---------------------------------------------------------------------------
// Layout: a hand-written force simulation
// ---------------------------------------------------------------------------
//
// Repulsion between every pair, a spring along every edge, a pull to the centre,
// damped velocities, one step at a time. `d3-force` would do it better, but as a
// sixth runtime dependency for about 120 lines.
//
// Cost: repulsion is O(n²) per step. Run to rest, 150 notes took 42 ms, 300 took
// 100 ms and 700 took 0.5 s (2026-09-28), once per change to the graph's shape.
// Beyond that a Barnes-Hut quadtree would pay off; below it, it is slower.
//
// Deterministic: the same vault gives the same picture. Each starting position is a
// seeded hash of the node's id, never `Math.random()`, per node so a new note doesn't
// move the rest, and the loops walk `graph.nodes` in id order.

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
   * The smallest distance used in a force, which guards against NaN: two
   * nodes at the same point have no direction between them, and a NaN spreads
   * to every node in one step. Clamped again inside, so even 0 is safe.
   */
  minDistance: number
  /** Speed clamp, so one crowded frame cannot fling a node to infinity. */
  maxVelocity: number
  /**
   * Annealing: the speed limit is `maxVelocity * cooling ** step`, so
   * nodes move freely early and settle late. Without it a dense graph
   * drifts around `tolerance` and never converges. Set to 1 to disable.
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

/** FNV-1a over the id. It only has to spread values out. */
function hashString(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** mulberry32, inline, rather than a dependency for nine lines. */
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
 * Where a node starts: evenly in a disc whose radius grows with the square root
 * of the node count, so the starting density is about the same for any vault.
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

/** Step zero. Same graph and options, same positions. */
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
    // Nothing to move is already settled.
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
 * One step. Pure: the state passed in isn't changed, so a test can run it
 * in a loop. A node not in the graph is dropped and a node with no
 * position is seeded, so a state survives notes being added or removed.
 */
export function stepLayout(
  graph: NoteGraph,
  state: LayoutState,
  options?: Partial<LayoutOptions>
): LayoutState {
  const opts = withDefaults(options)
  // Even `minDistance: 0` can't divide by zero after this.
  const floor = Math.max(opts.minDistance, 1e-6)
  const count = graph.nodes.length

  const previous = new Map(state.nodes.map((node) => [node.id, node]))
  // Scrub incoming positions: one non-finite value would spread
  // to every node in a step.
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
        // At the same point there is no direction to push along,
        // so take one from the pair's ids, the same on every run.
        const angle = (hashString(`${nodes[i].id} ${nodes[j].id}`) % 62832) / 10000
        dx = Math.cos(angle) * floor
        dy = Math.sin(angle) * floor
        d = floor
      }
      // Dividing by `d` a third time makes (dx, dy) a unit vector.
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
    // `weight` doesn't stiffen the spring, or the three links merged into one edge
    // would pull three times as hard again. The view uses the weight for line width.
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

/** The most steps a layout may take before it is drawn as it stands. */
const SETTLE_STEPS = 800

/** Runs the simulation from step zero until it settles or reaches `maxSteps`. */
export function layout(graph: NoteGraph, options?: Partial<LayoutOptions>, maxSteps = SETTLE_STEPS): LayoutState {
  let state = initialLayout(graph, options)
  for (let i = 0; i < maxSteps && !state.converged; i++) state = stepLayout(graph, state, options)
  return state
}

/**
 * Pushes apart any two nodes closer than their two `room`s,
 * along the line between them, in a fixed order and for a set
 * number of rounds. Two nodes at one point part along x.
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
        // The smaller node moves more: a day pushed off a region
        // moves, the region barely.
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
 * Louvain communities over `n` nodes and weighted pairs `[a, b, w]`.
 * Each node, in order, joins the neighbouring community that raises
 * modularity most, until nothing moves; then each community becomes
 * one node and it repeats until nothing merges. Deterministic.
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

/** Louvain's first phase: each node's community, numbered from 0 in the order met. */
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

/** The fewest notes drawn as a cluster: a pair is a link, not a group. */
const CLUSTER_MIN = 3

/**
 * The groups the notes form: communities over note-to-note links only,
 * largest first, members busiest first (the first names the group).
 * Days and tags are left out, because each touches every group and
 * would merge them all; so is a note linked only through them.
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
  const busiest = (a: string, b: string) => (graph.degree.get(b) ?? 0) - (graph.degree.get(a) ?? 0)
  return [...groups.values()]
    .filter((members) => members.length >= CLUSTER_MIN)
    .map((members) => members.sort(busiest))
    .sort((a, b) => b.length - a.length || compare(a[0], b[0]))
}

/**
 * A cluster as drawn around a note: the band across the rings
 * its notes sit in, between two angles and two radii.
 */
export interface Sector {
  members: readonly string[]
  from: number
  to: number
  inner: number
  outer: number
}

/** A cluster as drawn in Everything: a disc around its members. */
export interface Region {
  members: readonly string[]
  x: number
  y: number
  r: number
}

/**
 * Layout options for a roomier picture: a longer rest length and
 * a stronger push than the defaults.
 */
const ROOMY = { repulsion: 12000, springLength: 90 }
/**
 * Half the least distance between two nodes: room for a dot and the start of a name.
 */
const NODE_ROOM = 22
/** Space inside a region's rim beyond its outermost member, where its name sits. */
export const REGION_PAD = 40

const positionsOf = (state: LayoutState) => new Map(state.nodes.map((node) => [node.id, { x: node.x, y: node.y }]))

/**
 * Everything, by cluster. Each cluster is laid out on its own, then placed as one
 * node, as wide as itself, among the days, tags and unclustered notes. So a day
 * sits between the groups it touches, and no non-member lands inside a region.
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
  // A region's room is its radius plus a node's room, so regions stay apart.
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
    return { members, x: mid.x, y: mid.y, r: shapes[c].r }
  })
  return { at, regions }
}

/**
 * The extents of some points, or null for none: what a fit frames. (`fitToBox`,
 * which squeezed the picture into the pane each frame, is gone for good.)
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


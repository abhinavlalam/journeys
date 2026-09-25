import { describe, expect, it, vi } from 'vitest'
import type { VaultFile, VaultFolder } from '../vaultModel'

// `graph.ts` reaches `vault.ts` only through `links.ts`, and only for pure
// functions, but `vault.ts` imports `@tauri-apps/plugin-fs` at module scope, so the
// seam is still needed. Nothing here reaches a disk.
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  writeFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}))

const { buildNoteIndex, collectNotes } = await import('../links')
const {
  buildNoteGraph,
  initialLayout,
  stepLayout,
  layout,
  boundsOf,
} = await import('../graph')
type LayoutNode = import('../graph').LayoutNode
type LayoutState = import('../graph').LayoutState

// ---------------------------------------------------------------------------
// A vault to build against. Every name here is fictional.
// ---------------------------------------------------------------------------

const note = (path: string): VaultFile => ({
  path,
  absolutePath: `/vault/${path}`,
  name: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
})

const root: VaultFolder = {
  path: '',
  absolutePath: '/vault',
  name: 'Vault',
  files: [note('Index.md'), note('Sleep.md')],
  folders: [
    // `Ideas/` has its note file; `Notes/` does not yet — both are still notes.
    {
      path: 'Ideas',
      absolutePath: '/vault/Ideas',
      name: 'Ideas',
      folders: [],
      files: [],
      note: note('Ideas/Ideas.md'),
    },
    {
      path: 'Notes',
      absolutePath: '/vault/Notes',
      name: 'Notes',
      folders: [],
      files: [note('Notes/Roadmap.md')],
    },
  ],
}

const index = buildNoteIndex(collectNotes(root))

/** The vault's text, as the caller would hand it over. */
const texts = {
  'Index.md':
    'See [Roadmap](Notes/Roadmap.md), the [plan](Notes/Roadmap.md) and [it again](Notes/Roadmap.md).\n' +
    'Also [Ideas](Ideas) and [home](https://pingbird.example) and [me](Index.md).\n',
  'Notes/Roadmap.md': 'Back to [Index](Index.md), forward to [Someday](Later/Someday.md).\n',
  // The caller reads *every* note, so an unwritten folder note arrives as empty text.
  'Notes/Notes.md': '',
  'Ideas/Ideas.md': 'Nothing links out of here.\n',
  'Sleep.md': 'Nor here.\n',
}

const build = (over: Partial<typeof texts> = {}) =>
  buildNoteGraph(
    Object.entries({ ...texts, ...over }).map(([path, text]) => ({ note: note(path), text })),
    index
  )

const edgeList = (g: ReturnType<typeof build>) =>
  g.edges.map((e) => `${e.from} -> ${e.to} x${e.weight}`)

// ---------------------------------------------------------------------------

describe('buildNoteGraph', () => {
  it('makes a node of every note read, folder notes included', () => {
    const graph = build()
    expect(graph.nodes.map((n) => n.path)).toContain('Ideas/Ideas.md')
    expect(graph.byId.get('ideas/ideas')?.exists).toBe(true)
    // `Notes/` has no note file yet and is still a real note the tree opens.
    expect(build({ 'Notes/Roadmap.md': '[up](Notes)' }).byId.get('notes/notes')).toMatchObject({
      path: 'Notes/Notes.md',
      exists: true,
    })
  })

  it('merges the two spellings of a folder note into one node', () => {
    // `[Ideas](Ideas)` and `[Ideas](Ideas/Ideas.md)` are one link, not two.
    const graph = build({ 'Sleep.md': '[a](Ideas) and [b](Ideas/Ideas.md) and [c](ideas/IDEAS.MD)' })
    expect(graph.nodes.filter((n) => n.id === 'ideas/ideas')).toHaveLength(1)
    expect(edgeList(graph)).toContain('sleep -> ideas/ideas x3')
  })

  it('collapses duplicate links into one edge with a count', () => {
    expect(edgeList(build())).toContain('index -> notes/roadmap x3')
  })

  it('keeps direction, so a mutual pair is two edges', () => {
    expect(edgeList(build())).toEqual(
      expect.arrayContaining(['index -> notes/roadmap x3', 'notes/roadmap -> index x1'])
    )
  })

  it('makes no node and no edge for an external link', () => {
    const graph = build()
    expect(graph.nodes.some((n) => n.path.includes('pingbird'))).toBe(false)
    expect(edgeList(graph).some((e) => e.includes('pingbird'))).toBe(false)
    // A scheme never reaches this module — `parseNoteLinks` drops it — so the
    // externals worth pinning here are the ones only `resolveTarget` can name: a
    // file this app does not open, and a path that walks out of the vault.
    const odd = build({ 'Sleep.md': '[a](assets/plan.png) [b](../outside.md) [c](Ideas)' })
    expect(odd.nodes.map((n) => n.id).filter((id) => id !== 'ideas/ideas')).not.toContain('assets/plan')
    expect(edgeList(odd).filter((e) => e.startsWith('sleep ->'))).toEqual([
      'sleep -> ideas/ideas x1',
    ])
  })

  it('does not link a note to itself', () => {
    const graph = build()
    expect(graph.edges.some((e) => e.from === e.to)).toBe(false)
    // The self link was the only link in the note, and the note is still a node.
    const only = build({ 'Sleep.md': '[me](Sleep.md) and [me](sleep) and [here](#top)' })
    expect(only.edges.some((e) => e.from === 'sleep' || e.to === 'sleep')).toBe(false)
    expect(only.orphans.map((n) => n.id)).toContain('sleep')
  })

  it('makes a node for a note that does not exist yet, marked as such', () => {
    const graph = build()
    expect(graph.byId.get('later/someday')).toEqual({
      id: 'later/someday',
      path: 'Later/Someday.md',
      name: 'Someday',
      exists: false,
    })
    expect(edgeList(graph)).toContain('notes/roadmap -> later/someday x1')
  })

  it('reports the aggregates the renderer displays', () => {
    const graph = build()
    // Index, Sleep, Ideas/Ideas, Notes/Notes, Notes/Roadmap, and Later/Someday.
    expect(graph.nodeCount).toBe(6)
    expect(graph.nodes).toHaveLength(6)
    expect(graph.edgeCount).toBe(4)
    expect(graph.orphans.map((n) => n.id)).toEqual(['notes/notes', 'sleep'])
    // Two out (Roadmap, Ideas) and one back from Roadmap.
    expect(graph.degree.get('index')).toBe(3)
    expect(graph.degree.get('sleep')).toBe(0)
  })

  it('is stable: nodes by id, edges by pair, whatever order the notes arrive in', () => {
    const forward = build()
    const backward = buildNoteGraph(
      Object.entries(texts)
        .reverse()
        .map(([path, text]) => ({ note: note(path), text })),
      index
    )
    expect(backward).toEqual(forward)
  })

  it('holds an empty graph for an empty vault', () => {
    const graph = buildNoteGraph([], index)
    expect(graph).toMatchObject({ nodeCount: 0, edgeCount: 0, nodes: [], edges: [], orphans: [] })
  })
})

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** A synthetic vault: a path to its text, every note existing. */
const graphOf = (all: Record<string, string>) => {
  const idx = buildNoteIndex(Object.keys(all).map(note))
  return buildNoteGraph(
    Object.entries(all).map(([path, text]) => ({ note: note(path), text })),
    idx
  )
}

/**
 * **Folders left out of the picture, with the edges that touched them.** On the
 * vault this was built for, the two most linked notes were a currency code and a
 * credit card, because every expense line links both — a diagram of a schema.
 * Dropped *after* the walk, so a link into a hidden note does not come back as a
 * hollow missing node the way filtering the corpus would make it.
 */
describe('hidden folders', () => {
  const all = {
    'Daily/day.md': 'spent [[Entities/Currencies/EUR]] at [[Entities/Restaurants/Cafe]] with [[Entities/People/Ana]]',
    'Entities/Currencies/EUR.md': '',
    'Entities/Restaurants/Cafe.md': '',
    'Entities/People/Ana.md': '',
  }
  const built = (hidden: string[]) => {
    const idx = buildNoteIndex(Object.keys(all).map(note))
    return buildNoteGraph(Object.entries(all).map(([path, text]) => ({ note: note(path), text })), idx, hidden)
  }

  it('drops the notes under a hidden folder and the edges into them', () => {
    const graph = built(['Entities/Currencies'])
    expect(graph.nodes.map((one) => one.name).sort()).toEqual(['Ana', 'Cafe', 'day'])
    expect(graph.edgeCount).toBe(2)
    // Not a hollow "missing" node either: it is gone, not unresolved.
    expect(graph.nodes.some((one) => !one.exists)).toBe(false)
  })

  it('matches a folder and what is under it, not a folder that merely starts alike', () => {
    expect(built(['Entities']).nodes.map((one) => one.name)).toEqual(['day'])
    expect(built(['Entities/Curr']).nodeCount).toBe(4)
  })

  it('is the whole graph when nothing is hidden', () => {
    expect(built([]).nodeCount).toBe(4)
    expect(built([]).edgeCount).toBe(3)
  })

  /** An encrypted note is the owner's alone, so a link into one draws nothing. */
  it('never draws an encrypted note, in either spelling', () => {
    const idx = buildNoteIndex(['Daily/day.md', 'Private.enc', 'Old.enc.md'].map(note))
    const text = 'see [[Private]] and [[Old]]'
    const graph = buildNoteGraph([{ note: note('Daily/day.md'), text }], idx)
    expect(graph.nodes.map((one) => one.name)).toEqual(['day'])
    expect(graph.edgeCount).toBe(0)
  })
})

/** N notes in a line, `N0 -> N1 -> ... -> N(n-1)`. */
const chain = (n: number) =>
  graphOf(
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`N${i}.md`, i + 1 < n ? `[x](N${i + 1}.md)` : ''])
    )
  )

/** N notes, each linking to two others by a fixed stride: more vault-like than a chain. */
const webOf = (n: number) =>
  graphOf(
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `N${i}.md`,
        `[a](N${(i * 7 + 1) % n}.md) [b](N${(i * 13 + 5) % n}.md)`,
      ])
    )
  )

const at = (state: { nodes: { id: string; x: number; y: number }[] }, id: string) =>
  state.nodes.find((n) => n.id === id)

const allFinite = (state: { nodes: LayoutNode[] }) =>
  state.nodes.every(
    (n) =>
      Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.vx) && Number.isFinite(n.vy)
  )

const closestPair = (state: { nodes: { x: number; y: number }[] }) => {
  let min = Infinity
  for (let i = 0; i < state.nodes.length; i++) {
    for (let j = i + 1; j < state.nodes.length; j++) {
      min = Math.min(min, Math.hypot(state.nodes[i].x - state.nodes[j].x, state.nodes[i].y - state.nodes[j].y))
    }
  }
  return min
}

const stacked = (ids: string[]): LayoutState => ({
  nodes: ids.map((id) => ({ id, x: 0, y: 0, vx: 0, vy: 0 })),
  step: 0,
  maxSpeed: 0,
  converged: false,
})

describe('determinism', () => {
  const graph = chain(8)

  it('gives byte-identical positions for two runs on the same graph', () => {
    expect(layout(graph)).toEqual(layout(graph))
    // Rebuilt from scratch, not the same object — the guarantee is about the input.
    expect(layout(chain(8))).toEqual(layout(graph))
    expect(initialLayout(chain(8))).toEqual(initialLayout(graph))
  })

  it('never touches Math.random', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('the layout must be seeded, not random')
    })
    try {
      expect(allFinite(layout(chain(6)))).toBe(true)
    } finally {
      random.mockRestore()
    }
  })

  it('gives a different layout once a note is added', () => {
    const before = layout(graph)
    const after = layout(chain(9))
    expect(after.nodes).toHaveLength(9)
    expect(after.nodes.slice(0, 8).map((n) => n.x)).not.toEqual(before.nodes.map((n) => n.x))
  })

  it('seeds each node from its own id, so adding a note only rescales the disc', () => {
    // Per-node hashing rather than one shared stream: a ninth note widens the
    // starting disc by exactly sqrt(9/8) and every note keeps its place in it. One
    // shared stream would have reshuffled all eight.
    const before = initialLayout(graph)
    const after = initialLayout(chain(9))
    const grow = Math.sqrt(9 / 8)
    for (const node of before.nodes) {
      expect(at(after, node.id)!.x).toBeCloseTo(node.x * grow, 9)
      expect(at(after, node.id)!.y).toBeCloseTo(node.y * grow, 9)
    }
  })

  it('starts every note at its own point, not one shared point', () => {
    // Without this, a shared seed stacks the whole vault on one spot and only the
    // coincident-pair guard saves it — which the NaN tests would not notice.
    const state = initialLayout(chain(8))
    expect(new Set(state.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(8)
  })

  it('reshuffles on purpose when the seed changes', () => {
    expect(initialLayout(graph, { seed: 7 }).nodes[0].x).not.toBe(initialLayout(graph).nodes[0].x)
  })
})

describe('stepLayout', () => {
  it('does not touch the state it was given', () => {
    const graph = chain(4)
    const state = initialLayout(graph)
    const frozen = structuredClone(state)
    stepLayout(graph, state)
    expect(state).toEqual(frozen)
  })

  it('separates two nodes sitting exactly on top of each other', () => {
    // The classic failure: `dx / 0` is NaN, and one NaN reaches every node through
    // the pair loop in a single frame and never leaves.
    const graph = graphOf({ 'A.md': '[b](B.md)', 'B.md': '' })
    let state: LayoutState = stacked(['a', 'b'])
    state = stepLayout(graph, state)
    expect(allFinite(state)).toBe(true)
    expect(closestPair(state)).toBeGreaterThan(0)
    for (let i = 0; i < 600 && !state.converged; i++) state = stepLayout(graph, state)
    expect(allFinite(state)).toBe(true)
    expect(closestPair(state)).toBeGreaterThan(10)
  })

  it('survives a minDistance of zero, which would divide by it', () => {
    const graph = graphOf({ 'A.md': '', 'B.md': '', 'C.md': '' })
    const state = stepLayout(graph, stacked(['a', 'b', 'c']), { minDistance: 0 })
    expect(allFinite(state)).toBe(true)
  })

  it('nudges a stacked pair the same way every run', () => {
    const graph = graphOf({ 'A.md': '', 'B.md': '' })
    expect(stepLayout(graph, stacked(['a', 'b']))).toEqual(stepLayout(graph, stacked(['a', 'b'])))
  })

  it('scrubs a non-finite position rather than spreading it', () => {
    const graph = chain(4)
    const state = initialLayout(graph)
    state.nodes[1].x = NaN
    state.nodes[2].vy = Infinity
    const next = stepLayout(graph, state)
    expect(allFinite(next)).toBe(true)
    // The healthy nodes were not reset with them.
    expect(next.nodes[0].x).not.toBe(state.nodes[0].x)
    expect(Number.isFinite(next.nodes[0].x)).toBe(true)
  })

  it('does not let an edge weight stiffen the spring', () => {
    // The reason duplicates were collapsed in the first place. A note mentioned
    // three times is drawn once, at the same distance, with a thicker line left to
    // the renderer.
    const once = graphOf({ 'A.md': '[b](B.md)', 'B.md': '' })
    const thrice = graphOf({ 'A.md': '[b](B.md) [b](B.md) [b](B.md)', 'B.md': '' })
    expect(thrice.edges[0].weight).toBe(3)
    expect(layout(thrice)).toEqual(layout(once))
  })

  it('takes a graph that changed under it: a note added, a note deleted', () => {
    const four = chain(4)
    const settled = layout(four)
    const three = chain(3)
    const shrunk = stepLayout(three, settled)
    expect(shrunk.nodes.map((n) => n.id)).toEqual(['n0', 'n1', 'n2'])
    const grown = stepLayout(chain(5), settled)
    expect(grown.nodes.map((n) => n.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
    // The incumbents kept roughly where they were.
    expect(allFinite(grown)).toBe(true)
    expect(Math.abs(grown.nodes[0].x - settled.nodes[0].x)).toBeLessThan(5)
    // And the newcomer is *seeded*, not dropped at the origin: stepping a state
    // that knows nothing about any of them has to match stepping frame zero.
    expect(stepLayout(chain(5), { nodes: [], step: 0, maxSpeed: 0, converged: false })).toEqual(
      stepLayout(chain(5), initialLayout(chain(5)))
    )
  })
})

describe('layout', () => {
  it('converges, and inside the bound the cooling schedule guarantees', () => {
    // `maxVelocity * cooling ** step <= tolerance` at step 596, so nothing can
    // still be moving after that however tangled it is.
    for (const graph of [chain(2), chain(23), chain(60), webOf(200)]) {
      const state = layout(graph)
      expect(state.converged).toBe(true)
      expect(state.step).toBeLessThanOrEqual(600)
      expect(allFinite(state)).toBe(true)
      expect(closestPair(state)).toBeGreaterThan(5)
    }
  })

  it('stops early when told to, without claiming it converged', () => {
    const state = layout(chain(23), undefined, 5)
    expect(state.step).toBe(5)
    expect(state.converged).toBe(false)
    expect(layout(chain(23), undefined, 0).step).toBe(0)
  })

  it('holds an empty graph still', () => {
    const graph = buildNoteGraph([], buildNoteIndex([]))
    expect(initialLayout(graph)).toEqual({ nodes: [], step: 0, maxSpeed: 0, converged: true })
    // Already converged, so it never steps.
    expect(layout(graph).step).toBe(0)
    expect(boundsOf(layout(graph))).toBeNull()
  })

  it('draws one node in toward the centre it is pulled toward', () => {
    const graph = graphOf({ 'Only.md': '' })
    const from = Math.hypot(initialLayout(graph).nodes[0].x, initialLayout(graph).nodes[0].y)
    const state = layout(graph)
    expect(state.converged).toBe(true)
    expect(from).toBeGreaterThan(5)
    // Not exactly the origin: gravity decays it exponentially and the cooling
    // clamp calls a halt while a fraction of a pixel is still left.
    expect(Math.hypot(state.nodes[0].x, state.nodes[0].y)).toBeLessThan(2)
  })

  it('keeps a note that links only to itself, as an orphan with a position', () => {
    const graph = graphOf({ 'Loop.md': '[me](Loop.md) [me](loop)', 'Other.md': '' })
    expect(graph.edges).toEqual([])
    expect(graph.orphans.map((n) => n.id)).toEqual(['loop', 'other'])
    const state = layout(graph)
    expect(allFinite(state)).toBe(true)
    expect(state.nodes.map((n) => n.id)).toEqual(['loop', 'other'])
  })

  it('pulls the members of each disconnected component together', () => {
    // Three triangles that share nothing. Repulsion alone would space all nine
    // evenly; the springs are what has to win inside a component.
    const parts = ['a', 'b', 'c']
    const graph = graphOf(
      Object.fromEntries(
        parts.flatMap((p) => [
          [`${p}1.md`, `[x](${p}2.md) [y](${p}3.md)`],
          [`${p}2.md`, `[x](${p}3.md)`],
          [`${p}3.md`, ''],
        ])
      )
    )
    const state = layout(graph)
    expect(state.converged).toBe(true)
    const dist = (a: string, b: string) => {
      const p = at(state, a)!
      const q = at(state, b)!
      return Math.hypot(p.x - q.x, p.y - q.y)
    }
    const inside = parts.flatMap((p) => [dist(`${p}1`, `${p}2`), dist(`${p}1`, `${p}3`)])
    const across = [dist('a1', 'b1'), dist('b1', 'c1'), dist('a1', 'c1')]
    expect(Math.max(...inside)).toBeLessThan(Math.min(...across))
  })

  it('stays finite and settles on a graph far larger than this vault', () => {
    // Cost is O(n^2) per step for repulsion, O(n + e) for the rest. Measured on
    // this machine, warmed, ms per step: 100 nodes 0.02, 250 0.12, 500 0.43,
    // 1000 1.7, 2000 7.1, 4000 27.9 — clean quadratic, 4x per doubling. So a step
    // fits a 60 fps frame up to ~2,000 nodes with the renderer's own work in it,
    // and past ~3,000 the step alone overruns the frame. That is where a
    // Barnes-Hut quadtree starts paying for its complexity; below ~500 it is
    // slower than the loop it replaces. This vault holds ~23 notes.
    const graph = webOf(300)
    expect(graph.nodeCount).toBe(300)
    const state = layout(graph)
    expect(state.converged).toBe(true)
    expect(allFinite(state)).toBe(true)
  })
})

describe('boundsOf', () => {
  /** Its own function since the renderer took a view transform of its own:
   *  it needs the extents once, to decide where to start, rather than the mapping
   *  done for it on every frame. */
  it('answers the extents, and null for nothing to bound', () => {
    const state = stacked(['a', 'b', 'c'])
    const only = boundsOf(state)
    expect(only).not.toBeNull()
    expect(boundsOf({ ...state, nodes: [] })).toBeNull()
  })

  it('spans every node', () => {
    const state: LayoutState = {
      nodes: [
        { id: 'a', x: -10, y: 4, vx: 0, vy: 0 },
        { id: 'b', x: 30, y: -6, vx: 0, vy: 0 },
      ],
      step: 0,
      maxSpeed: 0,
      converged: true,
    }
    expect(boundsOf(state)).toEqual({ minX: -10, maxX: 30, minY: -6, maxY: 4 })
  })
})


/**
 * A vault linked *only* by `[[wikilinks]]`, which is how the user's notes are
 * written — and the test whose absence let a shipped bug through.
 *
 * The graph looked "random, with no clusters" because it had **no edges at all**.
 * Two separate causes, and the first hid the second: `parseNoteLinks` did not read
 * wikilinks, and once it did, `graph.ts` still passed `link.target` — a bare string,
 * which gets *markdown* semantics — so every bare name resolved to a phantom node
 * at the vault root while the real note it named sat beside it as an orphan.
 *
 * Every link test before this one used markdown syntax, so the whole suite was
 * self-consistent and blind in the same direction. This one asserts the edges a
 * person would count by eye, across folders, with nothing but wikilinks.
 */
describe('a vault written the way the user writes one', () => {
  const wikiRoot: VaultFolder = {
    path: '',
    absolutePath: '/v',
    name: 'Vault',
    files: [note('Index.md')],
    folders: [
      {
        path: 'Notes',
        absolutePath: '/v/Notes',
        name: 'Notes',
        folders: [],
        files: [note('Notes/Roadmap.md')],
      },
      {
        path: 'Areas',
        absolutePath: '/v/Areas',
        name: 'Areas',
        folders: [
          {
            path: 'Areas/Health',
            absolutePath: '/v/Areas/Health',
            name: 'Health',
            folders: [],
            files: [note('Areas/Health/Diet.md')],
          },
        ],
        files: [],
      },
    ],
  }

  const wikiIndex = buildNoteIndex(collectNotes(wikiRoot))

  it('finds the notes the names mean, in whatever folder they live', () => {
    const g = buildNoteGraph(
      [
        { note: note('Index.md'), text: 'start: [[Roadmap]] and [[Diet]]' },
        { note: note('Notes/Roadmap.md'), text: 'health matters: [[Diet]]' },
        { note: note('Areas/Health/Diet.md'), text: 'back to [[Index]]' },
      ],
      wikiIndex
    )

    // Three real notes and nothing else: a phantom would make it four or five.
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['areas/health/diet', 'index', 'notes/roadmap'])
    expect(g.nodes.every((n) => n.exists)).toBe(true)
    expect(g.orphans).toEqual([])
    expect(g.edgeCount).toBe(4)
    expect(
      g.edges.map((e) => `${e.from}->${e.to}`).sort()
    ).toEqual([
      'areas/health/diet->index',
      'index->areas/health/diet',
      'index->notes/roadmap',
      'notes/roadmap->areas/health/diet',
    ])
  })

  it('still dangles a wikilink naming no note, rather than silently dropping it', () => {
    const g = buildNoteGraph(
      [{ note: note('Index.md'), text: 'someday: [[Quillfeather Press]]' }],
      wikiIndex
    )
    expect(g.byId.get('quillfeather press')?.exists).toBe(false)
    expect(g.edgeCount).toBe(1)
  })
})

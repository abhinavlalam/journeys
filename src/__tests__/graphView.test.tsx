/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  disk,
  fsModule,
  markdownEditorModule,
  rememberVault,
  resetFakeVault,
} from './fakeVault'
import { buildNoteGraph } from '../graph'
import type { NoteGraph } from '../graph'
import { buildNoteIndex } from '../links'
import type { VaultFile } from '../vaultModel'
import { renderToStaticMarkup } from 'react-dom/server'
import { GraphView, decluttered } from '../GraphView'

/**
 * The note graph's **view**: the frame loop, the pane swap, and the click that
 * opens a note.
 *
 * The model has its own file — `graph.test.ts` — and none of the forces are
 * re-tested here. What is here is everything the model deliberately refused to
 * own, because it is where this feature's bugs live:
 *
 * - a `requestAnimationFrame` loop that never stops, or that outlives the pane,
 * - a click that opens a note by setting the active file instead of reading it,
 * - the open note's *unsaved* text being missing from the graph,
 * - and `NaN` from a box jsdom never laid out.
 *
 * Three facts about jsdom shaped the file, and two of them are the opposite of
 * what you would guess. `matchMedia` and `ResizeObserver` do **not** exist, so
 * both are stubbed here and guarded for in the component. `requestAnimationFrame`
 * **does** — a real one, on a real ~16 ms timer — so the frame tests replace it
 * with a queue they drive by hand, and the App tests stub
 * `prefers-reduced-motion: reduce` so no animation runs at all. And nothing is
 * ever laid out, so `getBoundingClientRect` is all zeroes: there is not one
 * geometry assertion below, only assertions that the numbers are numbers.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A queue of frames the test advances itself, standing in for jsdom's real one. */
function installFrames() {
  const realRequest = globalThis.requestAnimationFrame
  const realCancel = globalThis.cancelAnimationFrame
  const queue = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  let id = 0
  let requests = 0

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    requests += 1
    queue.set((id += 1), callback)
    return id
  }) as typeof globalThis.requestAnimationFrame
  globalThis.cancelAnimationFrame = ((handle: number) => {
    cancelled.push(handle)
    queue.delete(handle)
  }) as typeof globalThis.cancelAnimationFrame

  return {
    /** Frames waiting to run. Zero is what "the loop stopped" looks like. */
    get pending() {
      return queue.size
    },
    /** Every frame ever asked for. Zero is what "no animation" looks like. */
    get requests() {
      return requests
    },
    get cancelled() {
      return cancelled
    },
    /** Runs each queued frame once. */
    step() {
      const due = [...queue.values()]
      queue.clear()
      act(() => {
        for (const callback of due) callback(0)
      })
    },
    restore() {
      globalThis.requestAnimationFrame = realRequest
      globalThis.cancelAnimationFrame = realCancel
    },
  }
}

/** The one media query `GraphView` asks about, with no listener — which is the
    shape the component has to survive, since it only registers one if it can. */
function stubReducedMotion(reduce: boolean) {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: reduce, media: query }),
  })
}

function clearMatchMedia() {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: undefined,
  })
}

function file(path: string): VaultFile {
  return {
    path,
    absolutePath: `/v/${path}`,
    name: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
  }
}

/** A graph from `path -> text`, through the real builder and the real index. */
function graphOf(notes: Record<string, string>): NoteGraph {
  const files = Object.keys(notes).map(file)
  return buildNoteGraph(
    files.map((note) => ({ note, text: notes[note.path] })),
    buildNoteIndex(files)
  )
}

/**
 * A chain long enough that it cannot settle in one frame, so "the loop stops" is
 * a fact about annealing and not about there being nothing to do.
 */
const CHAIN = graphOf({
  'pingbird.md': 'See [Moonhatch](moonhatch.md)',
  'moonhatch.md': 'See [Quillfeather](quillfeather.md)',
  'quillfeather.md': 'See [Tinbeacon](tinbeacon.md)',
  'tinbeacon.md': 'See [Saltcadence](saltcadence.md)',
  'saltcadence.md': 'See [Pingbird](pingbird.md)',
})

const nodes = () => [...document.querySelectorAll('.graph-node')]
const edges = () => [...document.querySelectorAll('.graph-edge')]

/** Every coordinate the SVG carries, as written into the DOM. */
function coordinates(): string[] {
  const out: string[] = []
  for (const circle of document.querySelectorAll('circle')) {
    for (const name of ['cx', 'cy', 'r']) out.push(circle.getAttribute(name) ?? 'missing')
  }
  for (const line of document.querySelectorAll('line')) {
    for (const name of ['x1', 'y1', 'x2', 'y2']) out.push(line.getAttribute(name) ?? 'missing')
  }
  for (const text of document.querySelectorAll('text')) {
    for (const name of ['x', 'y']) out.push(text.getAttribute(name) ?? 'missing')
  }
  return out
}

afterEach(() => {
  cleanup()
  clearMatchMedia()
})

// ---------------------------------------------------------------------------
// The frame loop
// ---------------------------------------------------------------------------

describe('the graph animation', () => {
  it('stops asking for frames once the layout converges', () => {
    const frames = installFrames()
    try {
      stubReducedMotion(false)
      render(<GraphView graph={CHAIN} loading={false} currentId={null} onSelect={() => {}} />)

      // Mounting starts it, and one frame is not enough to settle a five-note ring.
      expect(frames.pending).toBe(1)

      // A ceiling far above the ~600 steps `graph.ts` promises, so a loop that
      // never terminates ends this test rather than the machine.
      let stepped = 0
      while (frames.pending > 0 && stepped < 3000) {
        frames.step()
        stepped += 1
      }

      expect(frames.pending).toBe(0)
      expect(stepped).toBeLessThan(600)
      // It ran to rest rather than stopping early with the picture half made.
      expect(nodes()).toHaveLength(CHAIN.nodeCount)
    } finally {
      frames.restore()
    }
  })

  it('cancels the frame it is holding when the pane closes', () => {
    const frames = installFrames()
    try {
      stubReducedMotion(false)
      const { unmount } = render(
        <GraphView graph={CHAIN} loading={false} currentId={null} onSelect={() => {}} />
      )
      frames.step()
      // Mid-flight: settled would make cancelling nothing to prove.
      expect(frames.pending).toBe(1)

      unmount()

      expect(frames.cancelled).toHaveLength(1)
      expect(frames.pending).toBe(0)
    } finally {
      frames.restore()
    }
  })

  it('asks for no frames at all under prefers-reduced-motion', () => {
    const frames = installFrames()
    try {
      stubReducedMotion(true)
      render(<GraphView graph={CHAIN} loading={false} currentId={null} onSelect={() => {}} />)

      expect(frames.requests).toBe(0)
      // Not "nothing happened": the whole graph is on screen, settled, in one pass.
      expect(nodes()).toHaveLength(CHAIN.nodeCount)
      expect(edges()).toHaveLength(CHAIN.edgeCount)
    } finally {
      frames.restore()
    }
  })

  it('does not restart the simulation when the graph is replaced', () => {
    const frames = installFrames()
    try {
      stubReducedMotion(false)
      const view = render(
        <GraphView graph={CHAIN} loading={false} currentId={null} onSelect={() => {}} />
      )
      let stepped = 0
      while (frames.pending > 0 && stepped < 3000) {
        frames.step()
        stepped += 1
      }
      const settled = stepped

      // One more edge, as a fresh read of the vault would hand over mid-session.
      const grown = graphOf({
        'pingbird.md': 'See [Moonhatch](moonhatch.md) and [Tinbeacon](tinbeacon.md)',
        'moonhatch.md': 'See [Quillfeather](quillfeather.md)',
        'quillfeather.md': 'See [Tinbeacon](tinbeacon.md)',
        'tinbeacon.md': 'See [Saltcadence](saltcadence.md)',
        'saltcadence.md': 'See [Pingbird](pingbird.md)',
      })
      view.rerender(
        <GraphView graph={grown} loading={false} currentId={null} onSelect={() => {}} />
      )

      let again = 0
      while (frames.pending > 0 && again < 3000) {
        frames.step()
        again += 1
      }
      // Re-seeding from `initialLayout` would cost about what the first run did.
      // Carrying the positions over settles the change in a fraction of it.
      expect(again).toBeGreaterThan(0)
      expect(again).toBeLessThan(settled / 2)
    } finally {
      frames.restore()
    }
  })
})

// ---------------------------------------------------------------------------
// A box nothing ever laid out
// ---------------------------------------------------------------------------

describe('the graph in a box with no size', () => {
  it('writes finite coordinates from a 0x0 box, animating and settled', () => {
    const frames = installFrames()
    try {
      stubReducedMotion(false)
      render(<GraphView graph={CHAIN} loading={false} currentId={null} onSelect={() => {}} />)
      // jsdom lays nothing out, so this *is* the 0x0 case, at frame zero...
      expect(coordinates().every((value) => Number.isFinite(Number(value)))).toBe(true)
      // ...and at every frame after it.
      let stepped = 0
      while (frames.pending > 0 && stepped < 3000) {
        frames.step()
        stepped += 1
      }
      expect(coordinates().every((value) => Number.isFinite(Number(value)))).toBe(true)
      expect(document.querySelector('.graph-canvas')!.outerHTML).not.toMatch(/NaN/)
    } finally {
      frames.restore()
    }
  })

  it('writes finite coordinates from a box that measures NaN', () => {
    stubReducedMotion(true)
    const real = Element.prototype.getBoundingClientRect
    // A rect a real engine can hand back mid-transition, and the one shape
    // the fit cannot defend itself against: its guards are about the *spans*
    // being zero, not about the box being unmeasurable.
    Element.prototype.getBoundingClientRect = function () {
      return { width: NaN, height: NaN, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 } as DOMRect
    }
    try {
      render(<GraphView graph={CHAIN} loading={false} currentId={null} onSelect={() => {}} />)
      expect(coordinates()).not.toHaveLength(0)
      expect(coordinates().every((value) => Number.isFinite(Number(value)))).toBe(true)
    } finally {
      Element.prototype.getBoundingClientRect = real
    }
  })
})

// ---------------------------------------------------------------------------
// Moving around it
// ---------------------------------------------------------------------------

/**
 * **The graph was unusable, and it was the view and not the model.** The forces
 * settled fine; the picture was then squeezed into the pane on every
 * frame, with every label on at once and no way to move — so any graph past a
 * handful of notes was a knot of overlapping discs. What is tested here is the
 * three things that fixes: naming on hover, the pointer moving the view, and a
 * drag that arranges a node instead of opening it.
 */
describe('moving around the graph', () => {
  /** A hub with two spokes and one note connected to nothing. */
  const HUB = graphOf({
    'hub.md': 'See [Spoke](spoke.md) and [Rim](rim.md)',
    'spoke.md': '',
    'rim.md': '',
    'lonely.md': '',
  })

  const labelled = () =>
    [...document.querySelectorAll('.graph-label')].map((one) => one.textContent).sort()
  const groupFor = (name: string) => screen.getByLabelText(name).closest('g') as SVGGElement

  /**
   * **Hovering a node names it and everything it touches, and dims the rest** —
   * asked for in those words. It is the interaction that turns a hairball into
   * something readable, because a graph answers "what is this connected to" and
   * pointing is how the question gets asked.
   */
  it('names the hovered node and its neighbours, and dims the rest', () => {
    stubReducedMotion(true)
    render(<GraphView graph={HUB} loading={false} currentId={null} onSelect={() => {}} />)

    fireEvent.pointerEnter(groupFor('hub'))
    expect(labelled()).toEqual(['hub', 'rim', 'spoke'])
    // The unconnected note is still drawn and still clickable, only faded.
    expect(groupFor('lonely').getAttribute('opacity')).toBe('0.12')
    expect(groupFor('spoke').getAttribute('opacity')).toBe('1')

    // Leaving puts everything back.
    fireEvent.pointerLeave(groupFor('hub'))
    expect(groupFor('lonely').getAttribute('opacity')).toBe('1')
  })

  /** An edge is lit from either end, because a connection is one thing whichever
   *  side of it you are standing on. */
  it('lights an edge from either of its ends', () => {
    stubReducedMotion(true)
    render(<GraphView graph={HUB} loading={false} currentId={null} onSelect={() => {}} />)
    fireEvent.pointerEnter(groupFor('spoke'))
    const faded = edges().filter((one) => one.getAttribute('opacity') !== '1')
    // Two edges leave the hub; hovering one spoke leaves its own lit and dims the
    // other, so exactly one is faded.
    expect(faded).toHaveLength(1)
  })

  /**
   * **A drag arranges a node; it does not open it.** The browser sends a click
   * after any press-and-release on one element however far the pointer travelled,
   * so the click following a moved gesture is swallowed rather than selection being
   * taken off `click` — which would cost the keyboard and every assistive path.
   */
  it('opens a node on a press that stayed put, and not on one that moved', () => {
    stubReducedMotion(true)
    const opened: string[] = []
    render(
      <GraphView
        graph={HUB}
        loading={false}
        currentId={null}
        onSelect={(node) => opened.push(node.id)}
      />
    )
    const hub = groupFor('hub')

    // Moved: arranged, not opened.
    fireEvent.pointerDown(hub, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 60, clientY: 40 })
    fireEvent.pointerUp(window)
    fireEvent.click(hub)
    expect(opened).toEqual([])

    // Still: opened.
    fireEvent.pointerDown(hub, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(window)
    fireEvent.click(hub)
    expect(opened).toEqual(['hub'])
  })

  /** The keyboard still opens one, which is the reason selection stayed on a click
   *  rather than moving to the pointer sequence. */
  it('opens a node from the keyboard', () => {
    stubReducedMotion(true)
    const opened: string[] = []
    render(
      <GraphView
        graph={HUB}
        loading={false}
        currentId={null}
        onSelect={(node) => opened.push(node.id)}
      />
    )
    fireEvent.keyDown(groupFor('rim'), { key: 'Enter' })
    expect(opened).toEqual(['rim'])
  })
})

/**
 * **What is named when nothing is hovered.** The resting graph was the complaint —
 * the hover reads well and the rest did not — and the measurement said why: on the
 * vault it was found in, 108 nodes and 198 edges at a fit zoom of 0.663 against a
 * label threshold of 0.75, so *no labels at all*. A hundred anonymous dots is a
 * picture of nothing.
 *
 * Deciding by zoom was the mistake at both ends, because a zoom says nothing about
 * whether two particular names overlap. Deciding by collision says exactly that.
 * Measured after, on the same vault: 76 of 108 named at the fit, 104 at 1.5×, all
 * 108 at 3×.
 */
describe('naming the graph at rest', () => {
  const at = (positions: Record<string, [number, number]>) =>
    new Map(Object.entries(positions).map(([id, [x, y]]) => [id, { x, y }]))

  /** Two nodes on the same spot: one name can be drawn, and it is the hub's, because
   *  a hub is what orients you — if only one name fits, it should be the one the
   *  region is about. */
  it('keeps the better connected of two names that collide', () => {
    const graph = graphOf({
      'hub.md': 'See [Spoke](spoke.md) and [Rim](rim.md)',
      'spoke.md': '',
      'rim.md': '',
      'lonely.md': '',
    })
    const shown = decluttered(graph, at({ hub: [0, 0], spoke: [0, 0], rim: [500, 0], lonely: [1000, 0] }), 1, null)
    expect(shown.has('hub')).toBe(true)
    expect(shown.has('spoke')).toBe(false)
    // Far enough away to have room of their own.
    expect(shown.has('rim')).toBe(true)
    expect(shown.has('lonely')).toBe(true)
  })

  /** **Where am I outranks how connected.** The open note is placed first whatever
   *  its degree, so it cannot be the one that loses a collision. */
  it('always names the open note, even against a hub', () => {
    const graph = graphOf({
      'hub.md': 'See [Spoke](spoke.md) and [Rim](rim.md)',
      'spoke.md': '',
      'rim.md': '',
      'lonely.md': '',
    })
    const shown = decluttered(graph, at({ hub: [0, 0], spoke: [9, 9], rim: [500, 0], lonely: [0, 2] }), 1, 'lonely')
    expect(shown.has('lonely')).toBe(true)
    expect(shown.has('hub')).toBe(false)
  })

  /** Zooming spreads the nodes, so more names fit — which is the whole point of
   *  deciding by collision rather than by a threshold. */
  it('names more as the zoom spreads them apart', () => {
    const graph = graphOf({
      'one.md': '', 'two.md': '', 'three.md': '', 'four.md': '',
    })
    const spots = at({ one: [0, 0], two: [30, 0], three: [60, 0], four: [90, 0] })
    const close = decluttered(graph, spots, 0.3, null)
    const far = decluttered(graph, spots, 4, null)
    expect(far.size).toBeGreaterThan(close.size)
    expect(far.size).toBe(4)
  })

  /** A node with no position yet — the frame before the layout has it — is skipped
   *  rather than named at the origin, where it would block everything else. */
  it('skips a node the layout has not placed', () => {
    const graph = graphOf({ 'one.md': '', 'two.md': '' })
    expect(decluttered(graph, at({ one: [0, 0] }), 1, null)).toEqual(new Set(['one']))
  })
})

// ---------------------------------------------------------------------------
// What the view reports
// ---------------------------------------------------------------------------

describe('the graph as a renderer', () => {
  it('reports a click on a node that has no note behind it, rather than hiding it', () => {
    stubReducedMotion(true)
    const graph = graphOf({ 'pingbird.md': 'See [Moonhatch](moonhatch.md)' })
    const selected: string[] = []
    render(
      <GraphView
        graph={graph}
        loading={false}
        currentId={null}
        onSelect={(node) => selected.push(`${node.id} exists=${node.exists}`)}
      />
    )
    // The renderer draws it differently and hands the decision up; what a click on
    // one *does* belongs to App, and has its own test below.
    expect(document.querySelector('.graph-node.missing')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('moonhatch (no note yet)'))
    expect(selected).toEqual(['moonhatch exists=false'])
  })

  it('marks the open note and nothing else', () => {
    stubReducedMotion(true)
    render(
      <GraphView graph={CHAIN} loading={false} currentId="quillfeather" onSelect={() => {}} />
    )
    expect(document.querySelectorAll('.graph-node.current')).toHaveLength(1)
    expect(screen.getByLabelText('quillfeather').querySelector('.current')).toBeTruthy()
  })

  /**
   * Frame zero has to come out of the *render*, not out of the effect that drives
   * the frames — an effect commits one paint late, so the canvas would appear with
   * nothing inside it and fill in afterwards. A server render is the one way to
   * observe a single commit with no effects run at all, which is exactly the
   * distinction: `useMemo` runs here and `useEffect` does not.
   *
   * This was a real bug, and its only symptom was a flaky test three tests down.
   */
  it('has its nodes in the very first render, before any effect', () => {
    stubReducedMotion(true)
    const markup = renderToStaticMarkup(
      <GraphView graph={CHAIN} loading={false} currentId={null} onSelect={() => {}} />
    )
    expect(markup).toContain('graph-canvas')
    expect(markup.match(/graph-node/g) ?? []).toHaveLength(CHAIN.nodeCount)
    expect(markup).not.toMatch(/NaN/)
  })

  it('says it is reading rather than saying there is nothing', () => {
    stubReducedMotion(true)
    render(<GraphView graph={null} loading currentId={null} onSelect={() => {}} />)
    expect(document.querySelector('.graph-empty')!.textContent).toMatch(/reading/i)
  })
})

// ---------------------------------------------------------------------------
// The pane, in the app
// ---------------------------------------------------------------------------

describe('the graph in the note pane', () => {
  beforeEach(() => {
    resetFakeVault()
    rememberVault('/v')
    // No frame loop in these: the point of them is the wiring, and jsdom's real
    // `requestAnimationFrame` would otherwise run a few hundred timed frames
    // outside `act` in the middle of every one.
    stubReducedMotion(true)
  })

  const row = (name: string) => within(document.querySelector('.file-list')!).getByText(name)
  const graphToggle = (label: string) =>
    within(document.querySelector('.sidebar')!).getByLabelText(label)

  async function openApp() {
    const { default: App } = await import('../App')
    render(<App />)
    await waitFor(() => expect(row('roadmap')).toBeTruthy())
  }

  async function openTheNote(name: string) {
    fireEvent.click(row(name))
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())
  }

  function type(text: string) {
    fireEvent.change(screen.getByTestId('editor') as HTMLTextAreaElement, {
      target: { value: text },
    })
  }

  async function openTheGraph() {
    fireEvent.click(graphToggle('Open the note graph'))
    await waitFor(() => expect(document.querySelector('.graph-view')).toBeTruthy())
    // On a *node*, not on the canvas: the read is async, and waiting for the
    // canvas alone was the flake that found the empty-first-paint bug above.
    await waitFor(() => expect(nodes().length).toBeGreaterThan(0))
  }

  it('replaces the editor and leaves the tree standing', async () => {
    await openApp()
    await openTheNote('roadmap')
    await openTheGraph()

    expect(screen.queryByTestId('editor')).toBeNull()
    expect(row('roadmap')).toBeTruthy()
    // And the icon takes it back.
    fireEvent.click(graphToggle('Close the note graph'))
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())
    expect(document.querySelector('.graph-view')).toBeNull()
  })

  it('opens the note a clicked node stands for, and writes into that note', async () => {
    disk.write('/v/roadmap.md', '# Roadmap\n\nNext up: [Inbox](inbox.md)\n')
    const untouched = disk.read('/v/roadmap.md')!
    await openApp()
    await openTheNote('roadmap')
    await openTheGraph()

    fireEvent.click(screen.getByLabelText('inbox'))
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())
    type('# Inbox\n\nTyped after arriving from the graph.\n')

    // The bytes, in both files. This is CLAUDE.md's second trap: switching the
    // active file *before* reading leaves the editor holding roadmap's text, and
    // this keystroke saves it into inbox — with roadmap's own file untouched, so
    // an assertion on one file alone would not see it.
    await waitFor(
      () => expect(disk.read('/v/inbox.md')).toContain('Typed after arriving from the graph.')
    )
    expect(disk.read('/v/inbox.md')).not.toContain('Roadmap')
    expect(disk.read('/v/roadmap.md')).toBe(untouched)
  })

  it('does nothing when the clicked node has no note behind it', async () => {
    disk.write('/v/roadmap.md', '# Roadmap\n\nLater: [Quillfeather](quillfeather.md)\n')
    await openApp()
    await openTheNote('roadmap')
    await openTheGraph()

    fireEvent.click(screen.getByLabelText('quillfeather (no note yet)'))

    // Still the graph, no editor, and above all no note conjured on disk.
    expect(document.querySelector('.graph-view')).toBeTruthy()
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(disk.has('/v/quillfeather.md')).toBe(false)
  })

  it('carries a link that autosave has not written yet', async () => {
    await openApp()
    await openTheNote('roadmap')
    type('# Roadmap\n\nNext up: [Inbox](inbox.md)\n')

    // Deliberately not waiting: the link exists in the editor and nowhere else,
    // which is the only state this feature is about. `buffer.body` is the *mount*
    // value, so it does not have it either.
    expect(disk.read('/v/roadmap.md')).not.toContain('inbox.md')

    await openTheGraph()
    await waitFor(() => expect(edges()).toHaveLength(1))
  })

  it('picks up another note s new link on window focus', async () => {
    await openApp()
    await openTheGraph()
    await waitFor(() => expect(nodes().length).toBeGreaterThan(0))
    expect(edges()).toHaveLength(0)

    // Edited in Finder, by a sync, by another window.
    disk.write('/v/inbox.md', '# Inbox\n\nSee [Roadmap](roadmap.md)\n')
    fireEvent(window, new Event('focus'))

    await waitFor(() => expect(edges()).toHaveLength(1))
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault, vaultFile as file } from './fakeVault'
import { buildNoteGraph } from '../graph'
import type { NoteGraph } from '../graph'
import { buildNoteIndex } from '../links'
import { renderToStaticMarkup } from 'react-dom/server'
import { GraphView, decluttered, shortName } from '../GraphView'

/**
 * The note graph's view: the glide, the pane swap, and the click that opens
 * a note. The model and layouts are in `graph.test.ts`. The bugs here:
 * - a glide that never ends, or outlives the pane;
 * - a click that sets the active file instead of reading it;
 * - the open note's unsaved text missing from the graph;
 * - `NaN` from a box jsdom never laid out.
 *
 * jsdom has no `matchMedia` or `ResizeObserver`, so both are stubbed and the
 * component guards for them. It does have a real `requestAnimationFrame` on
 * a ~16ms timer, so frame tests replace it with a queue driven by hand, and
 * App tests stub `prefers-reduced-motion: reduce`. Nothing is laid out, so
 * there are no geometry assertions, only that the numbers are numbers.
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

/** A queue of frames the test advances itself, in place of jsdom's real one. */
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
    /** Frames waiting to run. Zero means the loop stopped. */
    get pending() {
      return queue.size
    },
    /** Every frame ever asked for. Zero means no animation. */
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

/**
 * The one media query `GraphView` asks, with no listener; the
 * component only adds one if it can.
 */
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


/** A graph from `path -> text`, through the real builder and the real index. */
function graphOf(notes: Record<string, string>): NoteGraph {
  const files = Object.keys(notes).map(file)
  return buildNoteGraph(
    files.map((note) => ({ note, text: notes[note.path] })),
    buildNoteIndex(files)
  )
}

/** Five notes in a ring: a picture with somewhere to glide to. */
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
// Still, and gliding when it changes
// ---------------------------------------------------------------------------

/** Every kind of connection shown, as the graph opens. */
const ALL = { text: true, property: true, tag: true }

/**
 * The graph is still. It was a live simulation, and the swirl was the
 * complaint; now the picture is laid out before it is drawn, and a change
 * glides for a fixed time and stops. The clock is moved by hand here.
 */
describe('the graph’s motion', () => {
  const later = (ms: number) => vi.spyOn(performance, 'now').mockReturnValue(performance.now() + ms)
  afterEach(() => vi.restoreAllMocks())

  it('draws the first picture where it is, asking for no frame', () => {
    const frames = installFrames()
    try {
      stubReducedMotion(false)
      render(<GraphView graph={CHAIN} loading={false} currentId={null} shows={ALL} onShows={() => {}} onSelect={() => {}} />)
      expect(nodes()).toHaveLength(5)
      expect(frames.requests).toBe(0)
    } finally {
      frames.restore()
    }
  })

  it('glides to a changed picture, and stops asking for frames when it is there', () => {
    const frames = installFrames()
    try {
      stubReducedMotion(false)
      const props = { loading: false, currentId: 'pingbird', shows: ALL, onShows: () => {}, onSelect: () => {} }
      const { rerender } = render(<GraphView graph={CHAIN} {...props} />)
      rerender(<GraphView graph={CHAIN} {...props} currentId="tinbeacon" />)
      expect(frames.pending).toBeGreaterThan(0)
      later(1000)
      frames.step()
      expect(frames.pending).toBe(0)
    } finally {
      frames.restore()
    }
  })

  it('holds still when the graph is rebuilt the same, as typing beside it does', () => {
    const frames = installFrames()
    try {
      stubReducedMotion(false)
      const props = { loading: false, currentId: null, shows: ALL, onShows: () => {}, onSelect: () => {} }
      const { rerender } = render(<GraphView graph={CHAIN} {...props} />)
      rerender(<GraphView graph={{ ...CHAIN }} {...props} />)
      expect(frames.requests).toBe(0)
    } finally {
      frames.restore()
    }
  })

  it('asks for no frames at all under prefers-reduced-motion', () => {
    const frames = installFrames()
    try {
      stubReducedMotion(true)
      const props = { loading: false, shows: ALL, onShows: () => {}, onSelect: () => {} }
      const { rerender } = render(<GraphView graph={CHAIN} currentId="pingbird" {...props} />)
      rerender(<GraphView graph={CHAIN} currentId="tinbeacon" {...props} />)
      expect(frames.requests).toBe(0)
    } finally {
      frames.restore()
    }
  })

  it('cancels the frame it is holding when the pane closes', () => {
    const frames = installFrames()
    try {
      stubReducedMotion(false)
      const props = { loading: false, shows: ALL, onShows: () => {}, onSelect: () => {} }
      const { rerender, unmount } = render(<GraphView graph={CHAIN} currentId="pingbird" {...props} />)
      rerender(<GraphView graph={CHAIN} currentId="tinbeacon" {...props} />)
      unmount()
      expect(frames.pending).toBe(0)
      expect(frames.cancelled.length).toBeGreaterThan(0)
    } finally {
      frames.restore()
    }
  })
})

/**
 * Around this note, or everything, and what counts as a connection.
 * The graph opens on the open note, what it touches and what those
 * touch; the rest is one press away. Three checkboxes choose the
 * connections, and a note left with none is counted, not drawn.
 */
describe('what the graph shows', () => {
  const TWO = graphOf({
    'pingbird.md': 'See [Moonhatch](moonhatch.md)',
    'moonhatch.md': 'See [Quillfeather](quillfeather.md)',
    'quillfeather.md': '',
    'tinbeacon.md': 'See [Saltcadence](saltcadence.md)',
    'saltcadence.md': '',
    'lonely.md': '',
  })
  const drawnNames = () => nodes().map((one) => one.closest('g')!.getAttribute('aria-label')).sort()

  it('opens around the open note, and shows everything on a press', () => {
    stubReducedMotion(true)
    render(<GraphView graph={TWO} loading={false} currentId="pingbird" shows={ALL} onShows={() => {}} onSelect={() => {}} />)
    expect(drawnNames()).toEqual(['moonhatch', 'pingbird', 'quillfeather'])
    fireEvent.click(screen.getByRole('button', { name: 'Everything' }))
    expect(drawnNames()).toEqual(['moonhatch', 'pingbird', 'quillfeather', 'saltcadence', 'tinbeacon'])
  })

  it('counts the notes connected to nothing, and lists them to open', () => {
    stubReducedMotion(true)
    const opened: string[] = []
    render(<GraphView graph={TWO} loading={false} currentId={null} shows={ALL} onShows={() => {}} onSelect={(node) => opened.push(node.id)} />)
    expect(drawnNames()).not.toContain('lonely')
    fireEvent.click(screen.getByRole('button', { name: '1 unconnected note' }))
    fireEvent.click(within(screen.getByLabelText('Unconnected notes')).getByText('lonely'))
    expect(opened).toEqual(['lonely'])
  })

  it('says which connections count, one checkbox each', () => {
    stubReducedMotion(true)
    const shows: unknown[] = []
    render(<GraphView graph={TWO} loading={false} currentId={null} shows={ALL} onShows={(next) => shows.push(next)} onSelect={() => {}} />)
    fireEvent.click(screen.getByLabelText('Links in properties'))
    expect(shows).toEqual([{ text: true, property: false, tag: true }])
  })
})

/**
 * Clusters, named. In Everything, notes that link among themselves form a
 * region named for the busiest. Days and tags, which touch every group,
 * sit small between them, and their lines stay quiet until hovered.
 */
describe('the graph’s clusters', () => {
  const texts: Record<string, string> = {
    'Harbour Bistro.md': '[[Espresso]] and [[Lemon Tart]] #place',
    'Espresso.md': '[[Lemon Tart]]',
    'Lemon Tart.md': '',
    'Daily/2026-09-21.md': '[[Harbour Bistro]] for an [[Espresso]] and a [[Lemon Tart]] #expense',
  }
  const files = Object.keys(texts).map(file)
  const GROUP = buildNoteGraph(
    files.map((note) => ({ note, text: texts[note.path] })),
    buildNoteIndex(files),
    [],
    { dailyFolder: 'Daily' }
  )
  const props = { graph: GROUP, loading: false, shows: ALL, onShows: () => {}, onSelect: () => {} }
  const regions = () => [...document.querySelectorAll('.graph-region')].map((one) => one.textContent)
  const circleOf = (name: string) => screen.getByRole('button', { name }).querySelector('circle')!

  it('draws a group named for its busiest note: a disc in everything, a sector around a note', () => {
    stubReducedMotion(true)
    const shape = () => [...document.querySelectorAll('.graph-region > :first-child')].map((one) => one.tagName)
    const { rerender } = render(<GraphView {...props} currentId={null} />)
    expect([regions(), shape()]).toEqual([['Harbour Bistro'], ['circle']])
    rerender(<GraphView {...props} currentId="harbour bistro" />)
    expect([regions(), shape()]).toEqual([['Harbour Bistro'], ['path']])
  })

  it('draws a day small and its lines quiet, whatever it touches', () => {
    stubReducedMotion(true)
    render(<GraphView {...props} currentId={null} />)
    expect(Number(circleOf('2026-09-21').getAttribute('r'))).toBeLessThan(Number(circleOf('Harbour Bistro').getAttribute('r')))
    const opacities = edges().map((one) => one.getAttribute('opacity'))
    // Three links among the notes; the day's three and the two tags' are quiet.
    expect(opacities.filter((one) => one === '1')).toHaveLength(3)
    expect(opacities.filter((one) => one !== '1')).toHaveLength(5)
  })

  it('names a region’s hub once, by the region', () => {
    stubReducedMotion(true)
    render(<GraphView {...props} currentId={null} />)
    expect(regions()).toEqual(['Harbour Bistro'])
    expect(circleOf('Harbour Bistro').parentElement!.querySelector('text')).toBeNull()
    expect(circleOf('Espresso').parentElement!.querySelector('text')!.textContent).toBe('Espresso')
  })

  it('names no day at rest, unless it is the open note', () => {
    const at = new Map([['daily/2026-09-21', { x: 0, y: 0 }], ['lemon tart', { x: 500, y: 0 }]])
    expect(decluttered(GROUP, at, 1, null)).toEqual(new Set(['lemon tart']))
    expect(decluttered(GROUP, at, 1, 'daily/2026-09-21')).toEqual(new Set(['daily/2026-09-21', 'lemon tart']))
  })

  it('names a note before a busier tag where only one name fits', () => {
    const graph = graphOf({ 'a.md': '#busy [[b]]', 'b.md': '#busy', 'c.md': '#busy' })
    const at = new Map([['tag:busy', { x: 0, y: 0 }], ['b', { x: 0, y: 0 }]])
    expect(decluttered(graph, at, 1, null)).toEqual(new Set(['b']))
  })
})

/**
 * A long name is cut: a label shows the words that fit at rest
 * and the whole name under the pointer.
 */
describe('the graph’s long names', () => {
  it('keeps a short name whole, and cuts a long one at a word', () => {
    expect(shortName('Harbour Bistro')).toBe('Harbour Bistro')
    expect(shortName('Harbour Bistro and the Long Terrace by the Sea')).toBe('Harbour Bistro and the…')
    expect(shortName('Lakeside Terminal - Departures Hall')).toBe('Lakeside Terminal…')
    expect(shortName('Northwind-quarterly-planning-notes')).toBe('Northwind-quarterly-pla…')
  })

  it('names a node in full when it is pointed at', () => {
    stubReducedMotion(true)
    const graph = graphOf({ 'Harbour Bistro and the Long Terrace by the Sea.md': '[[Espresso]]', 'Espresso.md': '' })
    render(<GraphView graph={graph} loading={false} currentId={null} shows={ALL} onShows={() => {}} onSelect={() => {}} />)
    const long = screen.getByRole('button', { name: 'Harbour Bistro and the Long Terrace by the Sea' })
    expect(long.textContent).toBe('Harbour Bistro and the…')
    fireEvent.pointerEnter(long)
    expect(long.textContent).toBe('Harbour Bistro and the Long Terrace by the Sea')
  })
})

describe('the graph in a box with no size', () => {
  it('writes finite coordinates from a 0x0 box', () => {
    stubReducedMotion(true)
    // jsdom lays nothing out, so this *is* the 0x0 case.
    render(<GraphView graph={CHAIN} loading={false} currentId={null} shows={ALL} onShows={() => {}} onSelect={() => {}} />)
    expect(coordinates().every((value) => Number.isFinite(Number(value)))).toBe(true)
    expect(document.querySelector('.graph-canvas')!.outerHTML).not.toMatch(/NaN/)
  })

  it('writes finite coordinates from a box that measures NaN', () => {
    stubReducedMotion(true)
    const real = Element.prototype.getBoundingClientRect
    // A rect a real engine can return mid-transition. The fit's
    // guards are about zero spans, not an unmeasurable box.
    Element.prototype.getBoundingClientRect = function () {
      return { width: NaN, height: NaN, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 } as DOMRect
    }
    try {
      render(<GraphView graph={CHAIN} loading={false} currentId={null} shows={ALL} onShows={() => {}} onSelect={() => {}} />)
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
 * The view once squeezed the picture into the pane every frame, with
 * every label on and no way to move, so any graph past a handful of
 * notes was a knot. Tested here: naming on hover, the pointer moving
 * the view, and a drag that arranges a node instead of opening it.
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

  /** Hovering a node names it and everything it touches, and dims the rest. */
  it('names the hovered node and its neighbours, and dims the rest', () => {
    stubReducedMotion(true)
    render(<GraphView graph={HUB} loading={false} currentId={null} shows={ALL} onShows={() => {}} onSelect={() => {}} />)

    fireEvent.pointerEnter(groupFor('spoke'))
    expect(labelled()).toEqual(['hub', 'spoke'])
    // A node not touching the hovered one is still drawn and clickable, only faded.
    expect(groupFor('rim').getAttribute('opacity')).toBe('0.12')
    expect(groupFor('hub').getAttribute('opacity')).toBe('1')

    // Leaving puts everything back.
    fireEvent.pointerLeave(groupFor('spoke'))
    expect(groupFor('rim').getAttribute('opacity')).toBe('1')
  })

  /** An edge is lit from either end. */
  it('lights an edge from either of its ends', () => {
    stubReducedMotion(true)
    render(<GraphView graph={HUB} loading={false} currentId={null} shows={ALL} onShows={() => {}} onSelect={() => {}} />)
    fireEvent.pointerEnter(groupFor('spoke'))
    const faded = edges().filter((one) => one.getAttribute('opacity') !== '1')
    // Two edges leave the hub; hovering one spoke keeps its own
    // lit and dims the other, so exactly one fades.
    expect(faded).toHaveLength(1)
  })

  /**
   * A drag arranges a node; it does not open it. The browser sends a click after any
   * press and release on one element, so the click after a moved gesture is
   * swallowed. Selection stays on `click`, keeping the keyboard and assistive paths.
   */
  it('opens a node on a press that stayed put, and not on one that moved', () => {
    stubReducedMotion(true)
    const opened: string[] = []
    render(
      <GraphView
        graph={HUB}
        loading={false}
        currentId={null}
        shows={ALL}
        onShows={() => {}}
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

  /** The keyboard still opens one, which is why selection stays on a click. */
  it('opens a node from the keyboard', () => {
    stubReducedMotion(true)
    const opened: string[] = []
    render(
      <GraphView
        graph={HUB}
        loading={false}
        currentId={null}
        shows={ALL}
        onShows={() => {}}
        onSelect={(node) => opened.push(node.id)}
      />
    )
    fireEvent.keyDown(groupFor('rim'), { key: 'Enter' })
    expect(opened).toEqual(['rim'])
  })
})

/**
 * What is named when nothing is hovered. Deciding labels by zoom left
 * 108 nodes with no labels at the fit zoom. Deciding by collision
 * names what fits: 76 of 108 at the fit, 104 at 1.5×, all at 3×.
 */
describe('naming the graph at rest', () => {
  const at = (positions: Record<string, [number, number]>) =>
    new Map(Object.entries(positions).map(([id, [x, y]]) => [id, { x, y }]))

  /**
   * Two nodes on one spot: one name fits, and it is the hub's,
   * since the hub orients you.
   */
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
    // Far enough apart to have room of their own.
    expect(shown.has('rim')).toBe(true)
    expect(shown.has('lonely')).toBe(true)
  })

  /**
   * The open note is placed first whatever its degree, so it never loses a collision.
   */
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

  /**
   * Zooming spreads the nodes so more names fit, which is why
   * labels go by collision, not a threshold.
   */
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

  /**
   * A node with no position yet (the frame before the layout) is
   * skipped, not named at the origin.
   */
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
        shows={ALL}
        onShows={() => {}}
        onSelect={(node) => selected.push(`${node.id} exists=${node.exists}`)}
      />
    )
    // The renderer draws it differently and passes the decision
    // up; what a click does is App's, tested below.
    expect(document.querySelector('.graph-node.missing')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('moonhatch (no note yet)'))
    expect(selected).toEqual(['moonhatch exists=false'])
  })

  it('marks the open note and nothing else', () => {
    stubReducedMotion(true)
    render(
      <GraphView graph={CHAIN} loading={false} currentId="quillfeather" shows={ALL} onShows={() => {}} onSelect={() => {}} />
    )
    expect(document.querySelectorAll('.graph-node.current')).toHaveLength(1)
    expect(screen.getByLabelText('quillfeather').querySelector('.current')).toBeTruthy()
  })

  /**
   * Frame zero must come from the render, not the effect that drives
   * frames: an effect commits a paint late, and the canvas appeared
   * empty first. A server render runs `useMemo` but no effects, which
   * shows exactly that. Its only symptom was a flaky test further down.
   */
  it('has its nodes in the very first render, before any effect', () => {
    stubReducedMotion(true)
    const markup = renderToStaticMarkup(
      <GraphView graph={CHAIN} loading={false} currentId={null} shows={ALL} onShows={() => {}} onSelect={() => {}} />
    )
    expect(markup).toContain('graph-canvas')
    expect(markup.match(/graph-node/g) ?? []).toHaveLength(CHAIN.nodeCount)
    expect(markup).not.toMatch(/NaN/)
  })

  it('says it is reading rather than saying there is nothing', () => {
    stubReducedMotion(true)
    render(<GraphView graph={null} loading currentId={null} shows={ALL} onShows={() => {}} onSelect={() => {}} />)
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
    // No glide here: these test wiring, and jsdom's real
    // `requestAnimationFrame` would run frames outside `act`.
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
    // The bar is there either way: with no links, no node is
    // drawn, since an unconnected note is counted.
    await waitFor(() => expect(document.querySelector('.graph-bar')).toBeTruthy())
  }

  it('replaces the editor and leaves the tree standing', async () => {
    await openApp()
    await openTheNote('roadmap')
    await openTheGraph()

    expect(screen.queryByTestId('editor')).toBeNull()
    expect(row('roadmap')).toBeTruthy()
    // And the icon closes it.
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

    // The bytes, in both files. Switching the active file before reading
    // leaves the editor holding roadmap's text, and this key saves it into
    // inbox with roadmap untouched, so checking one file would not show it.
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

    // Still the graph, no editor, and no note made on disk.
    expect(document.querySelector('.graph-view')).toBeTruthy()
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(disk.has('/v/quillfeather.md')).toBe(false)
  })

  it('carries a link that autosave has not written yet', async () => {
    await openApp()
    await openTheNote('roadmap')
    type('# Roadmap\n\nNext up: [Inbox](inbox.md)\n')

    // Not waiting: the link exists only in the editor, the state this feature
    // is about. `buffer.body` is the mount value, so it lacks it too.
    expect(disk.read('/v/roadmap.md')).not.toContain('inbox.md')

    await openTheGraph()
    await waitFor(() => expect(edges()).toHaveLength(1))
  })

  it('picks up another note s new link on window focus', async () => {
    await openApp()
    await openTheGraph()
    expect(edges()).toHaveLength(0)

    // Edited in Finder, by a sync, or another window.
    disk.write('/v/inbox.md', '# Inbox\n\nSee [Roadmap](roadmap.md)\n')
    fireEvent(window, new Event('focus'))

    await waitFor(() => expect(edges()).toHaveLength(1))
  })
})

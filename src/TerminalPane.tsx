import { DEFAULT_SETTINGS } from './settings'
import { useEffect, useRef, useState } from 'react'
import { Terminal, type FontWeight } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ensureTmuxConfig } from './vault'
import '@xterm/xterm/css/xterm.css'
import {
  ANSI,
  killTerminal,
  onTerminalExit,
  onTerminalOutput,
  resizeTerminal,
  spawnTerminal,
  writeTerminal,
} from './terminal'

/**
 * **The one mono face both the canvas and the DOM agree on.** xterm measures a cell
 * with a canvas and draws the glyphs with CSS, and the two resolve a font stack
 * differently: CSS reads `ui-monospace` as SF Mono, the canvas does not know the
 * keyword and falls through to Menlo — so the cells were Menlo-wide and the glyphs
 * SF-Mono-narrow, and every line sat in a grid too loose for it. Reported as the
 * font and formatting being off. So the stack is walked for the first *named*
 * family the canvas can render (measured against a serif fallback, since
 * `monospace` *is* Menlo here and would hide it), and that one name is handed to
 * xterm for both. Menlo is what a stock Mac lands on — Terminal.app's own face.
 */
function monoFace(stack: string): string {
  const canvas = document.createElement('canvas').getContext('2d')
  if (!canvas) return 'monospace'
  const width = (font: string) => {
    canvas.font = `13px ${font}`
    return canvas.measureText('mmmmmmmmmm iiiiiiiiii').width
  }
  const fallback = width('serif')
  for (const raw of stack.split(',')) {
    const family = raw.trim().replace(/^['"]|['"]$/g, '')
    // A keyword is not a name the canvas can be asked about.
    if (!family || /^(ui-monospace|monospace|serif|sans-serif|system-ui)$/.test(family)) continue
    if (Math.abs(width(`'${family}', serif`) - fallback) > 0.01) return family
  }
  return 'monospace'
}

/**
 * The terminal's look, read off the page. xterm paints to a canvas and cannot see
 * a CSS token, so the tokens are read here from the element the terminal sits in —
 * the pane's own computed ground, text tiers, accent, face and size — and handed
 * over as its theme. Read at mount and again when the scheme changes, so the
 * terminal is the page's colours and never a black box in it. The ANSI hues a
 * program names come from `ANSI`, see there.
 */
function themeFrom(el: HTMLElement) {
  const root = getComputedStyle(document.documentElement)
  const token = (name: string) => root.getPropertyValue(name).trim()
  const own = getComputedStyle(el)
  const dark = document.documentElement.getAttribute('data-theme') !== 'light'
  // With nothing laid out — a test — the default reading size.
  const size = parseFloat(own.fontSize) || DEFAULT_SETTINGS.proseSize
  /**
   * A token, or a mix of one, as the `rgb()` xterm needs. The sheet's rule is that
   * every colour is a token or a mix of one — a literal is right in one palette of
   * twenty — and xterm takes strings, not `var()`. So the value is set on a hidden
   * probe inside the pane and read back resolved, which is also what makes it
   * follow the scheme: the probe resolves against this element's own tokens.
   */
  const resolve = (value: string) => {
    const probe = document.createElement('span')
    probe.style.cssText = `position:absolute;visibility:hidden;color:${value}`
    el.appendChild(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  }
  return {
    font: {
      family: monoFace(token('--font-mono')),
      size,
      // Read off the pane, which states a terminal's own leading of 1 — see the
      // sheet for why a paragraph's leading is what a grid cannot have.
      lineHeight: (parseFloat(own.lineHeight) || size) / size,
      weight: (own.fontWeight || 'normal') as FontWeight,
      // The sheet's own strong weight: a canvas cannot read a token, so it is read here.
      bold: (token('--fw-strong') || 'bold') as FontWeight,
    },
    theme: {
      background: own.backgroundColor,
      foreground: own.color,
      cursor: own.color,
      cursorAccent: own.backgroundColor,
      selectionBackground: token('--bg-active'),
      /**
       * **Without these there is no scrollbar at all.** xterm 6 scrolls with its own
       * element (`.xterm-scrollable-element`, VS Code's), whose slider is drawn only
       * when the theme names a colour — the class sits at `invisible scrollbar
       * vertical fade` otherwise, which is a terminal you can scroll and cannot see
       * scrolling. Measured: `visible.scrollbar.vertical`, 14 wide, the moment this
       * is set. A wash of the text tone rather than a flat token, because the slider
       * lies *over* the output.
       */
      scrollbarSliderBackground: resolve('color-mix(in srgb, var(--text) 16%, transparent)'),
      scrollbarSliderHoverBackground: resolve('color-mix(in srgb, var(--text) 28%, transparent)'),
      scrollbarSliderActiveBackground: resolve('color-mix(in srgb, var(--accent) 60%, transparent)'),
      black: token('--bg-hover'),
      brightBlack: token('--text-faint'),
      ...ANSI[dark ? 'dark' : 'light'],
    },
  }
}

/** Lines of output the pane keeps to scroll back through. tmux keeps its own for a
 *  session that is reattached; this is what the window holds. */
const SCROLLBACK_LINES = 5000

/** Counts mounts, for each one's own channel — see `TerminalPane`. */
let mounts = 0

/**
 * One Terminal tab: the user's own login shell in the vault folder, and whatever is
 * typed into it. A shell that exits on its own says so and restarts on Enter rather
 * than looping on a shell that cannot start.
 *
 * **The pane attaches to a session; it does not own one.** With tmux there, the
 * session is the tmux server's and outlives both this pane and the window — so
 * mounting *reattaches* to whatever is running under `session` and unmounting
 * detaches. A session is open in exactly one tab: `terminalName` hands out a name
 * no open tab is showing, and `tabKey` will not open a second tab on one.
 *
 * **The events and commands go by the mount's own `id`**, not the session's name.
 * The spawn runs off the main thread, so a tab closed while it is under way sends
 * its detach first, for nothing yet; the spawn then lands and is detached as it
 * arrives — and by id, so that late detach cannot reach a newer tab on the session.
 */
export function TerminalPane({ session, cwd }: { session: string; cwd: string }) {
  const container = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  /** Null until the first spawn answers. False is the one case worth saying. */
  const [persists, setPersists] = useState<boolean | null>(null)

  useEffect(() => {
    const el = container.current
    if (!el) return
    // The *pane* carries the type and the ground; this box is the unpadded one
    // xterm measures itself in — see the return below.
    const look = themeFrom(el.parentElement ?? el)
    let disposed = false
    const id = `${session}-${++mounts}`
    const terminal = new Terminal({
      fontFamily: look.font.family,
      fontSize: look.font.size,
      lineHeight: look.font.lineHeight,
      fontWeight: look.font.weight,
      fontWeightBold: look.font.bold,
      letterSpacing: 0,
      /**
       * Box-drawing and block characters drawn by xterm to fill the cell rather
       * than taken from the font, so a border is a continuous line. **The default
       * is already true and it does nothing here** — it is documented as not
       * working with the DOM renderer, which is what runs with no WebGL or canvas
       * addon loaded. Stated anyway, because it is the thing that would make a
       * leading above 1 safe, and the next person to reach for one should find the
       * reason it is not already on.
       */
      customGlyphs: true,
      theme: look.theme,
      // The note's caret: a bar, two pixels, blinking — not a block.
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(el)
    fit.fit()
    // **And again once the face has been measured.** `FitAddon` divides the box by
    // the cell, and the cell is the font's: measured before the face is ready it
    // came out narrower and fitted one row too many. Measured at 13/1.4 in a 356px
    // box — 19 rows, 361px, the last clipped — against 18 after.
    void document.fonts?.ready.then(() => {
      if (!disposed) fit.fit()
    })
    term.current = terminal

    let exited = false
    let unlistenOutput: (() => void) | undefined
    let unlistenExit: (() => void) | undefined

    // The config has to be on disk before the server reads it, and the server
    // starts with the first session — so this is on the way in, every time, and
    // declines when the vault already has one.
    const start = () =>
      ensureTmuxConfig(cwd)
        .catch(() => {})
        .then(() => spawnTerminal(id, session, cwd, terminal.cols, terminal.rows))
        .then((persistent) => {
          if (disposed) return void killTerminal(id).catch(() => {})
          exited = false
          setPersists(persistent)
        })
        .catch((err: unknown) => terminal.writeln(`Could not start a shell: ${String(err)}`))
    void start()

    // `disposed` is re-read on arrival, not captured: a tab closed right after it
    // mounts runs the cleanup while these are in flight, and a listener stored
    // then would stay registered for the window's life.
    void onTerminalOutput(id, (chunk) => {
      if (!disposed) terminal.write(chunk)
    }).then((fn) => (disposed ? fn() : (unlistenOutput = fn)))
    void onTerminalExit(id, () => {
      if (disposed) return
      exited = true
      terminal.writeln('\r\n[the shell exited — press Enter for a new one]')
    }).then((fn) => (disposed ? fn() : (unlistenExit = fn)))

    const typing = terminal.onData((data) => {
      if (exited) {
        if (data === '\r' || data === '\n') void start()
        return
      }
      writeTerminal(id, data).catch(() => {})
    })

    // The pane's box follows the split it is in; the grid follows the box.
    const resized = new ResizeObserver(() => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      fit.fit()
      resizeTerminal(id, terminal.cols, terminal.rows).catch(() => {})
    })
    resized.observe(el)

    // The scheme changing repaints the page; the terminal repaints with it.
    const themed = new MutationObserver(() => {
      const next = themeFrom(el)
      terminal.options.theme = next.theme
      terminal.options.fontFamily = next.font.family
      terminal.options.fontSize = next.font.size
      terminal.options.lineHeight = next.font.lineHeight
      terminal.options.fontWeight = next.font.weight
      fit.fit()
    })
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme', 'style'] })

    terminal.focus()
    return () => {
      disposed = true
      resized.disconnect()
      themed.disconnect()
      typing.dispose()
      unlistenOutput?.()
      unlistenExit?.()
      term.current = null
      terminal.dispose()
      killTerminal(id).catch(() => {})
    }
  }, [session, cwd])

  /**
   * **The pane pads; the box xterm opens into does not.** `FitAddon` divides the
   * *parent's* computed height by the cell, and with `box-sizing: border-box` that
   * height includes the padding — so a padded host fitted a row that had nowhere to
   * go and clipped it. Measured: 19 rows in a box with 356px inside it, 18 through
   * this wrapper.
   */
  return (
    <div className="terminal-pane" onMouseDown={() => term.current?.focus()}>
      {/* **A fallback says so.** Without tmux the shell is this app's own child and
          dies with the window, which is what every session used to do — and an
          operation that quietly does less than it says is this project's most
          repeated bug. One line, only when it is true. */}
      {persists === false && (
        <p className="terminal-note">
          tmux was not found, so this session ends when the app closes. Install it to
          keep sessions running.
        </p>
      )}
      <div className="terminal-screen" ref={container} />
    </div>
  )
}

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
 * The one mono face the canvas and the page agree on.
 *
 * xterm measures cells with a canvas and draws glyphs with CSS. CSS reads
 * `ui-monospace` as SF Mono; the canvas does not know it and falls back to Menlo.
 * The cells were Menlo-wide and the glyphs narrower, so lines sat in a loose grid.
 *
 * So the stack is walked for the first named family the canvas can
 * draw (tested against a serif, since `monospace` is Menlo here),
 * and that one name goes to xterm. A stock Mac lands on Menlo.
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
 * The terminal's colours, face and size, read off the page. xterm draws to a canvas
 * and cannot read CSS tokens, so they are read here from the pane and passed as its
 * theme. Read at mount and when the scheme changes. The ANSI colours come from `ANSI`.
 */
function themeFrom(el: HTMLElement) {
  const root = getComputedStyle(document.documentElement)
  const token = (name: string) => root.getPropertyValue(name).trim()
  const own = getComputedStyle(el)
  const dark = document.documentElement.getAttribute('data-theme') !== 'light'
  // With nothing laid out (a test), the default reading size.
  const size = parseFloat(own.fontSize) || DEFAULT_SETTINGS.proseSize
  /**
   * A token, or a mix of one, as the `rgb()` xterm needs. Set on a hidden
   * probe inside the pane and read back, so it follows the scheme.
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
      // Read off the pane, which sets a terminal's own leading of 1.
      lineHeight: (parseFloat(own.lineHeight) || size) / size,
      weight: (own.fontWeight || 'normal') as FontWeight,
      // The sheet's strong weight, read here because a canvas cannot read a token.
      bold: (token('--fw-strong') || 'bold') as FontWeight,
    },
    theme: {
      background: own.backgroundColor,
      foreground: own.color,
      cursor: own.color,
      cursorAccent: own.backgroundColor,
      selectionBackground: token('--bg-active'),
      /**
       * Without these there is no scrollbar. xterm 6 scrolls its own element
       * (`.xterm-scrollable-element`), whose slider is drawn only when the theme gives
       * it a colour. A wash of the text colour, since the slider lies over the output.
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

/** Lines of output the pane keeps. tmux keeps its own for a reattached session. */
const SCROLLBACK_LINES = 5000

/** Counts mounts, for each one's own channel; see `TerminalPane`. */
let mounts = 0

/**
 * One terminal tab: the owner's login shell in the vault folder.
 * A shell that exits says so and restarts on Enter.
 *
 * The pane attaches to a session; it does not own one. tmux holds the
 * session, so it outlives the pane and the window: mounting
 * reattaches and unmounting detaches. `terminalName` hands out a name
 * no open tab shows, and `tabKey` will not open a second tab on one.
 *
 * Events and commands go by the mount's own `id`, not the session name. The
 * spawn runs off the main thread, so a tab closed before it lands is detached
 * on arrival, and by id, so it cannot reach a newer tab on the same session.
 */
export function TerminalPane({ session, cwd, shown = true }: { session: string; cwd: string; shown?: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  /** Null until the first spawn answers. False is the one case worth saying. */
  const [persists, setPersists] = useState<boolean | null>(null)

  useEffect(() => {
    const el = container.current
    if (!el) return
    // The pane has the type and the ground; this box is the
    // unpadded one xterm measures (see the return below).
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
       * xterm draws box and block characters itself so borders join. It
       * is already on and has no effect with the DOM renderer; stated
       * so the next person sees why a leading above 1 is not safe.
       */
      customGlyphs: true,
      theme: look.theme,
      // The note's caret: a two-pixel blinking bar, not a block.
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
    // Fit again once the face is measured. `FitAddon` divides the box by the
    // cell, and measured before the face was ready it fitted one row too many.
    void document.fonts?.ready.then(() => {
      if (!disposed) fit.fit()
    })
    term.current = terminal

    let exited = false
    let unlistenOutput: (() => void) | undefined
    let unlistenExit: (() => void) | undefined

    // The config must be on disk before the tmux server starts with the first session,
    // so it is written on the way in. Skipped when the vault already has one.
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

    // `disposed` is read on arrival, not captured: a tab closed
    // right after mount runs its cleanup while these are in flight,
    // and a listener stored then would stay for the window's life.
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

    // The pane's box follows its split; the grid follows the box.
    const resized = new ResizeObserver(() => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      fit.fit()
      resizeTerminal(id, terminal.cols, terminal.rows).catch(() => {})
    })
    resized.observe(el)

    // A scheme change repaints the page; the terminal repaints with it.
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

  // Shown again, it takes the keyboard, as a note's editor does: only the first mount
  // and a press inside it did, so keys typed after a tab switch went to the note.
  // After the press that switched tabs, which would otherwise take the focus back.
  useEffect(() => {
    if (!shown) return
    const later = setTimeout(() => term.current?.focus())
    return () => clearTimeout(later)
  }, [shown])

  /**
   * The pane pads; the box xterm opens in does not. `FitAddon`
   * divides the parent's height, padding included, by the cell,
   * so a padded box fitted a row too many and clipped it.
   */
  return (
    <div className="terminal-pane" onMouseDown={() => term.current?.focus()}>
      {/* Say when it falls back. Without tmux the shell is the app's
          own child and dies with the window. One line, only when true. */}
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

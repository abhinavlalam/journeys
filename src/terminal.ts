// The bridge to a terminal tab's shell: five app commands and two events. Its
// own file, like `reveal.ts`, so a test mocks a few lines instead of a PTY.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * Start or reattach to a session. `id` is the pane mount's, for events
 * and later commands; `name` is the tmux session's, so it is the same
 * session next launch. Returns whether the session outlives the window:
 * false when tmux is missing and the shell is the app's own child.
 */
export function spawnTerminal(
  id: string,
  name: string,
  cwd: string,
  cols: number,
  rows: number
): Promise<boolean> {
  return invoke('spawn_terminal', { id, name, cwd, cols, rows })
}

export function writeTerminal(id: string, data: string): Promise<void> {
  return invoke('write_terminal', { id, data })
}

export function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return invoke('resize_terminal', { id, cols, rows })
}

/** Detach: the tab goes, the session stays. See `kill_terminal`. */
export function killTerminal(id: string): Promise<void> {
  return invoke('kill_terminal', { id })
}

/**
 * Ends the session on its vault's own tmux server; each vault
 * has one, named from its path.
 */
export function endTerminal(name: string, cwd: string): Promise<void> {
  return invoke('end_terminal', { name, cwd })
}

export function onTerminalOutput(id: string, callback: (chunk: string) => void): Promise<UnlistenFn> {
  return listen<string>(`terminal-output-${id}`, (event) => callback(event.payload))
}

/** Fires when the shell exits on its own, not when the tab closes it. */
export function onTerminalExit(id: string, callback: () => void): Promise<UnlistenFn> {
  return listen(`terminal-exit-${id}`, () => callback())
}

/**
 * The sixteen ANSI colours a shell and its programs use, per mode. Not
 * tokens: a program asks for red and green and means them. The ground,
 * text, cursor and selection are the scheme's tokens (`TerminalPane`).
 * Every slot differs from the ground: `claude`'s menu marks its row
 * with an ANSI background, and a black equal to the ground hid it.
 */
export const ANSI = {
  dark: {
    red: '#e88b8b', green: '#6ed39a', yellow: '#e8c07a', blue: '#79b8f0',
    magenta: '#c9a2f0', cyan: '#5fd3c3', white: '#c9cfcd',
    brightRed: '#ffa8a8', brightGreen: '#96e6b8', brightYellow: '#f5d79a', brightBlue: '#a2d0f7',
    brightMagenta: '#ddbcf7', brightCyan: '#8de6d8', brightWhite: '#ffffff',
  },
  light: {
    red: '#b3261e', green: '#1e7a46', yellow: '#946200', blue: '#1f5fd0',
    magenta: '#7a3fb5', cyan: '#0f7c86', white: '#5c5c66',
    brightRed: '#d63c33', brightGreen: '#2a9a5b', brightYellow: '#b07a10', brightBlue: '#3b7be0',
    brightMagenta: '#9358cc', brightCyan: '#1f97a3', brightWhite: '#2a2a30',
  },
} as const

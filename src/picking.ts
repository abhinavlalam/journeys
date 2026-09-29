// A set of rows in the left pane, picked to act on together.
//
// Picking is not opening: ⌘-click adds a row and ⇧-click adds a range, and
// neither opens a note. A plain click opens the note and makes it the whole set.
//
// Pure. A range runs in `visibleFiles` order, the order the tree draws, so it
// covers what is on screen between the two clicks and nothing in a shut folder.

export interface Picked {
  paths: ReadonlySet<string>
  /** The row a range starts from: the last one picked by hand. */
  anchor: string | null
}

export const nothingPicked: Picked = { paths: new Set(), anchor: null }

export type PickMode = 'only' | 'toggle' | 'range'

/**
 * Which gesture a click is. `mod` is `metaKey` on every platform, as in `shortcuts.ts`.
 */
export function pickMode(event: { metaKey: boolean; shiftKey: boolean }): PickMode {
  if (event.metaKey) return 'toggle'
  if (event.shiftKey) return 'range'
  return 'only'
}

export function pick(
  current: Picked,
  path: string,
  mode: PickMode,
  order: readonly string[]
): Picked {
  if (mode === 'only') return { paths: new Set([path]), anchor: path }
  if (mode === 'toggle') {
    const paths = new Set(current.paths)
    if (paths.has(path)) paths.delete(path)
    else paths.add(path)
    // The anchor moves to the row just picked. Un-picking the
    // anchor clears it, so the next ⇧-click starts there.
    return { paths, anchor: paths.has(path) ? path : null }
  }
  // A range replaces the set, as in a file manager.
  const from = order.indexOf(current.anchor ?? path)
  const to = order.indexOf(path)
  // A row not in the order (its folder was shut since) makes a range of one row.
  if (from === -1 || to === -1) return { paths: new Set([path]), anchor: path }
  const [start, end] = from <= to ? [from, to] : [to, from]
  return { paths: new Set(order.slice(start, end + 1)), anchor: current.anchor ?? path }
}

/**
 * The set without a deleted note, or anything under a deleted
 * folder. Every delete goes through here.
 */
export function withoutUnder(current: Picked, prefix: string): Picked {
  const gone = (path: string) => path === prefix || path.startsWith(`${prefix}/`)
  if (![...current.paths].some(gone)) return current
  const paths = new Set([...current.paths].filter((path) => !gone(path)))
  return { paths, anchor: current.anchor && gone(current.anchor) ? null : current.anchor }
}

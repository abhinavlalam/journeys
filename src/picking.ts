// **A set of rows in the left pane, picked to act on together.**
//
// Picking is not opening: ⌘-click adds a row to the set and ⇧-click takes a range,
// and neither shows a note — twenty notes picked to delete would otherwise be
// twenty tabs. A plain click is unchanged: it opens the note and makes it the whole
// set, so the ordinary gesture has no mode to leave.
//
// Pure, and the model is the whole feature: which rows are picked, and which row a
// range is measured from. `links.ts`'s `visibleFiles` is the order a range runs in
// — the order the tree draws, so a range covers what the eye sees between the two
// clicks and nothing inside a folder that is shut.

export interface Picked {
  paths: ReadonlySet<string>
  /** The row a range is measured from: the last one picked by hand. */
  anchor: string | null
}

export const nothingPicked: Picked = { paths: new Set(), anchor: null }

export type PickMode = 'only' | 'toggle' | 'range'

/** Which gesture a click is. **`mod` is `metaKey` on every platform** — the rule
 *  `shortcuts.ts` already states, so there is no platform switch here either. */
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
    // The anchor follows the hand: a range after this runs from the row just
    // picked. Un-picking the anchor leaves none, so the next ⇧-click starts here.
    return { paths, anchor: paths.has(path) ? path : null }
  }
  // A range replaces the set, as it does in a file manager: ⇧-click means "from
  // there to here", and there is nothing else it could mean about the rows between.
  const from = order.indexOf(current.anchor ?? path)
  const to = order.indexOf(path)
  // A row the order does not know — a folder shut under it since the anchor was
  // picked — is a range with one end missing, which is one row.
  if (from === -1 || to === -1) return { paths: new Set([path]), anchor: path }
  const [start, end] = from <= to ? [from, to] : [to, from]
  return { paths: new Set(order.slice(start, end + 1)), anchor: current.anchor ?? path }
}

/** The set without a deleted note, or without everything under a deleted folder —
 *  the one place a pick is dropped, so every delete path is covered by it. */
export function withoutUnder(current: Picked, prefix: string): Picked {
  const gone = (path: string) => path === prefix || path.startsWith(`${prefix}/`)
  if (![...current.paths].some(gone)) return current
  const paths = new Set([...current.paths].filter((path) => !gone(path)))
  return { paths, anchor: current.anchor && gone(current.anchor) ? null : current.anchor }
}

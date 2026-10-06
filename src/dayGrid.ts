// A day as a grid where height is time, as a calendar draws a day: each entry a box
// as tall as it lasted, entries that clash side by side, and quiet stretches folded.
// Pure: the timeline draws what this places. Lengths are in `em`, the day's own size.

import type { TimelineEntry } from './timeline'

/** An hour's height. A moment's slot, a third of it, is one line of text. */
export const HOUR_EM = 4.8
/** What a moment, or anything shorter, takes on the grid, in minutes, so it can be read. */
const MOMENT = 20
/** A stretch with nothing in it longer than this folds to a band, in minutes. */
const QUIET = 60
/** A folded stretch's band. */
export const QUIET_EM = 1.6

export interface Placed {
  entry: TimelineEntry
  /** From the grid's top, and how tall. */
  top: number
  height: number
  /** Which of its cluster's columns it is in, and how many the cluster needs. */
  column: number
  columns: number
}

export interface DayGrid {
  placed: Placed[]
  /** Each whole hour drawn, by its minutes into the day. */
  hours: { top: number; minutes: number }[]
  /** Each folded stretch, by how long it was. */
  quiet: { top: number; minutes: number }[]
  height: number
}

/** A run of the axis drawn to scale, between folds: whole hours, `from` to `to`. */
interface Run {
  from: number
  to: number
  top: number
}

/**
 * Places a day's entries. A run of entries is drawn to scale from its first whole
 * hour to its last; a gap of more than an hour between runs folds to a band. In
 * a run, entries that overlap (each held open for at least a moment's slot) form a
 * cluster and share its width: each takes the first column free when it starts.
 */
export function dayGrid(entries: readonly TimelineEntry[]): DayGrid {
  const spans = entries
    .map((entry) => ({ entry, from: entry.start, to: Math.max(entry.end ?? entry.start, entry.start + MOMENT) }))
    .sort((a, b) => a.from - b.from || b.to - a.to)
  if (spans.length === 0) return { placed: [], hours: [], quiet: [], height: 0 }

  // The axis: runs of whole hours, folded where nothing happens for more than an hour.
  const runs: Run[] = []
  for (const span of spans) {
    const from = Math.floor(span.from / 60) * 60
    const to = Math.ceil(span.to / 60) * 60
    const last = runs[runs.length - 1]
    if (last && from - last.to <= QUIET) last.to = Math.max(last.to, to)
    else runs.push({ from, to, top: 0 })
  }
  const quiet: DayGrid['quiet'] = []
  let height = 0
  runs.forEach((run, at) => {
    if (at > 0) {
      quiet.push({ top: height, minutes: run.from - runs[at - 1].to })
      height += QUIET_EM
    }
    run.top = height
    height += ((run.to - run.from) / 60) * HOUR_EM
  })
  const y = (minute: number) => {
    const run = runs.find((one) => minute >= one.from && minute <= one.to) ?? runs[runs.length - 1]
    return run.top + ((minute - run.from) / 60) * HOUR_EM
  }
  const hours = runs.flatMap((run) =>
    Array.from({ length: (run.to - run.from) / 60 + 1 }, (_, n) => ({ top: y(run.from + n * 60), minutes: run.from + n * 60 }))
  )

  // Clusters of clashing entries, each laid into the first free column.
  const placed: Placed[] = []
  let cluster: Placed[] = []
  let clusterEnd = -Infinity
  let columnEnds: number[] = []
  const close = () => {
    for (const one of cluster) one.columns = columnEnds.length
    cluster = []
    columnEnds = []
  }
  for (const span of spans) {
    if (span.from >= clusterEnd) close()
    let column = columnEnds.findIndex((end) => end <= span.from)
    if (column === -1) column = columnEnds.push(span.to) - 1
    else columnEnds[column] = span.to
    clusterEnd = Math.max(clusterEnd, span.to)
    const one = { entry: span.entry, top: y(span.from), height: y(span.to) - y(span.from), column, columns: 1 }
    cluster.push(one)
    placed.push(one)
  }
  close()
  return { placed, hours, quiet, height }
}

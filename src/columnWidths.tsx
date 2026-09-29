import { useCallback, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'

/** Narrow enough to be on purpose, wide enough to still grab the handle. */
const MIN_WIDTH = 44

/**
 * Resizable columns for the property and tag tables, which share one markup.
 *
 * Auto until the first drag, then fixed. The first grab measures every column
 * and fixes it at its width, so only the dragged one moves. Widths are per table
 * on screen and not saved; a saved width would go stale as the notes change.
 *
 * `table-layout: fixed` makes a width hold; under `auto` the
 * column grows back to its content.
 */
export function useColumnWidths(table: RefObject<HTMLTableElement | null>): {
  /** Null until the first drag: the table sizes itself. */
  widths: Readonly<Record<string, number>> | null
  /** The grip for a column, drawn inside its `th`. */
  gripFor: (key: string) => ReactNode
} {
  const [widths, setWidths] = useState<Record<string, number> | null>(null)
  const drag = useRef<{ key: string; startX: number; from: Record<string, number> } | null>(null)

  const begin = useCallback(
    (key: string, startX: number) => {
      // Pin every column at its current width, so dragging one does not
      // reflow the others. Widths already dragged win over the measurement.
      const measured: Record<string, number> = {}
      const heads = table.current?.querySelectorAll<HTMLTableCellElement>('th[data-col]')
      for (const head of heads ?? []) {
        const col = head.dataset.col
        if (col) measured[col] = head.getBoundingClientRect().width
      }
      const from = { ...measured, ...(widths ?? {}) }
      drag.current = { key, startX, from }
      setWidths(from)

      // On the window, so a drag that leaves the 44px grip still finishes.
      const onMove = (event: PointerEvent) => {
        const active = drag.current
        if (!active) return
        const was = active.from[active.key] ?? MIN_WIDTH
        const next = Math.max(MIN_WIDTH, was + (event.clientX - active.startX))
        setWidths({ ...active.from, [active.key]: next })
      }
      const onUp = () => {
        drag.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [table, widths]
  )

  const gripFor = (key: string): ReactNode => (
    <span
      className="column-grip"
      role="separator"
      aria-label={`Resize ${key}`}
      aria-orientation="vertical"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        // Or the press selects the header's text.
        event.preventDefault()
        event.stopPropagation()
        begin(key, event.clientX)
      }}
    />
  )

  return { widths, gripFor }
}

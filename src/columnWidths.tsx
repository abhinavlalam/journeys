import { useCallback, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'

/** Narrow enough to be a deliberate act, wide enough to still grab the handle. */
const MIN_WIDTH = 44

/**
 * Resizable columns for the tables a collection, a property and a tag draw.
 *
 * **One hook, because it is one table in three places.** `CollectionTable` and
 * `PropertyView` already share the markup and the classes — "the same object", as
 * the sheet puts it — so a grip written into one of them would be the fourth copy
 * of a row this app has spent effort keeping to one.
 *
 * **Auto until the first drag, then fixed.** The natural widths are what a table
 * should open at: `readFields` is partial, so a column's content is whatever the
 * notes happen to say, and a set of guessed widths would be wrong for every
 * collection. The first grab therefore *measures* every column and freezes it at
 * what it already had — so the one being dragged is the only thing that moves, and
 * the table does not jump under the pointer as the browser re-flows the rest. That
 * is also why the widths are per mounted table and not saved: they belong to the
 * page in front of you, and a stored width would be a number to go stale against a
 * vault whose notes have changed underneath it.
 *
 * `table-layout: fixed` is what makes a width *hold*; under `auto` the browser
 * treats one as a suggestion and grows the column back to its content.
 */
export function useColumnWidths(table: RefObject<HTMLTableElement | null>): {
  /** Null until the first drag: the table is sizing itself. */
  widths: Readonly<Record<string, number>> | null
  /** The grip for a column, to render inside its `th`. */
  gripFor: (key: string) => ReactNode
} {
  const [widths, setWidths] = useState<Record<string, number> | null>(null)
  const drag = useRef<{ key: string; startX: number; from: Record<string, number> } | null>(null)

  const begin = useCallback(
    (key: string, startX: number) => {
      // Every column pinned at the width it has right now, so dragging one does not
      // re-flow its neighbours. Whatever has already been dragged wins over the
      // measurement, since that is the number the user chose.
      const measured: Record<string, number> = {}
      const heads = table.current?.querySelectorAll<HTMLTableCellElement>('th[data-col]')
      for (const head of heads ?? []) {
        const col = head.dataset.col
        if (col) measured[col] = head.getBoundingClientRect().width
      }
      const from = { ...measured, ...(widths ?? {}) }
      drag.current = { key, startX, from }
      setWidths(from)

      // On the window, because a drag that outruns a 44px grip still has to finish.
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
        // Or the press selects the header's text on the way past.
        event.preventDefault()
        event.stopPropagation()
        begin(key, event.clientX)
      }}
    />
  )

  return { widths, gripFor }
}

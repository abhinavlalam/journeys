import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface ContextMenuItem {
  label: string
  /** Drawn before the label. A slot rather than widening `label` to a node, because
      `label` is also this row's React key and a node cannot be one. */
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  /** Marked as the one in force. Only the grid draws this. */
  selected?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  /**
   * Icons, laid out as a grid above the rows, showing no labels.
   *
   * Sixty-three icons as sixty-three rows is a menu taller than the window, and
   * every row would be a word doing an icon's job. In the grid the label is the
   * tooltip and the accessible name instead. Still one popup rather than a second
   * component, so the clamp, the Escape key and the click-away cannot drift.
   */
  grid?: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, grid, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ top: y, left: x })

  // Measured after mount and pulled back inside the window: right-clicking a note
  // near the bottom of the sidebar put Delete off-screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 8
    setAt({
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    })
  }, [x, y])

  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div className="context-menu" style={{ top: at.top, left: at.left }} ref={ref}>
      {grid && grid.length > 0 && (
        <div className="context-menu-grid">
          {grid.map((item) => (
            <button
              key={item.label}
              className={item.selected ? 'selected' : ''}
              aria-label={item.label}
              title={item.label}
              onClick={() => {
                onClose()
                item.onSelect()
              }}
            >
              {item.icon}
            </button>
          ))}
        </div>
      )}
      {items.map((item) => (
        <button
          key={item.label}
          className={item.danger ? 'danger' : ''}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}

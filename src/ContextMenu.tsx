import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface ContextMenuItem {
  label: string
  /**
   * Drawn before the label. A separate slot because `label` is
   * also the row's React key.
   */
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  /** Marked as the current one. Only the grid draws this. */
  selected?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  /**
   * Icons in a grid above the rows, without labels. Sixty-three icons as rows
   * would be taller than the window; in the grid the label is the tooltip and
   * accessible name. Still one popup, sharing the clamp, Escape and click-away.
   */
  grid?: ContextMenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, grid, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ top: y, left: x })

  // Measured after mount and moved inside the window: a
  // right-click near the sidebar's bottom put Delete off-screen.
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

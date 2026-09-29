import { useState, type ReactNode } from 'react'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

/**
 * A right-click menu: the position, the `preventDefault`, and the
 * node. `[node, open]` rather than a component, since each tree row
 * draws the node inside itself. `items` and `grid` are functions,
 * so they are built when the menu opens, not on every row's render.
 */
export function useContextMenu(
  items: () => ContextMenuItem[],
  grid?: () => ContextMenuItem[]
): [ReactNode, (e: React.MouseEvent) => void] {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)

  const menu = at && (
    <ContextMenu
      x={at.x}
      y={at.y}
      onClose={() => setAt(null)}
      items={items()}
      grid={grid?.()}
    />
  )

  return [
    menu,
    (e) => {
      e.preventDefault()
      setAt({ x: e.clientX, y: e.clientY })
    },
  ]
}

import { useState, type ReactNode } from 'react'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

/**
 * A right-click menu: the position state, the `preventDefault`, and the node.
 *
 * `[node, open]` rather than a component, because the caller renders the node
 * inside its own row — every row in the tree holds one, and each was otherwise a
 * hand-rolled `useState<{x,y}|null>` plus the same conditional block, which is
 * several places for the clamp, the Escape key and the click-away to drift apart.
 *
 * `items` is a function so it is evaluated when the menu opens rather than on
 * every render of a row that has no menu showing. `grid` is the same, and for the
 * same reason twice over: it is sixty-three icons, built per row in the tree.
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

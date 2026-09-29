import type { HTMLAttributes, ReactNode } from 'react'
import { GroupRow, guideAt } from './rows'

/**
 * One folding section of the left pane (Notes, Actions, Applications): a
 * heading row, its controls on the heading shown on hover, and its rows
 * one step in. The heading is the tree's own `GroupRow`, and the controls
 * sit in its `folder-actions`, so the sheet's one hover rule covers them.
 *
 * `children` are `li`s, so the tree, the Actions groups and the
 * Applications rows share one grid.
 */
export function SidebarSection({
  name,
  open,
  onToggle,
  actions,
  list,
  children,
}: {
  name: string
  open: boolean
  onToggle: () => void
  /** The section's controls, shown on hover: search, collapse, expand, `+`. */
  actions?: ReactNode
  /** On the list itself: the tree's root drop target and its `drag-over` wash. */
  list?: HTMLAttributes<HTMLUListElement>
  children?: ReactNode
}) {
  return (
    <section className="pane-section">
      <GroupRow
        name={name}
        open={open}
        onToggle={onToggle}
        actions={
          actions && (
            // A press on a control opens a shut section first; a shut section
            // draws nothing, so a search opened in one could not be seen.
            <span className="folder-actions" onClickCapture={() => !open && onToggle()}>
              {actions}
            </span>
          )
        }
      />
      {open && (
        <ul
          {...list}
          className={`file-list folder-children ${list?.className ?? ''}`}
          style={guideAt(0)}
        >
          {children}
        </ul>
      )}
    </section>
  )
}

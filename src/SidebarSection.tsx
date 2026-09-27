import type { HTMLAttributes, ReactNode } from 'react'
import { GroupRow, guideAt } from './rows'

/**
 * One collapsible section of the left pane — Notes, Actions, Applications — as
 * the editors the owner named draw theirs: a heading row that opens and shuts,
 * **its controls on the heading and shown on hover**, and its rows one step in
 * under it. The heading is the tree's own `GroupRow`, so the chevron, the name and
 * the guide under it are the ones every other group has; the controls sit in the
 * row's `folder-actions`, the slot a folder's `+` already appears from on hover,
 * so the sheet's one reveal rule covers four buttons as it covered one.
 *
 * `children` are `li`s: the tree, the Actions groups and the Applications rows are
 * all rows in this section's list, which is what puts them on the tree's grid.
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
  /** The section's own controls, revealed on hover: search, collapse, expand, `+`. */
  actions?: ReactNode
  /** On the list itself — the tree's root drop target, and its `drag-over` wash. */
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
            // **A press opens a shut section first**: its controls open a field or
            // rows inside it, and a shut section draws none — a search opened there
            // was a search nobody could see.
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

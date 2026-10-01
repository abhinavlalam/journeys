// The reading pane's header: what is open, whether it is saved, and for
// a note its name as a field. The note and `.config/settings.json`
// share it; the settings file adds a Save button in a slot.

import { useEffect, useState, type ReactNode } from 'react'
import { NameField } from './rows'

/**
 * `status` is a word: "Saving…", "Saved", or nothing once a save is old. The
 * caller decides, since a note saves as you type and the settings file on request.
 *
 * The name is the rename, when the caller passes one. The title field and
 * the tree's row share `NameField` and, through `App`, the same handler.
 */
export function ViewerHeader({
  name,
  status,
  onRename,
  children,
  shown = true,
}: {
  name: string
  status?: string
  /**
   * Renames what is open. Absent for anything that is not a
   * note, where the title is only a label.
   */
  onRename?: (name: string) => void
  /** Controls for the open file, at the right of the row. */
  children?: ReactNode
  /** On screen. A note's tab stays mounted while hidden, and its field with it. */
  shown?: boolean
}) {
  /** What is typed, and the name the field was opened for; see `commit`. */
  const [editing, setEditing] = useState<{ was: string; typed: string } | null>(null)

  /**
   * Commits on Enter and on blur, as the tree's rename does: it
   * names something that already has a name. Escape abandons.
   *
   * It renames the note it was opened for, or nothing. With the field
   * open, ⌘⇧O opened the daily note, the field blurred, and the daily
   * note got the name meant for the other note. So the opening name
   * is kept, and a commit whose note has changed is dropped.
   *
   * Hidden, it renames nothing: a field whose pane goes is
   * abandoned. An empty or unchanged name is not a rename.
   */
  const commit = () => {
    const open = editing
    setEditing(null)
    if (!open || open.was !== name || !shown) return
    const wanted = open.typed.trim()
    if (wanted && wanted !== name) onRename?.(wanted)
  }

  useEffect(() => {
    if (!shown) setEditing(null)
  }, [shown])

  return (
    <div className="viewer-header">
      {editing && onRename ? (
        <NameField
          value={editing.typed}
          ariaLabel="Note name"
          // The caret at the end, not the name selected: the title spans the header,
          // and a stray click and a key would rename the note and every link to it.
          selectOnFocus={false}
          // `was` stays the name it opened with: reset on each key, a note that
          // changed underneath before the typing was renamed after all.
          onChange={(typed) => setEditing((open) => open && { ...open, typed })}
          onSubmit={commit}
          onBlur={commit}
          onCancel={() => setEditing(null)}
        />
      ) : (
        // A `<button>`, since it starts an edit and takes the
        // keyboard. The header is a window-drag region, and the sheet
        // opts this out, or pressing the title moves the window.
        <button
          className="viewer-title"
          onClick={() => onRename && setEditing({ was: name, typed: name })}
          disabled={!onRename}
          title={onRename ? 'Rename' : undefined}
        >
          {name}
        </button>
      )}
      {children ? (
        <span className="json-header-actions">
          <span className="save-status">{status}</span>
          {children}
        </span>
      ) : (
        <span className="save-status">{status}</span>
      )}
    </div>
  )
}

// The reading pane's header: what is open, whether it is written, and — for a note
// — its name, which is a field.
//
// **Two panes drew this**, the note's and `.config/settings.json`'s, with the same
// two boxes and the same classes — and the second grew a Save button, which is the
// only difference and is a slot.

import { useState, type ReactNode } from 'react'
import { NameField } from './rows'

/**
 * `status` is a word and not a state machine: "Saving…", "Saved", or nothing at
 * all once a save is old enough to stop mattering. The caller works out which,
 * because what counts as saved differs — a note is written as you type and the
 * settings file is written when you ask.
 *
 * **The name is the rename**, when the caller passes one. A note's title is the
 * one place its name is already written large; typing over it is the shortest
 * thing that could mean "call it something else", and it is the same act as the
 * tree's rename — the tree's own row and this share `NameField` and, through
 * `App`, the same handler.
 */
export function ViewerHeader({
  name,
  status,
  onRename,
  children,
}: {
  name: string
  status?: string
  /** Renames what is open. Absent for anything that is not a note — the settings
   *  file, a JSON file — where the title is a label and nothing else. */
  onRename?: (name: string) => void
  /** Anything that acts on the open file, at the right of the row. */
  children?: ReactNode
}) {
  /** What is typed, **and the name the field was opened for** — see `commit`. */
  const [editing, setEditing] = useState<{ was: string; typed: string } | null>(null)

  /**
   * **Commits on blur as well as on Enter**, the way the tree's rename does and
   * unlike a create: this names something that already has a name, so leaving the
   * field is finishing rather than abandoning. Escape abandons.
   *
   * **And it renames the note it was opened for, or nothing.** Reported from the
   * running app: with the field open and typed into, ⌘⇧O opened the daily note —
   * which took the keyboard, which blurred the field, which committed *the name
   * meant for the old note* against the new one. The daily note was renamed and the
   * note being renamed was untouched. So the name the field opened with is kept
   * beside what is typed, and a commit whose note has changed underneath it is
   * abandoned. The same shape as "read the note before switching what is open":
   * anything that acts on the open file has to say which file it meant.
   *
   * Nothing typed, or nothing changed, is not a rename: the vault refuses one to
   * the same name anyway, and asking it to is noise.
   */
  const commit = () => {
    const open = editing
    setEditing(null)
    if (!open || open.was !== name) return
    const wanted = open.typed.trim()
    if (wanted && wanted !== name) onRename?.(wanted)
  }

  return (
    <div className="viewer-header">
      {editing && onRename ? (
        <NameField
          value={editing.typed}
          ariaLabel="Note name"
          // The caret at the end, not the name selected: the title's box is the
          // whole width of the header now, and a stray press followed by a
          // keystroke would otherwise rename the note and every link into it.
          selectOnFocus={false}
          onChange={(typed) => setEditing({ was: name, typed })}
          onSubmit={commit}
          onBlur={commit}
          onCancel={() => setEditing(null)}
        />
      ) : (
        // A `<button>` and not a click on the text: it is the thing that starts an
        // edit, so it takes the keyboard and says so. `-webkit-app-region` on the
        // header makes it a window-drag region, which the sheet opts this out of —
        // without that, pressing the title moves the window instead.
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

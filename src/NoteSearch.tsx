import { NameField } from './rows'
import type { VaultFile } from './vaultModel'
import type { SearchHit } from './search'

interface NoteSearchProps {
  query: string
  /**
   * The matches to list, or **null** when the section filters its own rows.
   *
   * The Notes section answers a query with a list of notes, because a note's text
   * is what was searched and the tree cannot show a hit inside one. The Actions
   * section answers by hiding the rows that do not match, because its rows *are*
   * the names that were searched — so the field is the same field and the results
   * are wherever they belong.
   */
  hits: SearchHit[] | null
  /** What is being searched, for the placeholder and the accessible name: the
   *  Notes section reads a note's *text* and the Actions section its rows' names,
   *  and a field that says "Search notes" over a list of actions is wrong twice. */
  what: string
  onQuery: (query: string) => void
  onOpen: (file: VaultFile) => void
  onClose: () => void
}

/**
 * The search field over the tree, and its results in the tree's place.
 *
 * **The same field a name is typed into** — `NameField`, the one the tree's `+` and
 * the rename use. The two do different things and are the same object on screen: a
 * box that opens where the rows are, takes the keyboard, and closes when you leave
 * it. It had its own input and its own class, and they had already drifted apart.
 *
 * **Not a mode you are left in.** Escape closes it, and so does clicking anything
 * outside it: a field nobody is typing in should not be holding a tree's worth of
 * rows off the screen. Closing clears the query, because a stale one behind a shut
 * field is a tree missing notes for a reason nobody can see.
 *
 * The results **replace** the tree only while something is typed: opening search
 * should not take the vault off the screen, and an empty field is the state you are
 * in for as long as it takes to decide what to look for.
 *
 * The query lives in `App`, not here. The matches are a memo over the one read of
 * the vault, and that read is `App`'s — holding the text here would mean a second
 * copy of it or a callback per keystroke.
 */
export function NoteSearch({ query, hits, what, onQuery, onOpen, onClose }: NoteSearchProps) {
  const typed = query.trim() !== ''
  const first = hits?.[0]
  return (
    <div className="sidebar-search">
      <NameField
        value={query}
        placeholder={`Search ${what}`}
        ariaLabel={`Search ${what}`}
        onChange={onQuery}
        // Enter takes the first match, which is the one the list is offering.
        onSubmit={() => first && onOpen(first.note)}
        onCancel={onClose}
        onBlur={onClose}
      />
      {hits &&
        typed &&
        (hits.length === 0 ? (
          <p className="sidebar-search-empty">No note says that.</p>
        ) : (
          // **`preventDefault` on mousedown**, so a click in here does not move the
          // keyboard out of the field: the field closes on blur, and without this
          // the close raced the click and the note never opened.
          <ul className="sidebar-search-hits" onMouseDown={(event) => event.preventDefault()}>
            {hits.map((hit) => (
              <li key={hit.note.path}>
                <button onClick={() => onOpen(hit.note)}>
                  <span className="sidebar-search-name">{hit.note.name}</span>
                  {hit.line && <span className="sidebar-search-line">{hit.line}</span>}
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  )
}

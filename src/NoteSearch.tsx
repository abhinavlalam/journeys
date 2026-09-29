import { NameField } from './rows'
import type { VaultFile } from './vaultModel'
import type { SearchHit } from './search'

interface NoteSearchProps {
  query: string
  /**
   * The matches to list, or null when the section filters its own rows.
   * Notes lists notes, since their text was searched; Actions hides
   * rows that do not match, since its rows are the names searched.
   */
  hits: SearchHit[] | null
  /**
   * What is searched, for the placeholder and the label: Notes
   * searches text, Actions searches names.
   */
  what: string
  onQuery: (query: string) => void
  onOpen: (file: VaultFile) => void
  onClose: () => void
}

/**
 * The search field over the tree, and its results in the tree's
 * place. The same `NameField` as a new name or a rename.
 *
 * Escape closes it, and so does clicking outside. Closing clears
 * the query, so no stale filter hides notes.
 *
 * The results replace the tree only while something is typed.
 *
 * The query lives in `App`, since the matches are a memo over
 * the one read of the vault.
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
        // Enter opens the first match.
        onSubmit={() => first && onOpen(first.note)}
        onCancel={onClose}
        onBlur={onClose}
      />
      {hits &&
        typed &&
        (hits.length === 0 ? (
          <p className="sidebar-search-empty">No note says that.</p>
        ) : (
          // `preventDefault` on mousedown, so a click keeps the keyboard in the field.
          // The field closes on blur, which raced the click and the note never opened.
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

import { useState, type ReactNode } from 'react'
import { NoteRow } from './rows'
import { ranked, type Openable } from './quickMatch'

/** How many matches are listed: enough to choose from, few enough to read. */
const SHOWN = 12

export interface QuickItem extends Openable {
  icon: ReactNode
  /** Where it is, said quietly beside its name: a note's folder, `page`, `tag`. */
  detail: string
  /** Opens it: `beside` is ⌘↩, a new tab, as ⌘-click is. */
  open: (beside: boolean) => void
}

/**
 * Quick open: a field over the page, and what its words name among notes, pages, tags
 * and tables (`ranked`). ↑ and ↓ choose, ↩ opens in place of the tab in front and ⌘↩
 * beside it, a press opens, and Escape or a press outside closes.
 */
export function QuickOpen({ items, onClose }: { items: readonly QuickItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState(0)
  const shown = ranked(items, query, SHOWN)
  const at = Math.min(chosen, Math.max(shown.length - 1, 0))
  const open = (item: QuickItem | undefined, beside: boolean) => {
    if (!item) return
    onClose()
    item.open(beside)
  }
  return (
    <div className="quick-open" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="quick-open-box" role="dialog" aria-label="Open">
        <input
          className="quick-open-field"
          aria-label="Open"
          placeholder="Open a note, a page, a tag…"
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            setChosen(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            else if (event.key === 'ArrowDown') setChosen(Math.min(at + 1, shown.length - 1))
            else if (event.key === 'ArrowUp') setChosen(Math.max(at - 1, 0))
            else if (event.key === 'Enter') open(shown[at], event.metaKey)
            else return
            event.preventDefault()
          }}
        />
        <ul className="file-list quick-open-list" role="listbox" aria-label="Matches">
          {shown.map((item, n) => (
            <li key={item.key} role="option" aria-selected={n === at}>
              <NoteRow
                icon={item.icon}
                name={item.name}
                className={n === at ? 'selected' : undefined}
                trailing={<span className="row-count">{item.detail}</span>}
                onMouseEnter={() => setChosen(n)}
                onClick={(event) => open(item, event.metaKey)}
              />
            </li>
          ))}
          {shown.length === 0 && <li className="quick-open-none">Nothing by that name.</li>}
        </ul>
      </div>
    </div>
  )
}

// The row, wherever the app lists notes: the tree, the Actions
// pane, and the sections at the end of a note.
//
// One shape and one set of classes, so every name lines up. Three copies of it had
// drifted: one lacked the icon column and its text sat 23px left of the names above.
//
// Behaviour is the caller's. A tree row drags, renames and opens
// a menu; a footer row only opens a note.

import {
  useState,
  type CSSProperties,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import { ChevronIcon, DEFAULT_NOTE_ICON, NoteIcon } from './icons'
import { linkLabelSpan, type VaultFile } from './vaultModel'
import type { CollectedNote } from './useVaultTexts'


/**
 * A depth as a length in the sheet's `--row-step`. A nested row's `paddingLeft`
 * and a folder's `--guide-x` both use it, so the rows and the guide agree.
 */
export const stepIn = (depth: number) => `calc(${depth} * var(--row-step))`

/** Where a list's guide line runs: the indent of the row above the list. */
export const guideAt = (depth: number) => ({ '--guide-x': stepIn(depth) }) as CSSProperties

/** What an empty page row says while the vault is still being read. */
export const READING = 'Reading the vault…'

/**
 * Opens a note from a click on the lines under a row, unless the
 * click ended a text selection.
 */
export function opensNote(open: () => void): void {
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
  if (selection && !selection.isCollapsed) return
  open()
}

/**
 * A name typed in place: a new note, a new action, a rename.
 *
 * Enter commits and Escape abandons. What blur means is the
 * caller's: a rename commits, a create abandons.
 */
export function NameField({
  value,
  placeholder,
  ariaLabel,
  className,
  type,
  onChange,
  onSubmit,
  onCancel,
  onBlur,
  selectOnFocus = true,
}: {
  value: string
  placeholder?: string
  /**
   * `password` for a passphrase. A locked note asks in the same box as everything else.
   */
  type?: 'text' | 'password'
  /** For a field whose placeholder is not its name, like the search box. */
  ariaLabel?: string
  /** `folder-rename-input` for the tree's folder row; other fields take none. */
  className?: string
  /**
   * Whether focus selects the current text, so the first key replaces
   * it. True for a field that stands in for a row. False for the
   * note's title: a stray click and a key there would rename the note
   * and rewrite every link to it, so the caret goes to the end.
   */
  selectOnFocus?: boolean
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  onBlur: () => void
}) {
  return (
    <input
      autoFocus
      type={type ?? 'text'}
      className={className ? `rename-input ${className}` : 'rename-input'}
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={value}
      // Names are typed as meant. macOS changed `with:` to
      // `With:`, and links must spell a name exactly.
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      // Select the whole value so typing replaces it, unless the
      // caller asks for the caret at the end.
      onFocus={(e) =>
        selectOnFocus ? e.target.select() : e.target.setSelectionRange(value.length, value.length)
      }
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit()
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={onBlur}
    />
  )
}

interface NoteRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'name'> {
  /**
   * The icon's box: a picker in the tree, a plain glyph elsewhere, or
   * empty. The column is always there, so every name starts at the same x.
   */
  icon: ReactNode
  /** Text, or text with a mark before it, like a calendar row's clock. */
  name: ReactNode
  /** After the name: a count. */
  trailing?: ReactNode
}

export function NoteRow({ icon, name, trailing, className, ...button }: NoteRowProps) {
  return (
    <button className={className ? `file-row ${className}` : 'file-row'} {...button}>
      {/* The chevron's column, kept even when empty, so a leaf
          lines up with a folder at the same depth. */}
      <span className="folder-chevron" aria-hidden="true" />
      <span className="row-body">
        {icon}
        <span className="row-name">{name}</span>
        {trailing}
      </span>
    </button>
  )
}

/**
 * The icon column for rows without a picker. `icon` is a key from the
 * drawn set; `children` is any other glyph, like braces on a JSON file.
 * With neither, the column is left empty so the name still lines up.
 */
export function RowIcon({ icon, children }: { icon?: string; children?: ReactNode }) {
  return (
    <span className="folder-icon" aria-hidden="true">
      {children ?? (icon && <NoteIcon icon={icon} />)}
    </span>
  )
}

interface GroupRowProps {
  /** The name, and what the chevron's label says it will do. */
  name: string
  open: boolean
  onToggle: () => void
  icon?: ReactNode
  /**
   * After the name, inside the toggle: a count. Only a `<span>`;
   * anything clickable goes in `actions`.
   */
  trailing?: ReactNode
  /**
   * Next to the toggle, outside it: a control for the group, like its `+`. A button
   * cannot hold a button; inside the toggle the browser drew it as its own row.
   */
  actions?: ReactNode
  /**
   * What clicking the name does when the group is also a thing of
   * its own, like a tag with tags under it. The chevron folds.
   */
  onOpen?: () => void
  /**
   * The indent goes on the header, as in the tree. On the `li`
   * it counted again for every row inside.
   */
  depth?: number
}

/**
 * A row that folds what is under it: the chevron, then the name.
 * The tree's folder row has more to do (open, drop, drag, rename);
 * this is the plain one, with the same `folder-header` box.
 */
export function GroupRow({ name, open, onToggle, icon, trailing, actions, onOpen, depth }: GroupRowProps) {
  return (
    <div className="folder-header" style={depth ? { paddingLeft: stepIn(depth) } : undefined}>
      <button
        className="folder-chevron"
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
        onClick={onToggle}
      >
        <ChevronIcon open={open} />
      </button>
      <button className="folder-toggle" onClick={onOpen ?? onToggle}>
        {icon}
        <span className="row-name">{name}</span>
        {trailing}
      </button>
      {actions}
    </div>
  )
}

/**
 * A folding section of rows in the reading pane: a labelled heading and a list
 * under it. The end of a note (Inside, Backlinks) and a tag's page use it.
 *
 * It holds its own open state, starting where the caller says. `App` keys the
 * note footer on the note's path, so a new note starts fresh. Without the
 * key, a section left open on one note stayed open and empty on the next.
 */
export function Section({
  title,
  count,
  startOpen,
  onOpen,
  actions,
  children,
}: {
  title: string
  count: number
  startOpen: boolean
  /**
   * Clicking the heading's name opens what the section is about,
   * like a timeline day's note.
   */
  onOpen?: () => void
  /**
   * Controls on the heading next to the toggle, like a `+` that adds to the section.
   */
  actions?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(startOpen)
  return (
    <section className="note-section">
      <GroupRow
        name={title}
        open={open}
        onToggle={() => setOpen((shown) => !shown)}
        onOpen={onOpen}
        trailing={<span className="row-count">{count}</span>}
        actions={actions && <span className="folder-actions">{actions}</span>}
      />
      {open && (
        <ul className="file-list folder-children" style={guideAt(0)}>
          {children}
        </ul>
      )}
    </section>
  )
}

/**
 * A note's line as the note shows it, for the backlink and tag
 * pages. Links read as their names (`linkLabelSpan`), not their
 * paths. Nothing else is rendered: `**bold**` stays as typed.
 */
export const readable = (text: string) =>
  text.replace(/\[\[([^\]\n]+)\]\]/g, (_, inner: string) => {
    const shown = linkLabelSpan(inner)
    return inner.slice(shown.from, shown.to).trim()
  })

/**
 * The notes a page gathers lines from: a row per note with its lines below.
 *
 * An entry and the lines nested under it are one block, `pre-wrap`
 * keeping the indent. `head` draws the entry, since a page may read
 * it differently (`readBlock`). Clicking the lines opens the note.
 */
export function GatheredNotes({
  notes,
  icons,
  loading,
  onOpen,
  head,
}: {
  /** Null while the vault is still being read. */
  notes: CollectedNote[] | null
  icons: Record<string, string>
  loading: boolean
  onOpen: (file: VaultFile) => void
  head: (line: string) => ReactNode
}) {
  if (!notes?.length) {
    return (
      <li style={{ paddingLeft: stepIn(1) }}>
        <NoteRow
          icon={<RowIcon />}
          name={loading || notes === null ? READING : 'No line carries this yet.'}
          disabled
        />
      </li>
    )
  }
  return notes.map(({ note, lines }) => (
    <li key={note.path} style={{ paddingLeft: stepIn(1) }}>
      <NoteRow
        icon={<RowIcon icon={icons[note.path] ?? DEFAULT_NOTE_ICON} />}
        name={note.name}
        trailing={lines.length > 1 ? <span className="row-count">{lines.length}</span> : undefined}
        onClick={() => onOpen(note)}
      />
      <ul className="collected-lines" onClick={() => opensNote(() => onOpen(note))}>
        {lines.map((line) => (
          <li key={line.at}>
            {head(line.text)}
            {line.below.map((under, at) => (
              <span key={at}>{'\n' + readable(under)}</span>
            ))}
          </li>
        ))}
      </ul>
    </li>
  ))
}

/** `1 line`, `3 lines`, `12 notes`: the count a page shows in its header. */
export const countOf = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

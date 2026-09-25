// The row, wherever the app lists notes.
//
// **Three panes drew this, three times**: the tree, the Actions section, and the
// two sections at the end of a note. The same boxes in the same order — a reserved
// chevron slot, a body holding an icon and a name — and the same classes, because
// the sheet dresses them once. Written out three times they had already begun to
// differ: one had the icon's column and one did not, so a line of text sat 23px
// left of every name above it.
//
// What is *not* here is behaviour. A row in the tree drags, renames in place, takes
// an icon from a picker and opens a menu; a row in a footer opens a note and
// nothing else. Those are the caller's, passed in — this is the shape.

import {
  useState,
  type CSSProperties,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import { ChevronIcon, DEFAULT_NOTE_ICON, NoteIcon } from './icons'
import { linkLabelSpan, type VaultFile } from './vaultModel'
import type { CollectedNote } from './useVaultTexts'


/** A depth as a length, in the sheet's own `--row-step`: what a nested row's
 *  `paddingLeft` and a folder's `--guide-x` are both set to, so the rows and the
 *  guide under them cannot disagree. No number here — the step is the sheet's. */
export const stepIn = (depth: number) => `calc(${depth} * var(--row-step))`

/**
 * Opens a note from a click on the **lines** under a row, unless that click was the
 * end of a selection someone was making.
 *
 * The quoted lines under a backlink, and the lines a collection gathers, are the
 * bulk of what there is to click at, and clicking them did nothing at all. They
 * are still selectable text, so a drag that ends in a click is a selection and not
 * a request to go somewhere.
 */
export function opensNote(open: () => void): void {
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
  if (selection && !selection.isCollapsed) return
  open()
}

/**
 * A name typed in place, wherever a pane asks for one.
 *
 * **Three copies of this existed**: the tree's new-note row, the Actions section's
 * new-action row and the rename field, all the same input with the same class,
 * `autoFocus`, Enter to commit and Escape to abandon. What differs is one thing and
 * it is the caller's: **what leaving the field means.** A rename commits on blur
 * and a create abandons, which is the decision, not the markup — so `onBlur` is
 * passed in rather than chosen here.
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
  /** `password` for a passphrase, which is the same field with the glyphs held
   *  back — an encrypted note asks in the box everything else is typed into. */
  type?: 'text' | 'password'
  /** For a field whose placeholder is not its name — the search box. */
  ariaLabel?: string
  /** `folder-rename-input` is the tree's folder row; every other field takes none. */
  className?: string
  /**
   * Whether focusing selects what is already there, so the first keystroke replaces
   * it. True everywhere a field stands *in place of* a row — you opened it to type
   * a name — and false for the note's title, whose box is now the whole width of
   * the header: a stray press there followed by a keystroke would otherwise rename
   * the note and rewrite every link into it. The caret goes to the end instead.
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
      // Prefilled or empty, the whole value is selected, so typing replaces it —
      // unless the caller says otherwise, and then the caret goes to the end.
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
  /** The icon's box. A picker in the tree, a plain glyph elsewhere, an empty
   *  reservation for a row that names no file — the column is the same either way,
   *  which is what keeps every name in a pane on one x. */
  icon: ReactNode
  /** Text, or text with a mark in front of it — a calendar row's clock. */
  name: ReactNode
  /** After the name: a count, so far. */
  trailing?: ReactNode
}

export function NoteRow({ icon, name, trailing, className, ...button }: NoteRowProps) {
  return (
    <button className={className ? `file-row ${className}` : 'file-row'} {...button}>
      {/* The chevron's column, reserved and empty: a leaf has no chevron and a
          folder at its depth does, and the answer is to reserve the *element*
          rather than compute its width. */}
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
 * The icon's column, for the rows where it is not a picker.
 *
 * `icon` is a key from the drawn set, which is the common case; `children` is for
 * a glyph that is not one of those — braces on a JSON file. Neither, and the
 * column is reserved and empty, which is what keeps a row that names no file from
 * starting its words 23px left of every name above it.
 */
export function RowIcon({ icon, children }: { icon?: string; children?: ReactNode }) {
  return (
    <span className="folder-icon" aria-hidden="true">
      {children ?? (icon && <NoteIcon icon={icon} />)}
    </span>
  )
}

interface GroupRowProps {
  /** The name, and what the chevron's label says it will do to it. */
  name: string
  open: boolean
  onToggle: () => void
  icon?: ReactNode
  /** After the name and **inside** the toggle: a count, so far. A `<span>` only —
   *  see `actions` for anything clickable. */
  trailing?: ReactNode
  /** Beside the toggle and **outside** it: a control that acts on the group, like
   *  the `+` that makes one of its kind. A button cannot contain a button — put
   *  one in `trailing` and the browser draws it as its own row inside the toggle,
   *  which is what a group's `+` looked like for one build. */
  actions?: ReactNode
}

/**
 * A row that opens and shuts what is under it: the chevron, then the name.
 *
 * The tree has its own, because a folder row there is also a note you can open, a
 * drop target, a drag source and a rename field. This is the plain one, for the
 * panes whose groups are only groups — and it is the same `folder-header` box, so
 * the two read as one kind of row.
 */
export function GroupRow({ name, open, onToggle, icon, trailing, actions }: GroupRowProps) {
  return (
    <div className="folder-header">
      <button
        className="folder-chevron"
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
        onClick={onToggle}
      >
        <ChevronIcon open={open} />
      </button>
      <button className="folder-toggle" onClick={onToggle}>
        {icon}
        <span className="row-name">{name}</span>
        {trailing}
      </button>
      {actions}
    </div>
  )
}

/**
 * One collapsible section of rows in the reading pane: the tree's folder row with
 * the app's label on it, and a list of rows under it.
 *
 * **Two panes draw this.** The end of a note has Inside and Backlinks; a
 * collection's view has the line it declares and the lines it collects. They are
 * the same object — a labelled, countable list of the left pane's own rows on the
 * note's column — so this lives beside the rows themselves rather than in either
 * one of them.
 *
 * The open state is this component's own and starts where the caller says. It is
 * not remembered across notes: `App` keys the note footer on the note's path, so a
 * new note is a new footer. Without that key it *was* remembered, and a section
 * left open on a note with backlinks stayed open — and empty — on the next note
 * without any. A test caught it.
 */
export function Section({
  title,
  count,
  startOpen,
  children,
}: {
  title: string
  count: number
  startOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(startOpen)
  return (
    <section className="note-section">
      <GroupRow
        name={title}
        open={open}
        onToggle={() => setOpen((shown) => !shown)}
        trailing={<span className="row-count">{count}</span>}
      />
      {open && (
        <ul className="file-list folder-children" style={{ '--guide-x': '0px' } as CSSProperties}>
          {children}
        </ul>
      )}
    </section>
  )
}

/**
 * A line of a note as the note **reads** it, for the two places that quote one.
 *
 * The lines under a backlink and the lines a collection gathers are quotations, and
 * a quotation showing `[[Entities/Cafes/Bean Street/Lakeside Arrival]]` is showing bytes
 * where the editor shows a sentence — forty-five characters of folders at the end
 * of every note that linked there. Off `linkLabelSpan`, so what a link shows is one
 * answer everywhere: a name, an alias, or the last n names of a `|!n`.
 *
 * Only links. A quotation is not rendered markdown — a `**bold**` run stays as it
 * was written, because the line is being shown as text and not re-typeset.
 */
export const readable = (text: string) =>
  text.replace(/\[\[([^\]\n]+)\]\]/g, (_, inner: string) => {
    const shown = linkLabelSpan(inner)
    return inner.slice(shown.from, shown.to).trim()
  })

/**
 * The notes a page gathers lines from, a row per note with its lines beneath — which
 * a collection's Lines section and a tag's page both are. They were written out
 * twice and had already drifted: the tag page read a `[[link]]` in a line nested
 * under an entry as its name, and the collection page showed that line's bytes.
 *
 * An entry and the run under it are **one block**, `pre-wrap` keeping the indent
 * that says which line is under which. `head` draws the entry, because a collection
 * hides its own syntax and a tag has none; what is nested under it reads as the
 * note reads. The lines open the note too, since they are what there is to click at.
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
          name={loading || notes === null ? 'Reading the vault…' : 'No line carries this yet.'}
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

/**
 * `1 line`, `3 lines`, `12 notes` — the status word a view page puts in its header.
 *
 * Three copies of this existed, two of them identical: a collection's page and a
 * tag's both counted lines and a property's counted notes. One function, and the
 * noun is the argument.
 */
export const countOf = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

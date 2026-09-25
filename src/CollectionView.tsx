import { useMemo, useState, type ReactNode } from 'react'
import { collectionSyntax, templateFields } from './actions'
import { CollectionTable } from './CollectionTable'
import { ViewerHeader } from './ViewerHeader'
import { countOf, GatheredNotes, NameField, readable, stepIn, Section } from './rows'
import type { CollectedNote } from './useVaultTexts'
import type { VaultFile } from './vaultModel'

/**
 * A collection: the line it declares, and every line in the vault that carries its
 * `--keyword` with whatever is nested under each.
 *
 * **A collection's row is not a file.** It was one — an empty
 * `.config/actions/collections/expense.md`, written the moment the row was clicked
 * — and an empty page named after a thing is not the thing. The file is back, but
 * as the collection's *declaration*: one line saying how its lines are written. The
 * row still opens this view, because what a collection holds is a question asked of
 * the notes.
 *
 * **The backlinks section, one scale up.** Both answer "where in the vault is this
 * written", so both are the same object: a row per note, with the lines underneath.
 * Same `NoteRow`, same `Section`, same guide line, and the same `note-section` box
 * — which is what puts these rows on the note's own column at the note's own size.
 * Without it they came out at the browser's 16px against the viewer's left edge,
 * which is the trap that class's own comment records.
 *
 * Presentational, and given no filesystem — `GraphView`'s arrangement, for the same
 * reason: the lines arrive already gathered, off the one read of the vault, so this
 * file mounts under a test with no disk at all.
 *
 * **A declaration with fields buys a Table section**, above the Lines. `--expense
 * amount::<<>> at merchant:: [[<<>>]]` names two fields, so the lines are read as
 * values and shown in columns — see `CollectionTable` — while Lines keeps the text
 * they were read from.
 *
 * **Switching between them is opening one and shutting the other**, because they
 * are two readings of the same rows and `Section` already opens and shuts. A
 * button that swapped one for the other would be a *mode* — a second thing to be
 * in, and a way to have neither — where this lets you read the values, the
 * sentences, or both. With no fields declared there is no table to offer, so Lines
 * opens as it always did.
 *
 * The lines are **verbatim**, not rendered. A collected line is evidence of what a
 * note says; parsing it here would put a second markdown renderer in the app for
 * the sake of showing bold text in a quotation, and the caret cannot go into it
 * anyway — the row above opens the note, which is where a line is edited.
 */
export function CollectionView({
  keyword,
  collected,
  declaration,
  icons,
  loading,
  onOpen,
  onOpenLink,
  onDeclare,
}: {
  keyword: string
  /** Null while the vault has not been read yet. */
  collected: CollectedNote[] | null
  /** The line this collection declares, or null when it has declared none. */
  declaration: string | null
  /** `icon:` per note path, so a row here wears what its row in the tree wears. */
  icons: Record<string, string>
  loading: boolean
  onOpen: (file: VaultFile) => void
  /** A field declared inside `[[ ]]` holds a note's name, so its cell opens it. */
  onOpenLink: (target: string) => void
  onDeclare: (line: string) => void
}) {
  const notes = collected ?? []
  const total = notes.reduce((count, one) => count + one.lines.length, 0)
  const [editing, setEditing] = useState(false)
  const fields = useMemo(() => (declaration ? templateFields(declaration) : []), [declaration])
  // Nothing to read as values, or nothing to read: no table to offer.
  const table = fields.length > 0 && notes.length > 0
  return (
    <>
      {/* `--expense` and not `expense`: the header names the syntax it gathers, and
          the row in the pane already gave the name. `status` is the pane's one word
          about what is open — a count here, where a file has "Saved". */}
      <ViewerHeader name={`--${keyword}`} status={total > 0 ? countOf(total, 'line') : ''} />
      {/* **The structure comes first**, because it is what the rest of the page is
          lines of. It is what `--expense` completes to in a note, so the page that
          defines the shape and the popup that writes it are one string. */}
      <Section title="Structure" count={declaration ? 1 : 0} startOpen>
        <li className="collection-structure" style={{ paddingLeft: stepIn(1) }}>
          {editing ? (
            <DeclarationField
              start={declaration ?? `--${keyword} `}
              onCommit={(line) => {
                setEditing(false)
                if (line !== declaration) onDeclare(line)
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            // **The structure is shown the way the editor shows it**, not printed:
            // it was a row's *name*, which is one clipped line — the one string the
            // page exists to show, cut off at `using account::<<…` with an ellipsis.
            // A row is for a name; this is a line, so it wraps and it is marked.
            <button className="collection-line" onClick={() => setEditing(true)} title="Edit">
              {declaration ? (
                <CollectionLine line={declaration} syntax="show" />
              ) : (
                <span className="collection-empty">
                  Declare how a --{keyword} line is written…
                </span>
              )}
            </button>
          )}
        </li>
      </Section>
      {table && (
        <Section title="Table" count={total} startOpen>
          {/* A table is not a list of rows, so it sits in one `li` — a card, whose
              own padding is the step in that a row's `paddingLeft` gives. */}
          <li className="collection-table-box">
            <CollectionTable
              fields={fields}
              notes={notes}
              onOpen={onOpen}
              onOpenLink={onOpenLink}
            />
          </li>
        </Section>
      )}
      <Section title="Lines" count={total} startOpen={!table}>
        {/* The entry is **rendered**: nothing on a page can be selected, so the
            editor's bargain — syntax back the moment the caret lands — has no second
            half here, and a quotation full of `::<<>>` would be the note's raw bytes
            shown as if they were what it says. */}
        <GatheredNotes
          notes={collected}
          icons={icons}
          loading={loading}
          onOpen={onOpen}
          head={(line) => <CollectionLine line={line} syntax="hide" declaration={declaration} />}
        />
      </Section>
    </>
  )
}

/**
 * A collection line, with the app's own writing marked.
 *
 * `collectionSyntax` says which spans are the app's — the keyword, each `label::`,
 * the `<<`/`>>` around each value — and the same list serves the editor's
 * decorations, so a line cannot read one way in the note and another on this page.
 *
 * **Two readings, because the two places want opposite things.** The *structure* is
 * the schema, so `show` draws every span, dimmed: seeing `amount::<<>>` is the
 * whole point of declaring it. A *gathered line* is the sentence a note wrote, so
 * `hide` drops them and leaves `09:42 --expense spent EUR 480 at Corner Shop`,
 * which is what that line reads as in the note with the caret elsewhere. The
 * keyword stays marked in both: it is what the line *is*.
 */
/**
 * **What a structure is about is its fields**, so they take the app's one label
 * format — the same `--mark` and weight a property's name, a JSON key and a
 * section's heading take, because a field's label is exactly that kind of word. The
 * connecting prose steps back to match. It was the other way round for a build:
 * `spent`, `at`, `using` were the brightest thing on the line and `currency::` the
 * faintest, which is the schema hiding behind its own scaffolding.
 *
 * A gathered line reads the opposite way — there the prose *is* the sentence — so
 * `prose` only steps back in a structure.
 */
const SPAN: Record<string, string> = {
  keyword: 'collection-keyword',
  label: 'collection-label',
  bracket: 'collection-syntax',
  // Never drawn: a blank is only ever produced with a declaration, and a
  // declaration is only handed over when the syntax hides.
  blank: 'collection-syntax',
}

function CollectionLine({
  line,
  syntax,
  declaration,
}: {
  line: string
  syntax: 'show' | 'hide'
  /** The collection's own, so an empty field hides with its lead-in — a gathered
   *  line reads exactly as the note renders it. Not for the structure, whose every
   *  slot is empty and whose lead-ins are the point. */
  declaration?: string | null
}) {
  const show = syntax === 'show'
  const out: ReactNode[] = []
  let read = 0
  const between = (to: number, key: string) => {
    if (to <= read) return
    const text = line.slice(read, to)
    // A structure's prose steps back so its fields lead; a gathered line's prose
    // *is* the sentence and keeps the note's own colour.
    out.push(
      show ? (
        <span key={key} className="collection-syntax">
          {text}
        </span>
      ) : (
        readable(text)
      )
    )
  }
  collectionSyntax(line, show ? null : declaration).forEach((part, at) => {
    between(part.from, `t${at}`)
    // The keyword is marked in both readings; everything else is the frame, which a
    // structure shows and a quotation drops. `read` moves past it either way.
    if (show || part.kind === 'keyword')
      out.push(
        <span key={at} className={SPAN[part.kind]}>
          {line.slice(part.from, part.to)}
        </span>
      )
    read = part.to
  })
  between(line.length, 'end')
  return <span className="collection-line-text">{out}</span>
}

/**
 * The structure, typed in place.
 *
 * **A structure is a line, so it is typed into the field every other line in this
 * app is typed into** — the box a note is renamed in, a new note is named in and a
 * passphrase is asked for in. Prefilled with what is declared, or with the keyword
 * and a space, so the first thing typed is the structure rather than the name of
 * the thing being structured.
 *
 * **It commits on blur**, as a rename does and unlike a create: this is a change to
 * something that already exists, so leaving the field is finishing rather than
 * abandoning. Escape still abandons.
 */
function DeclarationField({
  start,
  onCommit,
  onCancel,
}: {
  start: string
  onCommit: (line: string) => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState(start)
  // A blank field is not "no structure": removing one is a change to the file, not
  // a field left empty, and this is a field someone may clear before retyping.
  const done = () => (typed.trim() ? onCommit(typed.trim()) : onCancel())
  return (
    <NameField
      value={typed}
      ariaLabel="Line structure"
      onChange={setTyped}
      onSubmit={done}
      onBlur={done}
      onCancel={onCancel}
    />
  )
}


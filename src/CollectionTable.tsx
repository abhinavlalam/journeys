import { useRef } from 'react'
import { leadingClock } from './clock'
import { useColumnWidths } from './columnWidths'
import { readFields, type TemplateField } from './actions'
import type { CollectedNote } from './useVaultTexts'
import { linkLabelSpan, type VaultFile } from './vaultModel'

/** One collected line, read as values. */
interface Row {
  note: VaultFile
  /** The line itself, for the row that opens it and for anyone reading over it. */
  text: string
  when: string | null
  values: Record<string, string>
}

/** Places a column's sum is rounded to — money's, and no more than a sum of
 *  quantities needs. Trailing zeros are not written. */
const SUM_DECIMALS = 2

/**
 * A collection as a table: a row per collected line, a column per field its
 * declaration names.
 *
 * **The declaration is the schema**, so this component adds no idea of its own
 * about what a line contains — `readFields` answers that, and it answers partially
 * on purpose. A blank cell is a line that did not say, which is the ordinary state
 * of a note and not an error to point at.
 *
 * Two columns nobody declares. **`when`** comes free: a journal line opens with a
 * clock and `leadingClock` already reads it, so the table can say when without the
 * template mentioning time. And the note's own name closes every row, because
 * "where is this from" is the question a gathered line raises first.
 *
 * A field declared inside `[[ ]]` makes its cell a **link** — the value is a note's
 * name, so the cell opens it. Which also means "everything at this merchant" is a
 * question the vault's own backlinks already answer.
 *
 * Read-only, deliberately. Editing a cell means writing back into someone's prose
 * through a parse that is allowed to be partial, and that is where an app corrupts
 * a file. The row opens the note instead.
 */
export function CollectionTable({
  fields,
  notes,
  onOpen,
  onOpenLink,
}: {
  fields: readonly TemplateField[]
  notes: readonly CollectedNote[]
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string) => void
}) {
  const rows: Row[] = notes.flatMap(({ note, lines }) =>
    lines.map((line) => ({
      note,
      text: line.text,
      when: leadingClock(line.text),
      values: readFields(line.text, fields),
    }))
  )
  // A column of blanks is a column nobody is using: the declaration may name a
  // field the notes have not started carrying yet, and an empty column is a header
  // that only takes width.
  const shown = fields.filter((field) => rows.some((row) => row.values[field.name]))
  const dated = rows.some((row) => row.when)
  /**
   * **A sum under every column that is numbers**, because a ledger's one question is
   * "how much". 21 expense lines and no way to see the total without reading them
   * was the finding; a read-only table stays read-only, and a footer row is a
   * *reading* of the rows rather than a write into any note. A column counts when
   * at least two of its values parse and none of the non-blank ones fails to — one
   * number is not a total, and a column that is mostly words is not a column of
   * amounts. Commas are thousands separators, which is how people write money.
   */
  const sums = Object.fromEntries(
    shown.flatMap((field) => {
      const given = rows.map((row) => row.values[field.name]).filter(Boolean)
      const numbers = given.map((value) => Number(value.replace(/,/g, '')))
      if (given.length < 2 || numbers.some((one) => !Number.isFinite(one))) return []
      const sum = numbers.reduce((total, one) => total + one, 0)
      return [[field.name, String(Number(sum.toFixed(SUM_DECIMALS)))]]
    })
  ) as Record<string, string>
  const summed = Object.keys(sums).length > 0
  const table = useRef<HTMLTableElement>(null)
  const { widths, gripFor } = useColumnWidths(table)

  return (
    <table className="collection-table" ref={table} data-sized={widths ? '' : undefined}>
      <thead>
        <tr>
          {/* **Where it was written comes first.** A gathered line is a quotation,
              and the first thing you want of a quotation is whose it is — a date,
              here, since these mostly come out of the daily notes. It closed the
              row for a while, which put the one column that is the same for a whole
              run of rows at the far end of the widest table on the page. */}
          <th data-col="note" style={{ width: widths?.note }}>
            note
            {gripFor('note')}
          </th>
          {dated && (
            <th data-col="when" style={{ width: widths?.when }}>
              when
              {gripFor('when')}
            </th>
          )}
          {shown.map((field) => (
            <th key={field.name} data-col={field.name} style={{ width: widths?.[field.name] }}>
              {field.name}
              {gripFor(field.name)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, at) => (
          // The line itself as the row's title: the table is a reading of it, and
          // the reading is partial, so the sentence it came from stays one hover
          // away.
          <tr key={`${row.note.path}:${at}`} title={row.text}>
            <td>
              <button className="collection-source" onClick={() => onOpen(row.note)}>
                {row.note.name}
              </button>
            </td>
            {dated && <td className="collection-when">{row.when ?? ''}</td>}
            {shown.map((field) => (
              <td key={field.name}>
                <Cell value={row.values[field.name]} onOpenLink={onOpenLink} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {summed && (
        <tfoot>
          <tr className="collection-sum">
            <td>sum</td>
            {dated && <td />}
            {shown.map((field) => (
              <td key={field.name}>{sums[field.name] ?? ''}</td>
            ))}
          </tr>
        </tfoot>
      )}
    </table>
  )
}

/**
 * One value.
 *
 * **A link is a link because the value is one**, not because the declaration said
 * so. A slot holds whatever was typed between its brackets, `[[Corner Shop]]`
 * included — so `merchant:: <<[[Corner Shop]]>>` is a link and `merchant:: <<cash>>`
 * is a word, decided by the note rather than by a flag in the schema. The
 * declaration used to carry a `wiki` bit for this, which asked someone to write
 * `[[<<>>]]` and then meant the link's own target was `<<Corner Shop>>`.
 *
 * The **alias** shows where the line gave one — `[[Bistro|the office]]` reads as
 * "the office" and opens `Bistro`, the bargain every link in this app makes. An
 * empty cell is empty: no dash, no placeholder, nothing to read as a value that is
 * not there.
 */
export function Cell({
  value,
  onOpenLink,
}: {
  value: string | undefined
  onOpenLink: (target: string) => void
}) {
  const link = value?.match(/^\[\[([^\]]+)\]\]$/)
  if (!value) return null
  if (!link) return <>{value}</>
  const shown = linkLabelSpan(link[1])
  return (
    <button className="collection-link" onClick={() => onOpenLink(link[1].split('|')[0].trim())}>
      {link[1].slice(shown.from, shown.to).trim()}
    </button>
  )
}

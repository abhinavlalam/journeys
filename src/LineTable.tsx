import { useRef } from 'react'
import { leadingClock } from './clock'
import { useColumnWidths } from './columnWidths'
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
 * Gathered lines as a table: a row per line, a column per property a tag's
 * structure names.
 *
 * **The structure is the schema**, so this component adds no idea of its own about
 * what a line contains — `valuesOf` answers that, and a blank cell is a line that
 * did not say, which is the ordinary state of a note and not an error to point at.
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
export function LineTable({
  columns,
  valuesOf,
  summable,
  notes,
  onOpen,
  onOpenLink,
}: {
  columns: readonly string[]
  /** A line's values, by column. */
  valuesOf: (text: string) => Record<string, string>
  /** Which columns are summed: a tag's `number` properties. */
  summable: (column: string) => boolean
  notes: readonly CollectedNote[]
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string) => void
}) {
  const rows: Row[] = notes.flatMap(({ note, lines }) =>
    lines.map((line) => ({
      note,
      text: line.text,
      when: leadingClock(line.text),
      values: valuesOf(line.text),
    }))
  )
  // A column of blanks is a column nobody is using: the declaration may name a
  // field the notes have not started carrying yet, and an empty column is a header
  // that only takes width.
  const shown = columns.filter((column) => rows.some((row) => row.values[column]))
  const dated = rows.some((row) => row.when)
  /**
   * **A sum under every `number` column**, because a ledger's one question is "how
   * much", and a footer row is a *reading* of the rows rather than a write into any
   * note. A `number` value is exactly a number, so each one parses.
   */
  const sums: Record<string, string> = Object.fromEntries(
    shown.filter(summable).map((column) => {
      const sum = rows.reduce((total, row) => total + (Number(row.values[column]) || 0), 0)
      return [column, String(Number(sum.toFixed(SUM_DECIMALS)))]
    })
  )
  const summed = Object.keys(sums).length > 0
  const table = useRef<HTMLTableElement>(null)
  const { widths, gripFor } = useColumnWidths(table)

  return (
    <table className="line-table" ref={table} data-sized={widths ? '' : undefined}>
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
          {shown.map((column) => (
            <th key={column} data-col={column} style={{ width: widths?.[column] }}>
              {column}
              {gripFor(column)}
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
              <button className="line-source" onClick={() => onOpen(row.note)}>
                {row.note.name}
              </button>
            </td>
            {dated && <td className="line-when">{row.when ?? ''}</td>}
            {shown.map((column) => (
              <td key={column}>
                <Cell value={row.values[column]} onOpenLink={onOpenLink} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {summed && (
        <tfoot>
          <tr className="line-sum">
            <td>sum</td>
            {dated && <td />}
            {shown.map((column) => (
              <td key={column}>{sums[column] ?? ''}</td>
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
 * **A link is a link because the value is one**: `merchant:: [[Lakeside Deli]]` is a
 * link and a text `note:: cash` is a word, decided by the note.
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
    <button className="line-link" onClick={() => onOpenLink(link[1].split('|')[0].trim())}>
      {link[1].slice(shown.from, shown.to).trim()}
    </button>
  )
}

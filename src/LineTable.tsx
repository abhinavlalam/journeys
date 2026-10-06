import { useRef } from 'react'
import { leadingClock } from './clock'
import { useColumnWidths } from './columnWidths'
import { Live } from './Live'
import { numberText } from './properties'
import type { CollectedNote } from './useVaultTexts'
import { linkLabelSpan, type VaultFile } from './vaultModel'

/** One gathered line, read as values. */
interface Row {
  note: VaultFile
  /** The line itself, for the row that opens it and its hover text. */
  text: string
  when: string | null
  /** The line's own words (`lineWords`), when the table shows them. */
  words: string
  values: Record<string, string>
}

/**
 * Gathered lines as a table: a row per line, a column per property in the tag's
 * structure. `valuesOf` reads a line's values; a blank cell is a line that did not say.
 *
 * Three columns come free: the note the line is from, first, `when`, from the line's
 * leading clock, and `what`, the line's own words, read as the note shows them. Each
 * is dropped, as a property's column is, when no line fills it. A `backlink` value is
 * a link and its cell opens the note.
 *
 * Read-only. Editing a cell would write into a note through a partial parse,
 * which is how an app corrupts a file. The row opens the note instead.
 */
export function LineTable({
  columns,
  valuesOf,
  wordsOf,
  summable,
  notes,
  onOpen,
  onOpenLink,
}: {
  columns: readonly string[]
  /** A line's values, by column. */
  valuesOf: (text: string) => Record<string, string>
  /** A line's own words, for the `what` column. */
  wordsOf?: (text: string) => string
  /** Which columns are summed: the tag's `number` properties. */
  summable: (column: string) => boolean
  notes: readonly CollectedNote[]
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string, wiki: boolean) => void
}) {
  const rows: Row[] = notes.flatMap(({ note, lines }) =>
    lines.map((line) => ({
      note,
      text: line.text,
      when: leadingClock(line.text),
      words: wordsOf?.(line.text) ?? '',
      values: valuesOf(line.text),
    }))
  )
  // A column no line fills is dropped: it would be a header taking width.
  const shown = columns.filter((column) => rows.some((row) => row.values[column]))
  const dated = rows.some((row) => row.when)
  const worded = rows.some((row) => row.words)
  /**
   * A sum under every `number` column. A `number` value is
   * exactly a number, so each one parses.
   */
  const sums: Record<string, string> = Object.fromEntries(
    shown.filter(summable).map((column) => {
      const sum = rows.reduce((total, row) => total + (Number(row.values[column]) || 0), 0)
      return [column, numberText(sum)]
    })
  )
  const summed = Object.keys(sums).length > 0
  const table = useRef<HTMLTableElement>(null)
  const { widths, gripFor } = useColumnWidths(table)

  return (
    <table className="line-table" ref={table} data-sized={widths ? '' : undefined}>
      <thead>
        <tr>
          {/* The note comes first: it is the first thing a
              gathered line raises, and mostly a date. */}
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
          {worded && (
            <th data-col="what" style={{ width: widths?.what }}>
              what
              {gripFor('what')}
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
          // The line itself as the row's hover text, since the
          // table shows only part of it.
          <tr key={`${row.note.path}:${at}`} title={row.text}>
            <td>
              <button className="line-source" onClick={() => onOpen(row.note)}>
                {row.note.name}
              </button>
            </td>
            {dated && <td className="line-when">{row.when ?? ''}</td>}
            {worded && (
              <td>
                <Live text={row.words} onOpenLink={onOpenLink} />
              </td>
            )}
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
            {worded && <td />}
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
 * One value. It is a link when the value is one (`merchant::
 * [[Harbour Bistro]]`); `note:: cash` is a word. A link shows its
 * alias where it has one. An empty cell is empty, with no dash.
 */
export function Cell({
  value,
  onOpenLink,
}: {
  value: string | undefined
  onOpenLink: (target: string, wiki: boolean) => void
}) {
  const link = value?.match(/^\[\[([^\]]+)\]\]$/)
  if (!value) return null
  if (!link) return <>{value}</>
  const shown = linkLabelSpan(link[1])
  return (
    <button className="line-link" onClick={() => onOpenLink(link[1].split('|')[0].trim(), true)}>
      {link[1].slice(shown.from, shown.to).trim()}
    </button>
  )
}

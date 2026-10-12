import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { DAY_STAMP, localDateStamp, shortDay } from './clock'
import { useColumnWidths } from './columnWidths'
import { countOf } from './rows'
import { combine, COMBINE_NAMES, COLUMN_TOTALS, type ColumnTotal } from './tags'
import { columnLabel, decimalsOf, numberOf, numberShown, readTable, withCell, withoutRow, withRow } from './table'

/** Longer than this, a value is a sentence rather than a name, and its column wraps. */
const SENTENCE = 32

/** The value being typed: in a row (a row's index in the table, or a new one), in a column. */
type Editing = { row: number | 'new'; column: number; value: string }

/**
 * A delimited file as a table that is edited in place: a value pressed becomes a field,
 * written on Enter or on leaving it, Tab going on to the next; a row is added at the end
 * and taken out by its ×, after asking. A column's name sorts the rows shown, not the
 * file. Every write is one value or one row (`withCell`), so the rest of the file stays
 * as Excel, the agent or a hand wrote it.
 *
 * A value is shown for reading and edited as written: a number grouped and to its
 * column's decimals, a day as `Mon 5 Oct`. A column of numbers is totalled under it as
 * the owner chose there (`totals`, by the column's name), summed until then: a balance
 * adds up to nothing, so it is set to none.
 */
export function CsvTable({
  text: initial,
  incoming,
  onChange,
  totals,
  onTotal,
}: {
  /** Read at mount; the caller keys this on the file, as the editor is. */
  text: string
  /** The file as written elsewhere since, taken in as the editor takes it. */
  incoming?: { text: string; n: number } | null
  onChange: (text: string) => void
  /** How each column is totalled, by its name in lower case; unset, summed. */
  totals: Readonly<Record<string, ColumnTotal>>
  onTotal: (column: string, total: ColumnTotal) => void
}) {
  const [text, setText] = useState(initial)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [sort, setSort] = useState<{ column: number; down: boolean } | null>(null)
  const taken = useRef(incoming?.n)
  useEffect(() => {
    if (!incoming || incoming.n === taken.current) return
    taken.current = incoming.n
    // Rows may have moved under a field being typed: it is dropped, not written over another row.
    setEditing(null)
    setText(incoming.text)
  }, [incoming])

  const table = useMemo(() => readTable(text), [text])
  const element = useRef<HTMLTableElement>(null)
  const { widths, gripFor } = useColumnWidths(element)
  const [header, ...body] = table.rows
  const rows = body.map((row, at) => ({ ...row, at: at + 1 })).filter((row) => row.to > row.from)
  const width = Math.max(header?.cells.length ?? 0, ...rows.map((row) => row.cells.length))
  const columns = Array.from({ length: width }, (_, at) => at)
  /** Each column's values, the empty ones left out. */
  const filled = columns.map((column) => rows.map((row) => row.cells[column] ?? '').filter((value) => value.trim() !== ''))
  const every = (column: number, test: (value: string) => boolean) => filled[column].length > 0 && filled[column].every(test)
  const numeric = columns.filter((column) => every(column, (value) => numberOf(value) !== null))
  const days = columns.filter((column) => every(column, (value) => DAY_STAMP.test(value.trim())))
  const decimals = columns.map((column) => (numeric.includes(column) ? decimalsOf(filled[column]) : 0))
  /** A number lines up on the right; a column of sentences wraps, where the rest keep to a line. */
  const kinds = columns.map((column) =>
    numeric.includes(column) ? 'data-number' : filled[column].some((value) => value.length > SENTENCE) ? 'data-prose' : undefined
  )
  const today = localDateStamp()
  /** A value as it is read; the field takes it as written. */
  const shownValue = (column: number, value: string) =>
    value.trim() === ''
      ? ''
      : numeric.includes(column)
        ? numberShown(numberOf(value)!, decimals[column])
        : days.includes(column)
          ? shortDay(value.trim(), today)
          : value
  const shown = sort
    ? [...rows].sort((a, b) => {
        const [x, y] = [a.cells[sort.column] ?? '', b.cells[sort.column] ?? '']
        const order = numeric.includes(sort.column) ? (numberOf(x) ?? 0) - (numberOf(y) ?? 0) : x.localeCompare(y)
        return sort.down ? -order : order
      })
    : rows

  const write = (next: string) => {
    setText(next)
    onChange(next)
  }

  /**
   * The field open now. A field is written once: closing it (Enter, then the blur as it
   * goes) would otherwise write a new row twice.
   */
  const live = useRef(editing)
  live.current = editing
  const open = (row: number | 'new', column: number, cells: readonly string[]) => setEditing({ row, column, value: cells[column] ?? '' })

  /** The field's value written, then the field moved by `step` columns along its row, or closed. */
  function commit(step: number | null) {
    if (!editing || live.current !== editing) return
    live.current = null
    const { row, column, value } = editing
    let at = row
    let cells: string[] = []
    if (row === 'new') {
      // A new row is written once something is typed in it; left empty, it was never there.
      if (value.trim() !== '') {
        cells = columns.map((one) => (one === column ? value : ''))
        write(withRow(text, table, cells))
        at = table.rows.length
      }
    } else {
      cells = [...table.rows[row].cells]
      if (value !== (cells[column] ?? '')) write(withCell(text, table, row, column, value))
      cells[column] = value
    }
    const next = step === null ? -1 : column + step
    if (at === 'new' || next < 0 || next >= width) setEditing(null)
    else open(at, next, cells)
  }

  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit(null)
    else if (event.key === 'Escape') {
      live.current = null
      setEditing(null)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      commit(event.shiftKey ? -1 : 1)
    }
  }

  async function remove(row: number) {
    if (!(await confirm('Delete this row? It is taken out of the file.', { kind: 'warning' }))) return
    write(withoutRow(text, table, row))
  }

  const field = (value: string, label: string) => (
    <input
      className="data-edit"
      aria-label={label}
      value={value}
      autoFocus
      onChange={(event) => {
        const value = event.currentTarget.value
        setEditing((was) => was && { ...was, value })
      }}
      onKeyDown={keys}
      onBlur={() => commit(null)}
    />
  )
  const name = (column: number) => columnLabel(header?.cells[column] || `column ${column + 1}`)
  const totalOf = (column: number) => totals[(header?.cells[column] ?? '').trim().toLowerCase()] ?? 'sum'
  /** A column's total, as chosen, to its decimals; a count is whole and an average takes two at least. */
  const totalText = (column: number) => {
    const by = totalOf(column)
    if (by === 'none') return ''
    const value = combine(filled[column].map((one) => numberOf(one)!), by)
    return value === null ? '' : numberShown(value, by === 'count' ? 0 : by === 'average' ? Math.max(decimals[column], 2) : decimals[column])
  }

  if (!header) return <p className="viewer-empty">This table has no columns yet. In Text, its first line names them, separated by commas.</p>
  return (
    <div className="line-table-box data-table-box">
      <table className="line-table data-table" ref={element} data-sized={widths ? '' : undefined}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} data-col={column} className={kinds[column]} style={{ width: widths?.[column] }}>
                <button
                  className="data-sort"
                  aria-label={`Sort by ${name(column)}`}
                  onClick={() => setSort((was) => (was?.column === column ? (was.down ? null : { column, down: true }) : { column, down: false }))}
                >
                  {name(column)}
                  {sort?.column === column && (sort.down ? ' ↓' : ' ↑')}
                </button>
                {gripFor(String(column))}
              </th>
            ))}
            <th aria-hidden />
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.from}>
              {columns.map((column) => (
                <td key={column} className={kinds[column]}>
                  {editing?.row === row.at && editing.column === column ? (
                    field(editing.value, `${name(column)}, row ${row.at}`)
                  ) : (
                    <button className="data-cell" aria-label={`${name(column)}, row ${row.at}`} onClick={() => open(row.at, column, row.cells)}>
                      {shownValue(column, row.cells[column] ?? '')}
                    </button>
                  )}
                </td>
              ))}
              <td className="data-row-actions">
                <button aria-label={`Delete row ${row.at}`} onClick={() => void remove(row.at)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
          {editing?.row === 'new' && (
            <tr>
              {columns.map((column) => (
                <td key={column} className={kinds[column]}>
                  {column === editing.column ? field(editing.value, `${name(column)}, new row`) : null}
                </td>
              ))}
              <td />
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="data-totals">
            {columns.map((column) => (
              <td key={column} className={kinds[column]}>
                {numeric.includes(column) ? (
                  <>
                    <select
                      className="data-total-by"
                      aria-label={`Total of ${name(column)}`}
                      value={totalOf(column)}
                      onChange={(event) => onTotal((header.cells[column] ?? '').trim(), event.currentTarget.value as ColumnTotal)}
                    >
                      {COLUMN_TOTALS.map((by) => (
                        <option key={by} value={by}>
                          {by === 'none' ? 'No total' : COMBINE_NAMES[by]}
                        </option>
                      ))}
                    </select>
                    <span className="data-total">{totalText(column)}</span>
                  </>
                ) : column === 0 ? (
                  countOf(rows.length, 'row')
                ) : null}
              </td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>
      <button className="header-action data-add" onClick={() => open('new', 0, [])}>
        Add a row
      </button>
    </div>
  )
}

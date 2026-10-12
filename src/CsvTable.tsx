import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { DAY_STAMP, localDateStamp, shortDay } from './clock'
import { useColumnWidths } from './columnWidths'
import { NoteIcon } from './icons'
import { Live } from './Live'
import { countOf } from './rows'
import { combine, COMBINE_NAMES, COLUMN_TOTALS, type ColumnTotal } from './tags'
import { columnLabel, decimalsOf, numberOf, numberShown, passes, readTable, withCell, withoutRow, withRow } from './table'

/** The value being typed: in a row (a row's index in the table, or a new one), in a column. */
type Editing = { row: number | 'new'; column: number; value: string }

/** What a column holds, read off its values: it decides how they are shown, and its glyph. */
type Kind = 'number' | 'day' | 'time' | 'link' | 'text'
/** `HH:MM`, a column of times. */
const CLOCK = /^\d{1,2}:\d{2}$/
const GLYPHS: Record<Kind, string> = { number: 'hash', day: 'calendar', time: 'clock', link: 'link', text: 'list' }

/**
 * A delimited file as a table that is edited in place: a value pressed becomes a field,
 * written on Enter or on leaving it, Tab going on to the next; a row is added at the end
 * and taken out by its ×, after asking. A column's name sorts the rows shown, and the
 * filter picks them; neither touches the file. Every write is one value or one row
 * (`withCell`), so the rest of the file stays as Excel, the agent or a hand wrote it.
 *
 * Drawn as a grid, as Airtable draws one (the owner's choice): each row numbered as
 * shown and one line tall, a long value cut short and whole in its field. A value is
 * shown for reading and edited as written: a number grouped and to its column's
 * decimals, a day as `Mon 5 Oct`, a `[[link]]` as its name, pressed to open. A column of
 * numbers is totalled under it, over the rows shown, as the owner chose there (`totals`,
 * by the column's name), summed until then: a balance adds up to nothing.
 */
export function CsvTable({
  text: initial,
  incoming,
  onChange,
  totals,
  onTotal,
  onOpenLink,
}: {
  /** Read at mount; the caller keys this on the file, as the editor is. */
  text: string
  /** The file as written elsewhere since, taken in as the editor takes it. */
  incoming?: { text: string; n: number } | null
  onChange: (text: string) => void
  /** How each column is totalled, by its name in lower case; unset, summed. */
  totals: Readonly<Record<string, ColumnTotal>>
  onTotal: (column: string, total: ColumnTotal) => void
  onOpenLink: (target: string, wiki: boolean) => void
}) {
  const [text, setText] = useState(initial)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [sort, setSort] = useState<{ column: number; down: boolean } | null>(null)
  /** The rows asked for: a column's, or any column's (null), passing `passes`. */
  const [filter, setFilter] = useState<{ column: number | null; text: string }>({ column: null, text: '' })
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
  const kinds = columns.map((column): Kind =>
    every(column, (value) => numberOf(value) !== null)
      ? 'number'
      : every(column, (value) => DAY_STAMP.test(value.trim()))
        ? 'day'
        : every(column, (value) => CLOCK.test(value.trim()))
          ? 'time'
          : filled[column].some((value) => value.includes('[['))
            ? 'link'
            : 'text'
  )
  const decimals = columns.map((column) => (kinds[column] === 'number' ? decimalsOf(filled[column]) : 0))
  const today = localDateStamp()
  /** A value as it reads; the field takes it as written. */
  const shownText = (column: number, value: string) =>
    value.trim() === ''
      ? ''
      : kinds[column] === 'number'
        ? numberShown(numberOf(value)!, decimals[column])
        : kinds[column] === 'day'
          ? shortDay(value.trim(), today)
          : value
  const picked = rows.filter(
    (row) =>
      filter.text.trim() === '' ||
      (filter.column === null ? columns : [filter.column]).some((column) => {
        const value = row.cells[column] ?? ''
        return passes(value, shownText(column, value), filter.text)
      })
  )
  const shown = sort
    ? [...picked].sort((a, b) => {
        const [x, y] = [a.cells[sort.column] ?? '', b.cells[sort.column] ?? '']
        const order = kinds[sort.column] === 'number' ? (numberOf(x) ?? 0) - (numberOf(y) ?? 0) : x.localeCompare(y)
        return sort.down ? -order : order
      })
    : picked

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
  /** A column's total over the rows shown, as chosen, to its decimals; a count is whole and an average takes two at least. */
  const totalText = (column: number) => {
    const by = totalOf(column)
    const values = shown.flatMap((row) => numberOf(row.cells[column] ?? '') ?? [])
    const value = by === 'none' ? null : combine(values, by)
    return value === null ? '' : numberShown(value, by === 'count' ? 0 : by === 'average' ? Math.max(decimals[column], 2) : decimals[column])
  }

  if (!header) return <p className="viewer-empty">This table has no columns yet. In Text, its first line names them, separated by commas.</p>
  return (
    <div className="data-table-box">
      <div className="data-toolbar">
        <span className="data-filter">
          <select
            aria-label="Filter in"
            value={filter.column ?? ''}
            onChange={(event) => {
              const column = event.currentTarget.value
              setFilter((was) => ({ ...was, column: column === '' ? null : Number(column) }))
            }}
          >
            <option value="">Any column</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {name(column)}
              </option>
            ))}
          </select>
          <input
            aria-label="Filter"
            placeholder="Filter… or > 100"
            value={filter.text}
            onChange={(event) => {
              const typed = event.currentTarget.value
              setFilter((was) => ({ ...was, text: typed }))
            }}
            onKeyDown={(event) => event.key === 'Escape' && setFilter((was) => ({ ...was, text: '' }))}
          />
        </span>
        <span className="data-count">{picked.length === rows.length ? countOf(rows.length, 'row') : `${picked.length} of ${countOf(rows.length, 'row')}`}</span>
      </div>
      <div className="data-scroll">
        <table className="data-table" ref={element} data-sized={widths ? '' : undefined}>
          <thead>
            <tr>
              <th className="data-row-head" aria-hidden />
              {columns.map((column) => (
                <th key={column} data-col={column} className={`data-${kinds[column]}`} style={{ width: widths?.[column] }}>
                  <button
                    className="data-sort"
                    aria-label={`Sort by ${name(column)}`}
                    onClick={() => setSort((was) => (was?.column === column ? (was.down ? null : { column, down: true }) : { column, down: false }))}
                  >
                    <span className="data-type" aria-hidden>
                      <NoteIcon icon={GLYPHS[kinds[column]]} />
                    </span>
                    {name(column)}
                    {sort?.column === column && (sort.down ? ' ↓' : ' ↑')}
                  </button>
                  {gripFor(String(column))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, place) => (
              <tr key={row.from}>
                {/* Numbered as shown, as Airtable does; the × takes the number's place under the pointer. */}
                <td className="data-row-head">
                  <span className="data-row-number">{place + 1}</span>
                  <button className="data-delete" aria-label={`Delete row ${row.at}`} onClick={() => void remove(row.at)}>
                    ×
                  </button>
                </td>
                {columns.map((column) => {
                  const value = row.cells[column] ?? ''
                  const label = `${name(column)}, row ${row.at}`
                  return (
                    <td key={column} className={`data-${kinds[column]}`}>
                      {editing?.row === row.at && editing.column === column ? (
                        field(editing.value, label)
                      ) : (
                        // Not a `<button>`: a link in it is one, pressed to open, where the rest of the cell edits.
                        <div
                          role="button"
                          tabIndex={0}
                          className="data-cell"
                          aria-label={label}
                          title={kinds[column] === 'text' || kinds[column] === 'link' ? value : undefined}
                          onClick={() => open(row.at, column, row.cells)}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return
                            event.preventDefault()
                            open(row.at, column, row.cells)
                          }}
                        >
                          {kinds[column] === 'link' || kinds[column] === 'text' ? <Live text={value} onOpenLink={onOpenLink} /> : shownText(column, value)}
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
            {editing?.row === 'new' && (
              <tr>
                <td className="data-row-head" />
                {columns.map((column) => (
                  <td key={column} className={`data-${kinds[column]}`}>
                    {column === editing.column ? field(editing.value, `${name(column)}, new row`) : null}
                  </td>
                ))}
              </tr>
            )}
            {picked.length === 0 && rows.length > 0 && (
              <tr>
                <td className="data-row-head" />
                <td className="data-none" colSpan={width}>
                  No row passes the filter.
                </td>
              </tr>
            )}
            <tr className="data-add-row">
              <td colSpan={width + 1}>
                <button className="data-add" onClick={() => open('new', 0, [])}>
                  <span aria-hidden>+ </span>Add a row
                </button>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="data-totals">
              <td className="data-row-head" />
              {columns.map((column) => (
                <td key={column} className={`data-${kinds[column]}`}>
                  {kinds[column] === 'number' && (
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
                  )}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

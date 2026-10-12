// A delimited file as a table: rows of values, each knowing where it sits in the text,
// so an edit writes that value again and leaves every other byte as it was. A
// tracker is kept this way (`Data/expenses.csv`), and its file stays the owner's: what
// Excel, the agent or a hand wrote is not reformatted by a cell changed here.

import { separatorOf } from './csvPreview'

/** A row: its values, where each is written (quotes and all), and where its text runs, without its line break. */
export interface TableRow {
  cells: string[]
  spans: { from: number; to: number }[]
  from: number
  to: number
}

/** A file read as rows, the first its header, in the file's own separator and line break. */
export interface Table {
  separator: string
  lineBreak: string
  rows: TableRow[]
}

/**
 * The rows of a file: a value in quotes may hold the separator, a line break, or a
 * quote written twice. A blank line is a row with one empty value, kept so the rows
 * after it still know where they are.
 */
export function readTable(text: string): Table {
  const separator = separatorOf(text.slice(0, text.search(/\r?\n|$/)))
  const rows: TableRow[] = []
  let at = 0
  while (at < text.length) {
    const from = at
    const cells: string[] = []
    const spans: { from: number; to: number }[] = []
    let start = at
    let cell = ''
    let quoted = false
    let fieldStart = true
    for (; at < text.length; at++) {
      const c = text[at]
      if (quoted) {
        if (c !== '"') cell += c
        else if (text[at + 1] === '"') cell += text[++at]
        else quoted = false
        continue
      }
      if (c === '\n' || (c === '\r' && text[at + 1] === '\n')) break
      if (c === separator) {
        cells.push(cell)
        spans.push({ from: start, to: at })
        start = at + 1
        cell = ''
        fieldStart = true
        continue
      }
      if (c === '"' && fieldStart) quoted = true
      else cell += c
      fieldStart = false
    }
    cells.push(cell)
    spans.push({ from: start, to: at })
    rows.push({ cells, spans, from, to: at })
    at += text[at] === '\r' ? 2 : text[at] === '\n' ? 1 : 0
  }
  return { separator, lineBreak: text.includes('\r\n') ? '\r\n' : '\n', rows }
}

/** A value as the file writes it: in quotes only when it must be, a quote inside written twice. */
export function cellText(value: string, separator: string): string {
  return value.includes(separator) || /["\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value
}

const rowText = (cells: readonly string[], separator: string) => cells.map((one) => cellText(one, separator)).join(separator)

/**
 * The file with one value changed, written where the old one was, every other byte as
 * it was, the rest of its row included. A value past the row's end is reached with
 * empty ones.
 */
export function withCell(text: string, table: Table, row: number, column: number, value: string): string {
  const { cells, spans, to } = table.rows[row]
  const written = cellText(value, table.separator)
  if (column < spans.length) return text.slice(0, spans[column].from) + written + text.slice(spans[column].to)
  const reach = [...Array<string>(column - cells.length).fill(''), written].map((one) => table.separator + one).join('')
  return text.slice(0, to) + reach + text.slice(to)
}

/** The file with a row added at its end, after the line break it may be missing. */
export function withRow(text: string, table: Table, cells: readonly string[]): string {
  const gap = text === '' || text.endsWith('\n') ? '' : table.lineBreak
  return text + gap + rowText(cells, table.separator) + table.lineBreak
}

/** The file with a row taken out, with its line break. */
export function withoutRow(text: string, table: Table, row: number): string {
  return text.slice(0, table.rows[row].from) + text.slice(table.rows[row + 1]?.from ?? text.length)
}

/** A value read as a number: digits, a sign and a decimal point, and nothing else. */
export const numberOf = (value: string) => (/^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null)

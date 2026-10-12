import { describe, expect, it } from 'vitest'
import { cellText, columnLabel, decimalsOf, numberOf, numberShown, passes, readTable, withCell, withoutRow, withRow } from '../table'

/** A tracker's file, read as rows and written back a row at a time. */

const expenses = ['day,amount,what,where', '2026-10-10,480,lunch,"Harbour Bistro, upstairs"', '2026-10-11,12.5,"the ""good"" coffee",', ''].join('\n')

describe('a table', () => {
  it('reads rows, quotes and all, with where each sits', () => {
    const table = readTable(expenses)
    expect(table.rows.map((row) => row.cells)).toEqual([
      ['day', 'amount', 'what', 'where'],
      ['2026-10-10', '480', 'lunch', 'Harbour Bistro, upstairs'],
      ['2026-10-11', '12.5', 'the "good" coffee', ''],
    ])
    expect(expenses.slice(table.rows[1].from, table.rows[1].to)).toBe('2026-10-10,480,lunch,"Harbour Bistro, upstairs"')
  })

  it('reads a value holding a line break, a tab-separated file, and a CRLF file', () => {
    expect(readTable('a,b\n"one\ntwo",3\n').rows.map((row) => row.cells)).toEqual([['a', 'b'], ['one\ntwo', '3']])
    expect(readTable('a\tb\n1\t2').rows[1].cells).toEqual(['1', '2'])
    const crlf = readTable('a,b\r\n1,2\r\n')
    expect([crlf.lineBreak, crlf.rows[1].cells]).toEqual(['\r\n', ['1', '2']])
  })

  /** A cell changed here leaves what Excel, the agent or a hand wrote elsewhere as it was. */
  it('writes back only the row changed, quoting a value only when it must', () => {
    const table = readTable(expenses)
    expect(withCell(expenses, table, 2, 3, 'Lakeside, kiosk')).toBe(expenses.replace('coffee",', 'coffee","Lakeside, kiosk"'))
    expect(withCell(expenses, table, 1, 1, '500')).toBe(expenses.replace('480', '500'))
    expect([cellText('plain', ','), cellText(' padded', ','), cellText('a,b', ','), cellText('a,b', '\t')]).toEqual(['plain', '" padded"', '"a,b"', 'a,b'])
  })

  it('adds a row at the end, and takes one out with its line break', () => {
    const table = readTable(expenses)
    expect(withRow(expenses, table, ['2026-10-12', '90', 'bus', ''])).toBe(`${expenses}2026-10-12,90,bus,\n`)
    expect(withRow('day,amount', readTable('day,amount'), ['2026-10-12', '90'])).toBe('day,amount\n2026-10-12,90\n')
    expect(withoutRow(expenses, table, 1)).toBe(expenses.replace('2026-10-10,480,lunch,"Harbour Bistro, upstairs"\n', ''))
  })

  it('reads a number only when the value is one', () => {
    expect(['480', '-12.5', ' 3 ', '1,200', '€480', ''].map(numberOf)).toEqual([480, -12.5, 3, null, null, null])
  })

  it('passes a value by the words in it, as written or shown, or a number by how it compares', () => {
    expect([passes('Harbour Bistro', 'Harbour Bistro', 'bistro'), passes('2026-10-05', 'Mon 5 Oct', 'oct'), passes('lunch', 'lunch', 'tea')]).toEqual([true, true, false])
    expect(['> 100', '<=480', '=480', '>= 481', '< 0'].map((filter) => passes('480', '480', filter))).toEqual([true, true, true, false, false])
    // Not a number: the filter is words, and `>` is one of them.
    expect([passes('lunch', 'lunch', '> 100'), passes('a > 100 b', 'a > 100 b', '> 100')]).toEqual([false, true])
  })

  it('says a column’s name as words, and shows its numbers to its most precise value’s decimals', () => {
    expect(['end-amount', 'paid_by', ' for '].map(columnLabel)).toEqual(['End amount', 'Paid by', 'For'])
    expect([decimalsOf(['480', '12.5', ' 3.25 ']), decimalsOf(['7'])]).toEqual([2, 0])
    expect(numberShown(10320, 2)).toBe(new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(10320))
  })
})

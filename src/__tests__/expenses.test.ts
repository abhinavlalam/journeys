import { describe, expect, it } from 'vitest'
import { balancesOf, mainCurrency, monthAfter, monthOf, moneyText, readExpenses } from '../expenses'

/** The expenses table as the Expenses page reads it, and a month of it added up. */

const table = [
  'Day,time,amount,currency,for,category,merchant,account,end-amount',
  '2026-09-03,09:10,40,EUR,,Plants,Northwind Market,Harbour Card,960',
  '2026-09-20,08:40,100,EUR,ferry,Boats,Lakeside Ferries,Harbour Card,860',
  '2026-10-02,12:50,30,EUR,lunch,Tea,Harbour Bistro,Lakeside Bank,470',
  '2026-10-01,09:10,12.5,EUR,,Plants,Northwind Market,Harbour Card,847.5',
  '2026-10-02,19:30,20,EUR,dinner,Tea,Harbour Bistro,Lakeside Bank,450',
  '2026-10-05,10:00,9,GBP,,Books,Mira Books,,',
  'soon,,5,EUR,,,,,',
  '',
].join('\n')

describe('the expenses table', () => {
  it('reads each row by its columns’ names, by day and time, and counts what it could not read', () => {
    const { expenses, missing, unread } = readExpenses(table)
    expect(expenses.map((one) => `${one.day} ${one.time}`)).toEqual([
      '2026-09-03 09:10',
      '2026-09-20 08:40',
      '2026-10-01 09:10',
      '2026-10-02 12:50',
      '2026-10-02 19:30',
      '2026-10-05 10:00',
    ])
    expect(expenses[2]).toEqual({
      day: '2026-10-01',
      time: '09:10',
      amount: 12.5,
      currency: 'EUR',
      what: '',
      category: 'Plants',
      merchant: 'Northwind Market',
      account: 'Harbour Card',
      balance: 847.5,
    })
    expect([missing, unread]).toEqual([[], 1])
    expect(readExpenses('when,what\n2026-10-01,tea\n')).toEqual({ expenses: [], missing: ['day', 'amount'], unread: 0 })
  })

  it('adds up in the currency most expenses are in', () => {
    expect(mainCurrency(readExpenses(table).expenses)).toBe('EUR')
  })

  it('steps a month over a year', () => {
    expect([monthAfter('2026-01', -1), monthAfter('2026-12', 1), monthAfter('2026-10', 0)]).toEqual(['2025-12', '2027-01', '2026-10'])
  })
})

describe('a month of expenses', () => {
  const expenses = readExpenses(table).expenses.filter((one) => one.currency === 'EUR')

  it('adds up what was spent, by category, by day and by place', () => {
    const month = monthOf(expenses, '2026-10', '2026-10-31')
    expect([month.spent, month.days, month.expenses.length]).toEqual([62.5, 31, 3])
    expect(month.categories).toEqual([
      { name: 'Tea', spent: 50, count: 2 },
      { name: 'Plants', spent: 12.5, count: 1 },
    ])
    expect(month.daily.slice(0, 3)).toEqual([12.5, 50, 0])
    expect(month.daily).toHaveLength(31)
    expect(month.merchants.map((one) => [one.name, one.count])).toEqual([
      ['Harbour Bistro', 2],
      ['Northwind Market', 1],
    ])
  })

  /** Twelve days into a month set against all of the last one read as spending less, every month. */
  it('sets a month not yet over against the same days of the one before', () => {
    expect(monthOf(expenses, '2026-10', '2026-10-12')).toMatchObject({ before: 40, days: 12 })
    expect(monthOf(expenses, '2026-10', '2026-11-03')).toMatchObject({ before: 140, days: 31 })
    // With nothing before it, there is nothing to set it against.
    expect(monthOf(expenses, '2026-09', '2026-10-12').before).toBeNull()
  })

  it('says each account’s balance after its last expense up to a day', () => {
    expect(balancesOf(expenses, '2026-10-01')).toEqual([{ account: 'Harbour Card', balance: 847.5, day: '2026-10-01' }])
    expect(balancesOf(expenses, '2026-10-31').map((one) => [one.account, one.balance])).toEqual([
      ['Harbour Card', 847.5],
      ['Lakeside Bank', 450],
    ])
  })
})

describe('an amount', () => {
  it('is written in its currency, or with the name the table gives it', () => {
    expect(moneyText(1234.5, 'EUR')).toBe(new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', currencyDisplay: 'narrowSymbol' }).format(1234.5))
    expect(moneyText(1234.5, 'shells', 0)).toBe(`${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(1234.5)} shells`)
  })
})

// The expenses table as the Expenses page reads it: a row an expense, each column
// found by the name the vault's guide gives it, and a month of them added up.

import { localDateStamp } from './clock'
import { numberOf, numberShown } from './table'
import { trackedRows } from './trackers'

/** The columns read, by their names in the table's first line, in any case. */
export const EXPENSE_COLUMNS = {
  day: 'day',
  time: 'time',
  amount: 'amount',
  currency: 'currency',
  what: 'for',
  category: 'category',
  merchant: 'merchant',
  account: 'account',
  balance: 'end-amount',
} as const

export interface Expense {
  day: string
  time: string
  amount: number
  currency: string
  what: string
  category: string
  merchant: string
  account: string
  /** What the account was left with, where the row says. */
  balance: number | null
}

/**
 * The table's expenses by day and time, and what was not read: the columns it lacks
 * of the two every expense needs, and how many rows have no day or amount.
 */
export function readExpenses(text: string): { expenses: Expense[]; missing: string[]; unread: number } {
  const { rows, missing, unread } = trackedRows(text, EXPENSE_COLUMNS, 'amount')
  const expenses = rows.map(({ n, balance, ...row }) => ({ ...row, amount: n, balance: numberOf(balance) }))
  return { expenses, missing, unread }
}

/** The currency most expenses are in, which the page adds up in. */
export function mainCurrency(expenses: readonly Expense[]): string {
  const counts = new Map<string, number>()
  for (const { currency } of expenses) counts.set(currency, (counts.get(currency) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

/** `YYYY-MM`, `n` months on from `month`. */
export function monthAfter(month: string, n: number): string {
  return localDateStamp(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1)).slice(0, 7)
}

const daysIn = (month: string) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
const total = (expenses: readonly Expense[]) => expenses.reduce((sum, one) => sum + one.amount, 0)

/** How many places the page names in a list before it stops: the rest are in the table. */
const LISTED = 5

/** A month of expenses added up, as the page shows it. */
export interface Month {
  /** The month's expenses, by day and time. */
  expenses: Expense[]
  spent: number
  /**
   * What the month before spent over the same days: all of it, or up to today's date
   * while this month is not over. Null when the table has nothing before this month.
   */
  before: number | null
  /** The days the month has had: all of them, or up to today. */
  days: number
  /** Each category's spending, most first; `''` is none. */
  categories: { name: string; spent: number; count: number }[]
  /** Each day's spending, the 1st first. */
  daily: number[]
  /** The places spent at most. */
  merchants: { name: string; spent: number; count: number }[]
}

/** `month`'s expenses (`YYYY-MM`) added up, as of `today`. */
export function monthOf(expenses: readonly Expense[], month: string, today: string): Month {
  const inMonth = (one: Expense, of: string, upTo = 31) => one.day.startsWith(of) && Number(one.day.slice(8)) <= upTo
  const days = today.startsWith(month) ? Number(today.slice(8)) : daysIn(month)
  const shown = expenses.filter((one) => inMonth(one, month))
  const previous = monthAfter(month, -1)
  const earlier = expenses.filter((one) => inMonth(one, previous, days < daysIn(month) ? days : 31))
  const grouped = (key: (one: Expense) => string) => {
    const groups = new Map<string, Expense[]>()
    for (const one of shown) groups.set(key(one), [...(groups.get(key(one)) ?? []), one])
    return [...groups].map(([name, them]) => ({ name, spent: total(them), count: them.length })).sort((a, b) => b.spent - a.spent)
  }
  const daily = Array<number>(daysIn(month)).fill(0)
  for (const one of shown) daily[Number(one.day.slice(8)) - 1] += one.amount
  return {
    expenses: shown,
    spent: total(shown),
    before: expenses.some((one) => one.day < `${month}-01`) ? total(earlier) : null,
    days,
    categories: grouped((one) => one.category),
    daily,
    merchants: grouped((one) => one.merchant)
      .filter((one) => one.name !== '')
      .slice(0, LISTED),
  }
}

/** Each account's balance after its last expense up to `day`, where a row said it; by name. */
export function balancesOf(expenses: readonly Expense[], day: string): { account: string; balance: number; day: string }[] {
  const latest = new Map<string, { account: string; balance: number; day: string }>()
  for (const one of expenses) {
    if (one.day <= day && one.account && one.balance !== null)
      latest.set(one.account, {
        account: one.account,
        balance: one.balance,
        day: one.day,
      })
  }
  return [...latest.values()].sort((a, b) => a.account.localeCompare(b.account))
}

const formats = new Map<string, Intl.NumberFormat | null>()
/**
 * An amount in its currency: with its symbol where the currency is a code (`EUR`),
 * else the number and what the table calls it.
 */
export function moneyText(value: number, currency: string, decimals = 2): string {
  const key = `${currency}:${decimals}`
  if (!formats.has(key)) {
    const digits = {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }
    const code = /^[a-z]{3}$/i.test(currency)
    formats.set(
      key,
      code
        ? new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency,
            currencyDisplay: 'narrowSymbol',
            ...digits,
          })
        : null
    )
  }
  const format = formats.get(key)
  if (format) return format.format(value)
  return currency ? `${numberShown(value, decimals)} ${currency}` : numberShown(value, decimals)
}

import { useMemo, useState } from 'react'
import { ChevronIcon } from './icons'
import { dayDate, localDateStamp, monthName, shortDate, shortDay } from './clock'
import { balancesOf, EXPENSE_COLUMNS, mainCurrency, monthAfter, monthOf, moneyText, readExpenses, type Expense } from './expenses'
import { countOf, EmptyRow, NoteRow, READING, RowIcon, Section, stepIn } from './rows'
import { baseName, folderOf, type VaultFile } from './vaultModel'
import { ViewerHeader } from './ViewerHeader'

/** `September`, beside a year already said. */
const monthOnly = new Intl.DateTimeFormat(undefined, { month: 'long' })

/**
 * Expenses: a month of the expenses table at a glance, stepped back and on. What was
 * spent and how that stands to the month before, a day's average and the count; then
 * by category, day by day, where, each account's balance, and the month's expenses.
 * The table is picked here the first time, from the vault's tables, and kept in the
 * settings; the page only reads it, and a press opens it to edit.
 */
export function ExpensesView({
  sheet,
  text,
  tables,
  reading,
  onPick,
  onOpenSheet,
  onOpenDay,
}: {
  /** The table picked, `''` until one is. */
  sheet: string
  /** Its text, or null while the vault is read or when it is not there. */
  text: string | null
  /** The vault's tables, to pick from. */
  tables: readonly VaultFile[]
  reading: boolean
  onPick: (path: string) => void
  onOpenSheet: () => void
  onOpenDay: (day: string) => void
}) {
  const today = localDateStamp()
  const [shown, setShown] = useState(today.slice(0, 7))
  const [picking, setPicking] = useState(false)
  const read = useMemo(() => (text === null ? null : readExpenses(text)), [text])
  const currency = read ? mainCurrency(read.expenses) : ''
  // One currency is added up: the one most expenses are in.
  const counted = useMemo(() => read?.expenses.filter((one) => one.currency === currency) ?? [], [read, currency])
  const first = counted[0]?.day.slice(0, 7) ?? shown
  const last = [today.slice(0, 7), counted.at(-1)?.day.slice(0, 7) ?? ''].sort().at(-1)!
  const data = useMemo(() => monthOf(counted, shown, today), [counted, shown, today])
  const money = (value: number, decimals?: number) => moneyText(value, currency, decimals)

  const elsewhere = (read?.expenses.length ?? 0) - counted.length
  const status = [
    read?.unread ? `${countOf(read.unread, 'row')} without a day or amount` : '',
    elsewhere > 0 ? `${elsewhere} in other currencies, not added` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const header = (
    <ViewerHeader name="Expenses" status={status}>
      {read && !picking && read.missing.length === 0 && (
        <span className="month-step" role="group" aria-label="Month">
          <button className="header-action back" aria-label="The month before" disabled={shown <= first} onClick={() => setShown(monthAfter(shown, -1))}>
            <ChevronIcon open={false} />
          </button>
          <span className="month-step-name">{monthName.format(dayDate(`${shown}-01`))}</span>
          <button className="header-action" aria-label="The month after" disabled={shown >= last} onClick={() => setShown(monthAfter(shown, 1))}>
            <ChevronIcon open={false} />
          </button>
        </span>
      )}
      {sheet && (
        <button className="header-action" aria-pressed={picking} onClick={() => setPicking((was) => !was)}>
          Change table
        </button>
      )}
    </ViewerHeader>
  )

  if (!sheet || picking || (text === null && !reading)) {
    return (
      <>
        {header}
        <Section
          title={sheet && !picking ? `${baseName(sheet)} is gone: which table holds your expenses?` : 'Which table holds your expenses?'}
          count={tables.length}
          startOpen
        >
          {tables.length === 0 ? (
            <EmptyRow text={reading ? READING : 'No tables in the vault yet: a .csv file is one.'} />
          ) : (
            tables.map((table) => (
              <li key={table.path} style={{ paddingLeft: stepIn(1) }}>
                <NoteRow
                  icon={<RowIcon icon="chart" />}
                  name={table.name}
                  className={table.path === sheet ? 'selected' : undefined}
                  aria-pressed={table.path === sheet}
                  trailing={<span className="row-count">{folderOf(table.path)}</span>}
                  onClick={() => {
                    setPicking(false)
                    onPick(table.path)
                  }}
                />
              </li>
            ))
          )}
        </Section>
      </>
    )
  }
  if (!read) return header
  if (read.missing.length > 0) {
    return (
      <>
        {header}
        <p className="viewer-empty">
          {baseName(sheet)} has no {read.missing.join(' or ')} column. The page reads a table by the names in its first line:{' '}
          {Object.values(EXPENSE_COLUMNS).join(', ')}.{' '}
          <button className="header-action" onClick={onOpenSheet}>
            Open it
          </button>
        </p>
      </>
    )
  }

  const thisMonth = shown === today.slice(0, 7)
  const before = data.before === null || data.before === 0 ? null : (data.spent - data.before) / data.before
  const previous = dayDate(`${monthAfter(shown, -1)}-01`)
  const beforeLabel =
    thisMonth && data.days < data.daily.length
      ? `than ${shortDate.formatRange(previous, new Date(previous.getFullYear(), previous.getMonth(), data.days))}`
      : `than ${monthOnly.format(previous)}`

  return (
    <>
      {header}
      <ul className="day-totals">
        <li className="day-total">
          <span className="day-total-number">{money(data.spent)}</span>
          <span className="day-total-name">Spent</span>
        </li>
        {before !== null && (
          <li className="day-total">
            <span className="day-total-number">
              {Math.round(Math.abs(before) * 100)}% {before >= 0 ? 'more' : 'less'}
            </span>
            <span className="day-total-name">{beforeLabel}</span>
          </li>
        )}
        <li className="day-total">
          <span className="day-total-number">{money(data.spent / data.days)}</span>
          <span className="day-total-name">A day, over {countOf(data.days, 'day')}</span>
        </li>
        <li className="day-total">
          <span className="day-total-number">{data.expenses.length}</span>
          <span className="day-total-name">{data.expenses.length === 1 ? 'Expense' : 'Expenses'}</span>
        </li>
      </ul>
      {data.expenses.length > 0 && (
        <>
          <Section title="By category" count={data.categories.length} startOpen>
            <li className="expense-box">
              <ul className="expense-bars">
                {data.categories.map((one) => (
                  <li key={one.name}>
                    <span className="expense-bar-name">{one.name || 'No category'}</span>
                    <span className="expense-bar-track">
                      <span
                        className="expense-bar"
                        style={{
                          width: `${(one.spent / data.categories[0].spent) * 100}%`,
                        }}
                      />
                    </span>
                    <span className="expense-figure">{money(one.spent, 0)}</span>
                    <span className="expense-share">{Math.round((one.spent / data.spent) * 100)}%</span>
                  </li>
                ))}
              </ul>
            </li>
          </Section>
          <Section title="Day by day" count={data.daily.filter((one) => one > 0).length} startOpen>
            <li className="expense-box">
              <DayByDay month={shown} daily={data.daily} expenses={data.expenses} today={today} money={money} onOpenDay={onOpenDay} />
            </li>
          </Section>
          <Section title="Where" count={data.merchants.length} startOpen>
            {data.merchants.map((one) => (
              <Line key={one.name} name={one.name} detail={one.count === 1 ? '' : `${one.count} times`} value={money(one.spent)} onPress={onOpenSheet} />
            ))}
          </Section>
        </>
      )}
      <Accounts expenses={read.expenses} until={thisMonth ? today : `${shown}-31`} today={today} onOpenSheet={onOpenSheet} />
      <Section title={thisMonth ? 'This month' : monthOnly.format(dayDate(`${shown}-01`))} count={data.expenses.length} startOpen>
        {data.expenses.length === 0 ? (
          <EmptyRow text="Nothing spent this month, as the table has it." />
        ) : (
          [...data.expenses]
            .reverse()
            .map((one, at) => (
              <Line
                key={at}
                name={one.what || one.merchant || one.category || 'An expense'}
                detail={[shortDay(one.day, today), one.time, one.what ? one.merchant : '', one.category].filter(Boolean).join(' · ')}
                value={money(one.amount)}
                onPress={onOpenSheet}
              />
            ))
        )}
      </Section>
    </>
  )
}

/** A row of a list on the page: what, a word on it, and its amount on the right. Pressed, the table opens. */
function Line({ name, detail, value, onPress }: { name: string; detail: string; value: string; onPress: () => void }) {
  return (
    <li style={{ paddingLeft: stepIn(1) }}>
      <button className="expense-line" onClick={onPress}>
        <span className="expense-line-name">{name}</span>
        {detail && <span className="expense-line-detail">{detail}</span>}
        <span className="expense-figure">{value}</span>
      </button>
    </li>
  )
}

/** Each account's balance after its last expense up to the month's end, as its row said. */
function Accounts({ expenses, until, today, onOpenSheet }: { expenses: readonly Expense[]; until: string; today: string; onOpenSheet: () => void }) {
  const balances = balancesOf(expenses, until)
  if (balances.length === 0) return null
  return (
    <Section title="Accounts" count={balances.length} startOpen>
      {balances.map((one) => {
        const currency = expenses.findLast((expense) => expense.account === one.account)?.currency ?? ''
        return (
          <Line key={one.account} name={one.account} detail={`after ${shortDay(one.day, today)}`} value={moneyText(one.balance, currency)} onPress={onOpenSheet} />
        )
      })}
    </Section>
  )
}

/**
 * The month as columns, a day each, as tall as what was spent that day. The line above
 * says the most spent in a day, or the day pointed at; a press opens the day's note.
 */
function DayByDay({
  month,
  daily,
  expenses,
  today,
  money,
  onOpenDay,
}: {
  month: string
  daily: readonly number[]
  expenses: readonly Expense[]
  today: string
  money: (value: number) => string
  onOpenDay: (day: string) => void
}) {
  const [pointed, setPointed] = useState<number | null>(null)
  const most = daily.indexOf(Math.max(...daily))
  const dayAt = (at: number) => `${month}-${String(at + 1).padStart(2, '0')}`
  const said = (at: number) => {
    const count = expenses.filter((one) => one.day === dayAt(at)).length
    return `${shortDay(dayAt(at), today)}: ${money(daily[at])}${count > 1 ? ` over ${count}` : ''}`
  }
  return (
    <>
      <p className="expense-readout" aria-live="polite">
        {pointed === null ? `Most in a day: ${said(most)}` : said(pointed)}
      </p>
      <div className="expense-days" style={{ gridTemplateColumns: `repeat(${daily.length}, 1fr)` }} onPointerLeave={() => setPointed(null)}>
        {daily.map((spent, at) => (
          <button
            key={at}
            className="expense-day"
            aria-label={said(at)}
            aria-current={dayAt(at) === today ? 'date' : undefined}
            disabled={dayAt(at) > today}
            onPointerEnter={() => setPointed(at)}
            onFocus={() => setPointed(at)}
            onBlur={() => setPointed(null)}
            onClick={() => onOpenDay(dayAt(at))}
          >
            {spent > 0 && <span className="expense-day-bar" style={{ height: `${(spent / daily[most]) * 100}%` }} />}
          </button>
        ))}
      </div>
      <div className="expense-axis" style={{ gridTemplateColumns: `repeat(${daily.length}, 1fr)` }} aria-hidden>
        {daily.map((_, at) => (
          <span key={at}>{at === 0 || (at + 1) % 7 === 0 ? at + 1 : ''}</span>
        ))}
      </div>
    </>
  )
}

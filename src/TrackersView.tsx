import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { firstWeekday } from './calendar'
import { dayDate, daysAfter, localDateStamp, monthName, narrowWeekday, shortDate, shortDay, weekdayName } from './clock'
import { CALORIE_COLUMNS, readCalories, usualItems, type Meal } from './calories'
import { balancesOf, EXPENSE_COLUMNS, mainCurrency, monthAfter, monthOf, moneyText, readExpenses, type Expense } from './expenses'
import { habitDays, readHabits, streakOf, type Habits } from './habits'
import { ChevronIcon } from './icons'
import { AddButton, countOf, EmptyRow, NameField, Section, stepIn } from './rows'
import { TRACKER_VIEWS } from './settings'
import { Adder, AmountField, Bars, Box, Columns, expenseFields, FOOD_FIELDS, Line, now, TablePicker, Tile, Tiles } from './trackerParts'
import { daysBack, perDay, perWeek, weeksBack, type Tracker } from './trackers'
import { APP_COLUMNS, hoursText, minutesByApp, readAppTime, type AppTime } from './appTime'
import { PLAN_COLUMNS, readPlan } from './plan'
import { PlanPage, type PlanWrites } from './PlanView'
import { baseName, folderOf, type VaultFile } from './vaultModel'
import { ViewerHeader, ViewSwitch } from './ViewerHeader'

/** `September`, beside a year already said. */
const monthOnly = new Intl.DateTimeFormat(undefined, { month: 'long' })
/** How far back the trends look. */
const WEEKS = 12
const DAYS = 30
/** How many weeks the habits' grid shows, this one last. */
const GRID_WEEKS = 4
/** How many usual things to eat the page offers to add again. */
const USUAL = 6

/** A tracker's table as the page gets it: where it is, and its text, null while read or when gone. */
export interface TrackerTable {
  path: string
  text: string | null
}

export interface Targets {
  calorieTarget: number
  monthlyBudget: number
  categoryBudgets: Readonly<Record<string, number>>
}

type View = (typeof TRACKER_VIEWS)[number]

const NAMES: Record<Tracker, string> = { plan: 'day’s plan', expenses: 'expenses', calories: 'calories', habits: 'habits', apps: 'time in each app' }
/** What each table is read by, said when one lacks what it needs. */
const COLUMNS: Record<Tracker, readonly string[]> = {
  plan: PLAN_COLUMNS,
  expenses: Object.values(EXPENSE_COLUMNS),
  calories: Object.values(CALORIE_COLUMNS),
  habits: ['day', 'and a column for each habit'],
  apps: APP_COLUMNS,
}

/**
 * Trackers: what is counted day by day, each in a table of its own (expenses, calories,
 * habits), opening on today across them all, then a page for each. A page reads its
 * table and writes to it a row at a time: an expense or a thing eaten added, a habit
 * ticked. Targets (a day's calories, a month's budget and each category's) are the
 * owner's, set on the page. A table is picked or made the first time.
 */
export function TrackersView({
  view,
  onView,
  tables,
  planned,
  plan,
  files,
  reading,
  targets,
  onTargets,
  onPick,
  onMake,
  onAdd,
  onTick,
  onAddHabit,
  onOpenTable,
  onOpenDay,
  onOrganise,
  counting,
  onCounting,
  onError,
}: {
  view: View
  onView: (view: View) => void
  tables: Readonly<Record<Tracker, TrackerTable>>
  /** The day's plan as a habit, read from its table: shown with the table's habits, and ticked in the plan. */
  planned: { name: string; done: ReadonlySet<string> } | null
  /** The day's plan (`dayPlan`): its name, how many things a day, and its table's writes. */
  plan: { name: string; count: number } & PlanWrites
  /** The vault's tables, to pick from. */
  files: readonly VaultFile[]
  reading: boolean
  targets: Targets
  onTargets: (targets: Partial<Targets>) => void
  onPick: (tracker: Tracker, path: string) => void
  /** Makes the tracker's table at `path`, with its columns. */
  onMake: (tracker: Tracker, path: string) => void
  onAdd: (tracker: 'expenses' | 'calories', record: Record<string, string>) => void
  onTick: (day: string, habit: string, done: boolean) => void
  onAddHabit: (name: string) => void
  onOpenTable: (tracker: Tracker) => void
  onOpenDay: (day: string) => void
  /** Asks the vault's agent, in a terminal, to put the notes into the tables; none on the phone. */
  onOrganise?: () => void
  /** Whether the time in each app is being counted (`trackApps`), and a change to it. */
  counting: boolean
  onCounting: (on: boolean) => void
  onError: (message: string) => void
}) {
  const today = localDateStamp()
  const [changing, setChanging] = useState(false)
  const expenses = useMemo(() => (tables.expenses.text === null ? null : readExpenses(tables.expenses.text)), [tables.expenses.text])
  const calories = useMemo(() => (tables.calories.text === null ? null : readCalories(tables.calories.text)), [tables.calories.text])
  const habits = useMemo(() => {
    const table = tables.habits.text === null ? null : readHabits(tables.habits.text)
    if (!planned || !table) return table
    return { names: [...table.names, planned.name], done: new Map([...table.done, [planned.name, new Set(planned.done)]]) }
  }, [tables.habits.text, planned])
  // The plan's habit is its things done, not a cell: a press on a day opens it, its things at the top.
  const tick = (day: string, habit: string, done: boolean) => (habit === planned?.name ? onOpenDay(day) : onTick(day, habit, done))
  const apps = useMemo(() => (tables.apps.text === null ? null : readAppTime(tables.apps.text)), [tables.apps.text])
  const plans = useMemo(() => (tables.plan.text === null ? null : readPlan(tables.plan.text)), [tables.plan.text])
  const currency = expenses ? mainCurrency(expenses.expenses) : ''
  // One currency is added up: the one most expenses are in.
  const counted = useMemo(() => expenses?.expenses.filter((one) => one.currency === currency) ?? [], [expenses, currency])
  const money = (value: number, decimals?: number) => moneyText(value, currency, decimals)

  const elsewhere = (expenses?.expenses.length ?? 0) - counted.length
  const unread = (expenses?.unread ?? 0) + (calories?.unread ?? 0)
  const status = [unread ? `${countOf(unread, 'row')} without a day or number` : '', elsewhere > 0 ? `${elsewhere} in other currencies, not added` : '']
    .filter(Boolean)
    .join(' · ')

  /** A new table goes beside the other trackers' tables, or at the top of the vault. */
  const home = folderOf(Object.values(tables).find((table) => table.path)?.path ?? '')
  const makePath = (tracker: Tracker) => (home ? `${home}/${tracker}.csv` : `${tracker}.csv`)
  /** The question a tracker with no table asks, or null when it has one to read. */
  const ask = (tracker: Tracker) => {
    const table = tables[tracker]
    const gone = table.path && table.text === null && !reading
    if (table.path && !gone && !(changing && view === tracker)) return null
    return (
      <TablePicker
        question={gone ? `${baseName(table.path)} is gone: which table holds your ${NAMES[tracker]}?` : `Which table holds your ${NAMES[tracker]}?`}
        tables={files}
        picked={table.path}
        reading={reading}
        make={makePath(tracker)}
        onPick={(path) => {
          setChanging(false)
          onPick(tracker, path)
        }}
        onMake={() => {
          setChanging(false)
          onMake(tracker, makePath(tracker))
        }}
      />
    )
  }
  const lacking = (tracker: Tracker, missing: readonly string[]) =>
    missing.length > 0 && (
      <p className="viewer-empty">
        {baseName(tables[tracker].path)} has no {missing.join(' or ')} column. The page reads it by the names in its first line: {COLUMNS[tracker].join(', ')}.{' '}
        <button className="header-action" onClick={() => onOpenTable(tracker)}>
          Open it
        </button>
      </p>
    )

  const header = (
    <ViewerHeader name="Trackers" status={status}>
      <ViewSwitch
        views={TRACKER_VIEWS}
        labels={{ plan: plan.name }}
        view={view}
        onView={(next) => {
          setChanging(false)
          onView(next)
        }}
      />
      {view !== 'today' && tables[view].path && (
        <button className="header-action" aria-pressed={changing} onClick={() => setChanging((was) => !was)}>
          Change table
        </button>
      )}
      {onOrganise && (
        <button className="header-action" title="Ask the vault's agent to put the days' notes into the tables" onClick={onOrganise}>
          Organise
        </button>
      )}
    </ViewerHeader>
  )

  const page = () => {
    if (view === 'today') {
      return (
        <TodayPage
          today={today}
          expenses={tables.expenses.path && expenses ? counted : null}
          meals={tables.calories.path ? (calories?.meals ?? null) : null}
          habits={tables.habits.path ? habits : null}
          money={money}
          currency={currency}
          targets={targets}
          onAdd={onAdd}
          onTick={tick}
          onView={onView}
          onOpenTable={onOpenTable}
        />
      )
    }
    const asked = ask(view)
    if (asked) return asked
    if (view === 'expenses') {
      if (!expenses) return null
      return (
        lacking('expenses', expenses.missing) || (
          <ExpensesPage
            today={today}
            expenses={counted}
            all={expenses.expenses}
            money={money}
            currency={currency}
            targets={targets}
            onTargets={onTargets}
            onAdd={(record) => onAdd('expenses', record)}
            onOpenTable={() => onOpenTable('expenses')}
            onOpenDay={onOpenDay}
          />
        )
      )
    }
    if (view === 'calories') {
      if (!calories) return null
      return (
        lacking('calories', calories.missing) || (
          <CaloriesPage
            today={today}
            meals={calories.meals}
            target={targets.calorieTarget}
            onTarget={(calorieTarget) => onTargets({ calorieTarget })}
            onAdd={(record) => onAdd('calories', record)}
            onOpenTable={() => onOpenTable('calories')}
            onOpenDay={onOpenDay}
          />
        )
      )
    }
    if (view === 'plan') {
      if (!plans) return null
      const { name, count, ...writes } = plan
      return lacking('plan', plans.missing) || <PlanPage today={today} count={count} rows={plans.rows} onOpenDay={onOpenDay} {...writes} />
    }
    if (view === 'apps') {
      if (!apps) return null
      return lacking('apps', apps.missing) || <AppsPage today={today} rows={apps.rows} counting={counting} onCounting={onCounting} onOpenDay={onOpenDay} />
    }
    if (!habits) return null
    return <HabitsPage today={today} habits={habits} onTick={tick} onAddHabit={onAddHabit} onError={onError} />
  }

  return (
    <>
      {header}
      {page()}
    </>
  )
}

/** Today across the trackers: what was spent and eaten against their targets, the habits to tick, and a row added from here. */
function TodayPage({
  today,
  expenses,
  meals,
  habits,
  money,
  currency,
  targets,
  onAdd,
  onTick,
  onView,
  onOpenTable,
}: {
  today: string
  /** Null where the tracker has no table yet. */
  expenses: readonly Expense[] | null
  meals: readonly Meal[] | null
  habits: Habits | null
  money: (value: number, decimals?: number) => string
  currency: string
  targets: Targets
  onAdd: (tracker: 'expenses' | 'calories', record: Record<string, string>) => void
  onTick: (day: string, habit: string, done: boolean) => void
  onView: (view: View) => void
  onOpenTable: (tracker: Tracker) => void
}) {
  const spentToday = expenses?.filter((one) => one.day === today) ?? []
  const month = expenses ? monthOf(expenses, today.slice(0, 7), today) : null
  const eaten = meals?.filter((one) => one.day === today) ?? []
  const kcal = eaten.reduce((sum, one) => sum + one.calories, 0)
  const done = habits?.names.filter((name) => habits.done.get(name)?.has(today)) ?? []
  return (
    <>
      <Tiles>
        {expenses && (
          <Tile figure={money(spentToday.reduce((sum, one) => sum + one.amount, 0))} name={`Spent today, ${countOf(spentToday.length, 'expense')}`} />
        )}
        {month && (
          <Tile
            figure={money(month.spent, 0)}
            name={targets.monthlyBudget ? `this month, of ${money(targets.monthlyBudget, 0)}` : 'this month'}
            share={targets.monthlyBudget ? month.spent / targets.monthlyBudget : null}
          />
        )}
        {meals && (
          <Tile
            figure={`${Math.round(kcal).toLocaleString()} kcal`}
            name={targets.calorieTarget ? `today, of ${targets.calorieTarget.toLocaleString()}` : 'today'}
            share={targets.calorieTarget ? kcal / targets.calorieTarget : null}
          />
        )}
        {habits && habits.names.length > 0 && <Tile figure={`${done.length} of ${habits.names.length}`} name="habits today" share={done.length / habits.names.length} />}
      </Tiles>
      {(!expenses || !meals || !habits) && (
        <Section title="Not set up" count={[expenses, meals, habits].filter((one) => !one).length} startOpen>
          {(['expenses', 'calories', 'habits'] as const)
            .filter((tracker) => !{ expenses, calories: meals, habits }[tracker])
            .map((tracker) => (
              <Line key={tracker} name={`Pick or make the ${tracker} table`} value="" onPress={() => onView(tracker)} />
            ))}
        </Section>
      )}
      {habits && habits.names.length > 0 && (
        <Section title="Habits today" count={habits.names.length - done.length} startOpen>
          {/* In a `div`: as the list item's own buttons, `.file-list li > button` made them full-width rows. */}
          <li style={{ paddingLeft: stepIn(1) }}>
            <div className="tracker-ticks">
              {habits.names.map((name) => {
                const on = done.includes(name)
                return (
                  <button key={name} className="tracker-tick" aria-pressed={on} onClick={() => onTick(today, name, !on)}>
                    {name}
                  </button>
                )
              })}
            </div>
          </li>
        </Section>
      )}
      {(expenses || meals) && (
        <Section title="Add" startOpen>
          <li style={{ paddingLeft: stepIn(1) }}>
            <div className="tracker-ticks">
              {expenses && <Adder label="Expense" fields={expenseFields(expenses, currency)} onAdd={(record) => onAdd('expenses', now(record))} />}
              {meals && <Adder label="Something eaten" fields={FOOD_FIELDS} onAdd={(record) => onAdd('calories', now(record))} />}
              <Usual meals={meals ?? []} onAdd={(record) => onAdd('calories', now(record))} />
            </div>
          </li>
        </Section>
      )}
      {(spentToday.length > 0 || eaten.length > 0) && (
        <Section title="Today" count={spentToday.length + eaten.length} startOpen>
          {[...spentToday]
            .reverse()
            .map((one, at) => (
              <Line
                key={`e${at}`}
                name={one.what || one.merchant || one.category || 'An expense'}
                detail={[one.time, one.what ? one.merchant : '', one.category].filter(Boolean).join(' · ')}
                value={money(one.amount)}
                onPress={() => onOpenTable('expenses')}
              />
            ))}
          {[...eaten]
            .reverse()
            .map((one, at) => (
              <Line key={`c${at}`} name={one.item || 'Something eaten'} detail={one.time} value={`${one.calories.toLocaleString()} kcal`} onPress={() => onOpenTable('calories')} />
            ))}
        </Section>
      )}
    </>
  )
}

/**
 * A month of expenses at a glance, stepped back and on: what was spent against the
 * month before over the same days and against the budget, a day's average and the
 * count; by category against each one's budget; the last weeks; day by day; where;
 * each account's balance; the month's expenses; one added; and the budgets.
 */
function ExpensesPage({
  today,
  expenses,
  all,
  money,
  currency,
  targets,
  onTargets,
  onAdd,
  onOpenTable,
  onOpenDay,
}: {
  today: string
  /** In the one currency added up. */
  expenses: readonly Expense[]
  /** All of them, for each account's balance in its own currency. */
  all: readonly Expense[]
  money: (value: number, decimals?: number) => string
  currency: string
  targets: Targets
  onTargets: (targets: Partial<Targets>) => void
  onAdd: (record: Record<string, string>) => void
  onOpenTable: () => void
  onOpenDay: (day: string) => void
}) {
  const [shown, setShown] = useState(today.slice(0, 7))
  const data = useMemo(() => monthOf(expenses, shown, today), [expenses, shown, today])
  const first = expenses[0]?.day.slice(0, 7) ?? shown
  const last = [today.slice(0, 7), expenses.at(-1)?.day.slice(0, 7) ?? ''].sort().at(-1)!
  const thisMonth = shown === today.slice(0, 7)
  const before = data.before === null || data.before === 0 ? null : (data.spent - data.before) / data.before
  const previous = dayDate(`${monthAfter(shown, -1)}-01`)
  const beforeLabel =
    thisMonth && data.days < data.daily.length
      ? `than ${shortDate.formatRange(previous, new Date(previous.getFullYear(), previous.getMonth(), data.days))}`
      : `than ${monthOnly.format(previous)}`
  const budgetOf = (category: string) =>
    Object.entries(targets.categoryBudgets).find(([name]) => name.toLowerCase() === category.toLowerCase())?.[1]
  const weeks = weeksBack(today, firstWeekday(), WEEKS)
  const weekly = perWeek(
    expenses.map((one) => ({ day: one.day, n: one.amount })),
    weeks
  )
  const categories = [...new Set(expenses.map((one) => one.category).filter(Boolean))].sort()
  const dayAt = (at: number) => `${shown}-${String(at + 1).padStart(2, '0')}`

  return (
    <>
      <div className="tracker-controls">
        <span className="month-step" role="group" aria-label="Month">
          <button className="header-action back" aria-label="The month before" disabled={shown <= first} onClick={() => setShown(monthAfter(shown, -1))}>
            <ChevronIcon open={false} />
          </button>
          <span className="month-step-name">{monthName.format(dayDate(`${shown}-01`))}</span>
          <button className="header-action" aria-label="The month after" disabled={shown >= last} onClick={() => setShown(monthAfter(shown, 1))}>
            <ChevronIcon open={false} />
          </button>
        </span>
      </div>
      <Tiles>
        <Tile
          figure={money(data.spent)}
          name={targets.monthlyBudget ? `Spent, of ${money(targets.monthlyBudget, 0)}` : 'Spent'}
          share={targets.monthlyBudget ? data.spent / targets.monthlyBudget : null}
        />
        {before !== null && (
          <Tile
            figure={`${Math.round(Math.abs(before) * 100)}% ${before >= 0 ? 'more' : 'less'}`}
            name={beforeLabel}
          />
        )}
        <Tile figure={money(data.spent / data.days)} name={`A day, over ${countOf(data.days, 'day')}`} />
        <Tile figure={data.expenses.length} name={data.expenses.length === 1 ? 'Expense' : 'Expenses'} />
      </Tiles>
      {data.expenses.length > 0 && (
        <>
          <Section title="By category" count={data.categories.length} startOpen>
            <Box>
              <Bars
                rows={data.categories.map((one) => ({ name: one.name || 'No category', value: one.spent, limit: budgetOf(one.name), share: one.spent / data.spent }))}
                figure={(value) => money(value, 0)}
              />
            </Box>
          </Section>
          <Section title="Day by day" count={data.daily.filter((one) => one > 0).length} startOpen>
            <Box>
              <Columns
                values={data.daily}
                says={(at) => `${shortDay(dayAt(at), today)}: ${money(data.daily[at])}`}
                axis={(at) => (at === 0 || (at + 1) % 7 === 0 ? String(at + 1) : '')}
                current={thisMonth ? Number(today.slice(8)) - 1 : undefined}
                onPress={(at) => onOpenDay(dayAt(at))}
                pressable={(at) => dayAt(at) <= today}
              />
            </Box>
          </Section>
        </>
      )}
      <Section title="The last weeks" count={weekly.filter((one) => one > 0).length} startOpen>
        <Box>
          <Columns
            values={weekly}
            says={(at) => `Week of ${shortDate.format(dayDate(weeks[at]))}: ${money(weekly[at], 0)}`}
            axis={(at) => ((WEEKS - 1 - at) % 4 === 0 ? shortDate.format(dayDate(weeks[at])) : '')}
            current={WEEKS - 1}
            target={targets.monthlyBudget ? (targets.monthlyBudget * 12) / 52 : undefined}
          />
        </Box>
      </Section>
      {data.merchants.length > 0 && (
        <Section title="Where" count={data.merchants.length} startOpen>
          {data.merchants.map((one) => (
            <Line key={one.name} name={one.name} detail={one.count === 1 ? '' : `${one.count} times`} value={money(one.spent)} onPress={onOpenTable} />
          ))}
        </Section>
      )}
      <Accounts expenses={all} until={thisMonth ? today : `${shown}-31`} today={today} onOpenTable={onOpenTable} />
      <Section title="Add" startOpen>
        <li style={{ paddingLeft: stepIn(1) }}>
          <div className="tracker-ticks">
            <Adder label="Expense" fields={expenseFields(expenses, currency)} onAdd={(record) => onAdd(now(record))} />
          </div>
        </li>
      </Section>
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
                onPress={onOpenTable}
              />
            ))
        )}
      </Section>
      <Section title="Budgets" count={Object.keys(targets.categoryBudgets).length + (targets.monthlyBudget ? 1 : 0)} startOpen={false}>
        <li className="tracker-amounts" style={{ paddingLeft: stepIn(1) }}>
          <AmountField label="A month" value={targets.monthlyBudget} onChange={(monthlyBudget) => onTargets({ monthlyBudget })} />
          {categories.map((category) => (
            <AmountField
              key={category}
              label={category}
              value={budgetOf(category) ?? 0}
              onChange={(amount) => {
                const rest = Object.fromEntries(Object.entries(targets.categoryBudgets).filter(([name]) => name.toLowerCase() !== category.toLowerCase()))
                onTargets({ categoryBudgets: amount ? { ...rest, [category]: amount } : rest })
              }}
            />
          ))}
        </li>
      </Section>
    </>
  )
}

/** Each account's balance after its last expense up to the month's end, as its row said. */
function Accounts({ expenses, until, today, onOpenTable }: { expenses: readonly Expense[]; until: string; today: string; onOpenTable: () => void }) {
  const balances = balancesOf(expenses, until)
  if (balances.length === 0) return null
  return (
    <Section title="Accounts" count={balances.length} startOpen>
      {balances.map((one) => {
        const currency = expenses.findLast((expense) => expense.account === one.account)?.currency ?? ''
        return (
          <Line key={one.account} name={one.account} detail={`after ${shortDay(one.day, today)}`} value={moneyText(one.balance, currency)} onPress={onOpenTable} />
        )
      })}
    </Section>
  )
}

/** Calories: today against the target, the last days, what is eaten often, today's, and something added. */
/**
 * The time in each app, as the Mac counted it (`useAppTime`): today's and the last seven
 * days', each app a bar, and the last days as columns, a press opening the day. Counted
 * only while a key or a press was made in the last two minutes, and written every five.
 */
function AppsPage({
  today,
  rows,
  counting,
  onCounting,
  onOpenDay,
}: {
  today: string
  rows: readonly AppTime[]
  counting: boolean
  onCounting: (on: boolean) => void
  onOpenDay: (day: string) => void
}) {
  const days = daysBack(today, DAYS)
  const daily = perDay(
    rows.map((one) => ({ day: one.day, n: one.minutes })),
    days
  )
  const todays = minutesByApp(rows, new Set([today]))
  const week = minutesByApp(rows, new Set(days.slice(-7)))
  const sum = (list: readonly { minutes: number }[]) => list.reduce((total, one) => total + one.minutes, 0)
  const bars = (list: readonly { app: string; minutes: number }[]) => (
    <Box>
      <Bars rows={list.slice(0, 12).map((one) => ({ name: one.app, value: one.minutes, share: one.minutes / sum(list) }))} figure={hoursText} />
    </Box>
  )
  return (
    <>
      <div className="tracker-controls">
        <button className="header-action" aria-pressed={counting} onClick={() => onCounting(!counting)}>
          {counting ? 'Counting' : 'Not counting'}
        </button>
      </div>
      <Tiles>
        <Tile figure={hoursText(sum(todays))} name="in apps today" />
        <Tile figure={hoursText(sum(week))} name="the last seven days" />
      </Tiles>
      <Section title="Today" count={todays.length} startOpen>
        {todays.length === 0 ? <EmptyRow text={counting ? 'Nothing written yet today: the minutes are written every five.' : 'Not counting.'} /> : bars(todays)}
      </Section>
      <Section title="The last days" count={daily.filter((one) => one > 0).length} startOpen>
        <Box>
          <Columns
            values={daily}
            says={(at) => `${shortDay(days[at], today)}: ${hoursText(daily[at])}`}
            axis={(at) => ((DAYS - 1 - at) % 7 === 0 ? shortDate.format(dayDate(days[at])) : '')}
            current={DAYS - 1}
            onPress={(at) => onOpenDay(days[at])}
          />
        </Box>
      </Section>
      <Section title="The last seven days" count={week.length} startOpen>
        {week.length === 0 ? <EmptyRow text="Nothing counted in the last seven days." /> : bars(week)}
      </Section>
    </>
  )
}

function CaloriesPage({
  today,
  meals,
  target,
  onTarget,
  onAdd,
  onOpenTable,
  onOpenDay,
}: {
  today: string
  meals: readonly Meal[]
  target: number
  onTarget: (target: number) => void
  onAdd: (record: Record<string, string>) => void
  onOpenTable: () => void
  onOpenDay: (day: string) => void
}) {
  const days = daysBack(today, DAYS)
  const rows = meals.map((one) => ({ day: one.day, n: one.calories }))
  const daily = perDay(rows, days)
  const kcal = (value: number) => `${Math.round(value).toLocaleString()} kcal`
  // Days with nothing written are days not tracked, not days of nothing eaten.
  const tracked = daily.slice(-7, -1).filter((one) => one > 0)
  const week = tracked.length ? tracked.reduce((sum, one) => sum + one, 0) / tracked.length : null
  const kept = target ? daily.slice(0, -1).filter((one) => one > 0 && one <= target).length : null
  const eaten = meals.filter((one) => one.day === today)
  return (
    <>
      <div className="tracker-controls">
        <AmountField label="A day’s target, kcal" value={target} onChange={onTarget} />
      </div>
      <Tiles>
        <Tile figure={kcal(daily.at(-1)!)} name={target ? `today, of ${target.toLocaleString()}` : 'today'} share={target ? daily.at(-1)! / target : null} />
        {week !== null && <Tile figure={kcal(week)} name={`a day, over the ${countOf(tracked.length, 'day')} tracked this week`} />}
        {kept !== null && <Tile figure={`${kept} of ${daily.slice(0, -1).filter((one) => one > 0).length}`} name="days tracked kept to the target" />}
      </Tiles>
      <Section title="The last days" count={daily.filter((one) => one > 0).length} startOpen>
        <Box>
          <Columns
            values={daily}
            says={(at) => `${shortDay(days[at], today)}: ${kcal(daily[at])}`}
            axis={(at) => ((DAYS - 1 - at) % 7 === 0 ? shortDate.format(dayDate(days[at])) : '')}
            current={DAYS - 1}
            target={target || undefined}
            onPress={(at) => onOpenDay(days[at])}
          />
        </Box>
      </Section>
      <Section title="Add" startOpen>
        <li style={{ paddingLeft: stepIn(1) }}>
          <div className="tracker-ticks">
            <Adder label="Something eaten" fields={FOOD_FIELDS} onAdd={(record) => onAdd(now(record))} />
            <Usual meals={meals} onAdd={(record) => onAdd(now(record))} />
          </div>
        </li>
      </Section>
      <Section title="Today" count={eaten.length} startOpen>
        {eaten.length === 0 ? (
          <EmptyRow text="Nothing written for today yet." />
        ) : (
          [...eaten].reverse().map((one, at) => <Line key={at} name={one.item || 'Something eaten'} detail={one.time} value={kcal(one.calories)} onPress={onOpenTable} />)
        )}
      </Section>
    </>
  )
}

/**
 * Habits: each a row of the last weeks' days, ticked where done, with its streak and
 * this week's count, and the weeks before as a share done. A press on a day writes the
 * tick into the table, or takes it back; + adds a habit as a column.
 */
function HabitsPage({
  today,
  habits,
  onTick,
  onAddHabit,
  onError,
}: {
  today: string
  habits: Habits
  onTick: (day: string, habit: string, done: boolean) => void
  onAddHabit: (name: string) => void
  onError: (message: string) => void
}) {
  const days = habitDays(today, firstWeekday(), GRID_WEEKS)
  const thisWeek = days.slice(-7).filter((day) => day <= today)
  const [adding, setAdding] = useState<string | null>(null)
  // Today in sight: the grid opens at its end, as the timeline does.
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth
  }, [habits.names.length])
  const weeks = weeksBack(today, firstWeekday(), WEEKS)
  /** Each week's share of its days' habits done, up to today. */
  const share = weeks.map((from) => {
    const week = Array.from({ length: 7 }, (_, at) => daysAfter(from, at)).filter((day) => day <= today)
    const done = habits.names.reduce((sum, name) => sum + week.filter((day) => habits.done.get(name)?.has(day)).length, 0)
    return week.length ? done / (week.length * habits.names.length) : 0
  })

  /** A typed habit added as a column; one already there keeps the field and says so. */
  function add() {
    const name = (adding ?? '').trim()
    if (habits.names.some((one) => one.toLowerCase() === name.toLowerCase())) return onError(`There is a habit called ${name} already.`)
    setAdding(null)
    if (name) onAddHabit(name)
  }

  return (
    <>
      <Section
        title="Habits"
        count={habits.names.length}
        startOpen
        actions={<AddButton label="Add a habit" onPress={() => setAdding((was) => was ?? '')} />}
      >
        {adding !== null && (
          <li style={{ paddingLeft: stepIn(1) }}>
            <NameField value={adding} placeholder="Habit…" onChange={setAdding} onSubmit={add} onCancel={() => setAdding(null)} onBlur={() => setAdding(null)} />
          </li>
        )}
        {habits.names.length === 0 ? (
          adding === null && <EmptyRow text="No habits yet: + adds one." />
        ) : (
          <li className="habit-box">
            <div className="habit-scroll" ref={scroller}>
              <table className="habit-table">
                <thead>
                  <tr>
                    <th />
                    {Array.from({ length: GRID_WEEKS }, (_, week) => (
                      <th key={week} colSpan={7} className="habit-week">
                        {shortDate.format(dayDate(days[week * 7]))}
                      </th>
                    ))}
                    <th className="habit-figure">Streak</th>
                    <th className="habit-figure">This week</th>
                  </tr>
                  <tr>
                    <th />
                    {days.map((day, at) => (
                      <th key={day} className={at % 7 === 0 ? 'habit-weekday week-start' : 'habit-weekday'} aria-current={day === today ? 'date' : undefined}>
                        {narrowWeekday.format(dayDate(day))}
                      </th>
                    ))}
                    <th />
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {habits.names.map((name) => {
                    const done = habits.done.get(name) ?? new Set<string>()
                    const streak = streakOf(done, today)
                    return (
                      <tr key={name}>
                        <th scope="row" className="habit-name">
                          {name}
                        </th>
                        {days.map((day, at) => {
                          const on = done.has(day)
                          const date = dayDate(day)
                          return (
                            <td key={day} className={at % 7 === 0 ? 'week-start' : undefined}>
                              <button
                                className="habit-day"
                                aria-pressed={on}
                                aria-current={day === today ? 'date' : undefined}
                                aria-label={`${name}, ${weekdayName.format(date)} ${shortDate.format(date)}`}
                                // A day not yet here is not done or undone.
                                disabled={day > today}
                                onClick={() => onTick(day, name, !on)}
                              />
                            </td>
                          )
                        })}
                        <td className="habit-figure">{streak > 0 ? countOf(streak, 'day') : ''}</td>
                        <td className="habit-figure">
                          {thisWeek.filter((day) => done.has(day)).length} of {thisWeek.length}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </li>
        )}
      </Section>
      {habits.names.length > 0 && (
        <Section title="The last weeks" count={share.filter((one) => one > 0).length} startOpen>
          <Box>
            <Columns
              values={share.map((one) => Math.round(one * 100))}
              says={(at) => `Week of ${shortDate.format(dayDate(weeks[at]))}: ${Math.round(share[at] * 100)}% done`}
              axis={(at) => ((WEEKS - 1 - at) % 4 === 0 ? shortDate.format(dayDate(weeks[at])) : '')}
              current={WEEKS - 1}
            />
          </Box>
        </Section>
      )}
    </>
  )
}

/** What is eaten often, each a chip that adds it again at what it usually comes to. */
function Usual({ meals, onAdd }: { meals: readonly Meal[]; onAdd: (record: Record<string, string>) => void }) {
  return (
    <>
      {usualItems(meals, USUAL).map((one) => {
        const each = Math.round(one.calories / one.times)
        return (
          <button key={one.item} className="tracker-tick" onClick={() => onAdd({ item: one.item, calories: String(each) })}>
            + {one.item} · {each}
          </button>
        )
      })}
    </>
  )
}

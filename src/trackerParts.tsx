// The parts the tracker pages are made of: tiles, lines, column and bar charts, a field
// for a target, a form that adds a row, and the question of which table to read. One
// series, one colour (`--mark`); the words stay in the text's tones.

import { useState, type ReactNode } from 'react'
import type { Meal } from './calories'
import { moneyText, type Expense } from './expenses'
import { localDateStamp, localTimeStamp } from './clock'
import { countOf, EmptyRow, NoteRow, READING, RowIcon, Section, stepIn } from './rows'
import type { Tracker } from './trackers'
import { folderOf, type VaultFile } from './vaultModel'

/** A row of figures, each its number over what it is, with a bar beneath when it is a share of a target. */
export function Tiles({ children }: { children: ReactNode }) {
  return <ul className="day-totals tracker-tiles">{children}</ul>
}

export function Tile({ figure, name, share }: { figure: ReactNode; name: ReactNode; share?: number | null }) {
  return (
    <li className="day-total" data-over={share != null && share > 1 ? '' : undefined}>
      <span className="day-total-number">{figure}</span>
      <span className="day-total-name">{name}</span>
      {share != null && (
        <span className="tracker-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
          <span style={{ width: `${Math.min(share, 1) * 100}%` }} />
        </span>
      )}
    </li>
  )
}

/** A line of a list: what, a word on it, and its figure on the right. Pressed, it does what the caller says. */
export function Line({ name, detail, value, onPress, depth = 1 }: { name: string; detail?: string; value: string; onPress: () => void; depth?: number }) {
  return (
    <li style={{ paddingLeft: stepIn(depth) }}>
      <button className="tracker-line" onClick={onPress}>
        <span className="tracker-line-name">{name}</span>
        {detail && <span className="tracker-line-detail">{detail}</span>}
        <span className="tracker-figure">{value}</span>
      </button>
    </li>
  )
}

/** A section's chart on the raised ground of a box, as the habits' grid is. */
export const Box = ({ children }: { children: ReactNode }) => <li className="tracker-box">{children}</li>

/**
 * Columns, one a day or a week, as tall as their figure, standing on one line, a target
 * drawn across them where there is one. The line above says the highest, or the column
 * pointed at; a press does what the caller says.
 */
export function Columns({
  values,
  says,
  axis,
  current,
  target,
  onPress,
  pressable = () => true,
}: {
  values: readonly number[]
  /** What a column says when pointed at, and to a screen reader. */
  says: (at: number) => string
  /** A column's mark on the axis below, or nothing. */
  axis: (at: number) => string
  /** The column that is now: today, this week. */
  current?: number
  target?: number
  onPress?: (at: number) => void
  pressable?: (at: number) => boolean
}) {
  const [pointed, setPointed] = useState<number | null>(null)
  const top = Math.max(...values, target ?? 0)
  const most = values.indexOf(Math.max(...values))
  const columns = { gridTemplateColumns: `repeat(${values.length}, 1fr)` }
  return (
    <>
      <p className="tracker-readout" aria-live="polite">
        {pointed === null ? `Highest: ${says(most)}` : says(pointed)}
      </p>
      <div className="tracker-columns" style={columns} onPointerLeave={() => setPointed(null)}>
        {target ? <span className="tracker-target" style={{ bottom: `${(target / top) * 100}%` }} aria-hidden /> : null}
        {values.map((value, at) => (
          <button
            key={at}
            className="tracker-column"
            aria-label={says(at)}
            aria-current={at === current ? 'true' : undefined}
            data-over={target && value > target ? '' : undefined}
            disabled={!onPress || !pressable(at)}
            onPointerEnter={() => setPointed(at)}
            onFocus={() => setPointed(at)}
            onBlur={() => setPointed(null)}
            onClick={() => onPress?.(at)}
          >
            {value > 0 && <span className="tracker-column-bar" style={{ height: `${(value / top) * 100}%` }} />}
          </button>
        ))}
      </div>
      <div className="tracker-axis" style={columns} aria-hidden>
        {values.map((_, at) => (
          <span key={at}>{axis(at)}</span>
        ))}
      </div>
    </>
  )
}

/** Bars, one a row: its name, a bar as long as its figure beside the most, the figure and its share, and its limit marked where it has one. */
export function Bars({ rows, figure }: { rows: readonly { name: string; value: number; limit?: number; share?: number }[]; figure: (value: number) => string }) {
  const top = Math.max(...rows.map((row) => Math.max(row.value, row.limit ?? 0)))
  return (
    <ul className="tracker-bars">
      {rows.map((row) => (
        <li key={row.name}>
          <span className="tracker-bar-name">{row.name}</span>
          <span className="tracker-bar-track">
            <span className="tracker-bar" data-over={row.limit && row.value > row.limit ? '' : undefined} style={{ width: `${(row.value / top) * 100}%` }} />
            {row.limit ? <span className="tracker-limit" style={{ left: `${(row.limit / top) * 100}%` }} aria-hidden /> : null}
          </span>
          <span className="tracker-figure">{figure(row.value)}</span>
          <span className="tracker-share">{row.limit ? `of ${figure(row.limit)}` : row.share != null ? `${Math.round(row.share * 100)}%` : ''}</span>
        </li>
      ))}
    </ul>
  )
}

/** A number the owner sets (a target, a budget), written when it is left or Enter is pressed; emptied, it is none. */
export function AmountField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const [typed, setTyped] = useState<string | null>(null)
  const commit = () => {
    if (typed === null) return
    const read = Number(typed.trim() || 0)
    setTyped(null)
    if (Number.isFinite(read) && read >= 0 && read !== value) onChange(read)
  }
  return (
    <label className="tracker-amount">
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={typed ?? (value ? String(value) : '')}
        placeholder="none"
        onChange={(event) => setTyped(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && commit()}
      />
    </label>
  )
}

export interface FormField {
  name: string
  label: string
  /** A number: typed with the number pad, and needed. */
  number?: boolean
  /** Needed, as a number is. */
  needed?: boolean
  /** What it may be, offered as it is typed. */
  offered?: readonly string[]
  /** What it starts as. */
  start?: string
}

/** The fields an expense is added with, offered what the table already says. */
export function expenseFields(expenses: readonly Expense[], currency: string): FormField[] {
  const known = (key: 'category' | 'merchant' | 'account') => [...new Set(expenses.map((one) => one[key]).filter(Boolean))].sort()
  return [
    { name: 'amount', label: 'Amount', number: true },
    { name: 'what', label: 'For' },
    { name: 'category', label: 'Category', offered: known('category') },
    { name: 'merchant', label: 'Where', offered: known('merchant') },
    { name: 'account', label: 'Account', offered: known('account') },
    { name: 'currency', label: 'Currency', start: currency },
  ]
}

export const FOOD_FIELDS: FormField[] = [
  { name: 'item', label: 'What', needed: true },
  { name: 'calories', label: 'kcal', number: true },
]

/** A row added now: today's day and the clock, then what was typed. */
export const now = (record: Record<string, string>) => ({ day: localDateStamp(), time: localTimeStamp(), ...record })

/**
 * A row typed on the page and added to its table: each field as named, Add written when
 * what is needed is there, the fields emptied after but for what they started as.
 */
export function AddForm({ label, fields, onAdd }: { label: string; fields: readonly FormField[]; onAdd: (record: Record<string, string>) => void }) {
  const fresh = () => Object.fromEntries(fields.map((field) => [field.name, field.start ?? '']))
  const [values, setValues] = useState<Record<string, string>>(fresh)
  const ready = fields.every((field) => !(field.needed || field.number) || (values[field.name] ?? '').trim() !== '') &&
    fields.every((field) => !field.number || !values[field.name] || Number.isFinite(Number(values[field.name])))
  const add = () => {
    if (!ready) return
    onAdd(Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value.trim()])))
    setValues(fresh())
  }
  return (
    <form
      className="tracker-form"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault()
        add()
      }}
    >
      {fields.map((field) => (
        <label key={field.name} className={field.number ? 'tracker-field tracker-field-number' : 'tracker-field'}>
          <span>{field.label}</span>
          <input
            aria-label={field.label}
            inputMode={field.number ? 'decimal' : undefined}
            list={field.offered?.length ? `${label}-${field.name}` : undefined}
            value={values[field.name] ?? ''}
            onChange={(event) => {
              const typed = event.currentTarget.value
              setValues((was) => ({ ...was, [field.name]: typed }))
            }}
          />
          {field.offered?.length ? (
            <datalist id={`${label}-${field.name}`}>
              {field.offered.map((one) => (
                <option key={one} value={one} />
              ))}
            </datalist>
          ) : null}
        </label>
      ))}
      <button className="header-action" type="submit" disabled={!ready}>
        Add
      </button>
    </form>
  )
}

/**
 * Which table a tracker reads: the vault's tables to pick from, and one to make with
 * the tracker's columns. Asked the first time, when it is gone, and when the owner
 * asks to change it.
 */
export function TablePicker({
  question,
  tables,
  picked,
  reading,
  make,
  onPick,
  onMake,
}: {
  question: string
  tables: readonly VaultFile[]
  picked: string
  reading: boolean
  /** The table to make, by the path it would have. */
  make: string
  onPick: (path: string) => void
  onMake: () => void
}) {
  return (
    <Section title={question} count={tables.length} startOpen>
      {tables.length === 0 && reading ? (
        <EmptyRow text={READING} />
      ) : (
        tables.map((table) => (
          <li key={table.path} style={{ paddingLeft: stepIn(1) }}>
            <NoteRow
              icon={<RowIcon icon="chart" />}
              name={table.name}
              className={table.path === picked ? 'selected' : undefined}
              aria-pressed={table.path === picked}
              trailing={<span className="row-count">{folderOf(table.path)}</span>}
              onClick={() => onPick(table.path)}
            />
          </li>
        ))
      )}
      {!tables.some((table) => table.path === make) && (
        <li style={{ paddingLeft: stepIn(1) }}>
          <NoteRow icon={<RowIcon icon="pen" />} name={`Make ${make}`} onClick={onMake} />
        </li>
      )}
    </Section>
  )
}

/** A day as the trackers' tables have it: null where a tracker has no table. */
export interface TrackedDay {
  expenses: readonly Expense[] | null
  meals: readonly Meal[] | null
  habits: readonly { name: string; done: boolean }[] | null
  /** The currency the day's expenses are added up in. */
  currency: string
  calorieTarget: number
}

/**
 * The end of a day's note: what the trackers' tables hold for that day, so what was
 * written in the note and is not here has not been put in a table yet. Read only; a
 * line opens its table.
 */
export function TrackedSection({ day, onOpenTable }: { day: TrackedDay; onOpenTable: (tracker: Tracker) => void }) {
  const { expenses, meals, habits, currency, calorieTarget } = day
  if (!expenses && !meals && !habits) return null
  const spent = expenses?.filter((one) => one.currency === currency).reduce((sum, one) => sum + one.amount, 0) ?? 0
  const kcal = meals?.reduce((sum, one) => sum + one.calories, 0) ?? 0
  const done = habits?.filter((one) => one.done).length ?? 0
  const none = 'none in the table yet'
  return (
    <Section title="Tracked" count={(expenses?.length ?? 0) + (meals?.length ?? 0) + done} startOpen>
      {expenses && (
        <>
          <Line name="Expenses" detail={expenses.length ? countOf(expenses.length, 'expense') : none} value={expenses.length ? moneyText(spent, currency) : ''} onPress={() => onOpenTable('expenses')} />
          {expenses.map((one, at) => (
            <Line
              key={at}
              depth={2}
              name={one.what || one.merchant || one.category || 'An expense'}
              detail={[one.time, one.what ? one.merchant : '', one.category].filter(Boolean).join(' · ')}
              value={moneyText(one.amount, one.currency)}
              onPress={() => onOpenTable('expenses')}
            />
          ))}
        </>
      )}
      {meals && (
        <>
          <Line
            name="Calories"
            detail={meals.length ? countOf(meals.length, 'thing') + ' eaten' : none}
            value={meals.length ? `${kcal.toLocaleString()}${calorieTarget ? ` of ${calorieTarget.toLocaleString()}` : ''} kcal` : ''}
            onPress={() => onOpenTable('calories')}
          />
          {meals.map((one, at) => (
            <Line key={at} depth={2} name={one.item || 'Something eaten'} detail={one.time} value={`${one.calories.toLocaleString()} kcal`} onPress={() => onOpenTable('calories')} />
          ))}
        </>
      )}
      {habits && habits.length > 0 && (
        <>
          <Line name="Habits" detail={`${done} of ${habits.length}`} value="" onPress={() => onOpenTable('habits')} />
          <li style={{ paddingLeft: stepIn(2) }}>
            <div className="tracker-ticks">
              {habits.map((one) => (
                <span key={one.name} className="tracker-tick" aria-pressed={one.done}>
                  {one.done ? '✓ ' : ''}
                  {one.name}
                </span>
              ))}
            </div>
          </li>
        </>
      )}
    </Section>
  )
}

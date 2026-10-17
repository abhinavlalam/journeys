/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { dayDate, localDateStamp, monthName, shortDate, weekdayName } from '../clock'
import { monthAfter, moneyText } from '../expenses'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * Trackers: expenses, calories and habits, each a table, today first. A page reads its
 * table and writes to it a row at a time; each daily note ends with what the tables
 * hold for its day.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

const today = localDateStamp()
const month = today.slice(0, 7)
const before = monthAfter(month, -1)
const SETTINGS = '/v/.config/settings.json'
const EXPENSES = '/v/Trackers/spend.csv'
const CALORIES = '/v/Trackers/food.csv'
const HABITS = '/v/Trackers/habits.csv'
const spend = [
  'day,time,amount,currency,for,category,merchant,account,end-amount',
  `${before}-01,09:10,40,EUR,,Plants,Northwind Market,Harbour Card,960`,
  `${month}-01,08:00,12.5,EUR,fern,Plants,Northwind Market,Harbour Card,947.5`,
  `${today},13:00,30,EUR,lunch,Tea,Harbour Bistro,Harbour Card,917.5`,
  '',
].join('\n')
const food = ['day,time,item,calories', `${today},08:30,oats,320`, `${today},13:00,soup,250`, ''].join('\n')
const habits = ['day,water,stretch', `${today},1,`, ''].join('\n')
const tracked = { expenses: 'Trackers/spend.csv', calories: 'Trackers/food.csv', habits: 'Trackers/habits.csv' }

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  disk.write(EXPENSES, spend)
  disk.write(CALORIES, food)
  disk.write(HABITS, habits)
})

const viewer = () => within(document.querySelector('.viewer:not([hidden])') as HTMLElement)
/** A tile's figure, by the words under it. */
const tile = (name: string | RegExp) =>
  within(document.querySelector('.viewer:not([hidden]) .day-totals') as HTMLElement).getByText(name).previousElementSibling?.textContent

async function openTrackers(settings: Record<string, unknown> = { trackers: tracked }) {
  disk.write(SETTINGS, JSON.stringify(settings))
  const { default: App } = await import('../App')
  render(<App />)
  fireEvent.click(await screen.findByLabelText('Trackers'))
}
const show = (view: string) => fireEvent.click(within(viewer().getByRole('group', { name: 'View' })).getByRole('button', { name: view }))
/** Opens a form from its chip, fills it, and adds the row. */
const fill = (form: string, values: Record<string, string>) => {
  fireEvent.click(viewer().getByRole('button', { name: `+ ${form}` }))
  const it = viewer().getByRole('form', { name: form })
  for (const [label, value] of Object.entries(values)) fireEvent.change(within(it).getByLabelText(label), { target: { value } })
  fireEvent.click(within(it).getByRole('button', { name: 'Add' }))
}

describe('today', () => {
  it('says what was spent and eaten against the targets, and ticks a habit into its table', async () => {
    await openTrackers({ trackers: tracked, calorieTarget: 2000, monthlyBudget: 1000 })
    await waitFor(() => expect(tile('today, of 2,000')).toBe('570 kcal'))
    expect(tile(/^Spent today/)).toBe(moneyText(30, 'EUR'))
    expect(tile('this month, of ' + moneyText(1000, 'EUR', 0))).toBe(moneyText(42.5, 'EUR', 0))
    expect(tile('habits today')).toBe('1 of 2')
    fireEvent.click(viewer().getByRole('button', { name: 'stretch' }))
    await waitFor(() => expect(disk.read(HABITS)).toBe(habits.replace(`${today},1,`, `${today},1,1`)))
    await waitFor(() => expect(tile('habits today')).toBe('2 of 2'))
  })

  /** Typed on the page, a row goes into the table now, in the table's own columns. */
  it('adds an expense and something eaten as rows of their tables, stamped now', async () => {
    await openTrackers()
    await waitFor(() => expect(viewer().getByRole('button', { name: '+ Expense' })).toBeTruthy())
    fill('Expense', { Amount: '7.5', For: 'tea', Category: 'Tea' })
    await waitFor(() => expect(disk.read(EXPENSES)).toMatch(new RegExp(`\\n${today},\\d\\d:\\d\\d,7\\.5,EUR,tea,Tea,,,\\n$`)))
    fill('Something eaten', { What: 'rice, dal', kcal: '540' })
    await waitFor(() => expect(disk.read(CALORIES)).toMatch(new RegExp(`\\n${today},\\d\\d:\\d\\d,"rice, dal",540\\n$`)))
    // What is eaten often is offered again, at what it usually comes to.
    fireEvent.click(await waitFor(() => viewer().getByRole('button', { name: '+ oats · 320' })))
    await waitFor(() => expect(disk.read(CALORIES)).toMatch(new RegExp(`\\n${today},\\d\\d:\\d\\d,oats,320\\n$`)))
  })
})

describe('a tracker’s table', () => {
  /** Asked the first time: a table of the vault's, or one made with the tracker's columns. */
  it('is picked, or made with its columns beside the others', async () => {
    await openTrackers({ trackers: { expenses: tracked.expenses } })
    show('Calories')
    fireEvent.click(await waitFor(() => viewer().getByText('Make Trackers/calories.csv')))
    await waitFor(() => expect(disk.read('/v/Trackers/calories.csv')).toBe('day,time,item,calories,notes\n'))
    await waitFor(() => expect(JSON.parse(disk.read(SETTINGS)!).trackers.calories).toBe('Trackers/calories.csv'))
    show('Habits')
    fireEvent.click(await waitFor(() => viewer().getByText('habits.csv')))
    await waitFor(() => expect(JSON.parse(disk.read(SETTINGS)!).trackers.habits).toBe('Trackers/habits.csv'))
  })
})

describe('expenses', () => {
  it('shows a month against its budget and the month before, and steps back', async () => {
    await openTrackers({ trackers: tracked, monthlyBudget: 100, categoryBudgets: { Tea: 20 } })
    show('Expenses')
    await waitFor(() => expect(tile('Spent, of ' + moneyText(100, 'EUR', 0))).toBe(moneyText(42.5, 'EUR')))
    // A category past its budget says so beside its bar.
    const tea = viewer().getByText('Tea').closest('li')!
    expect(tea.textContent).toContain(`of ${moneyText(20, 'EUR', 0)}`)
    expect(tea.querySelector('.tracker-bar')!.hasAttribute('data-over')).toBe(true)
    fireEvent.click(viewer().getByRole('button', { name: 'The month before' }))
    expect(viewer().getByText(monthName.format(dayDate(`${before}-01`)))).toBeTruthy()
    expect(tile(/^Spent/)).toBe(moneyText(40, 'EUR'))
  })

  it('keeps the budgets the page sets', async () => {
    await openTrackers()
    show('Expenses')
    fireEvent.click(await waitFor(() => viewer().getByText('Budgets')))
    const field = viewer().getByLabelText('A month')
    fireEvent.change(field, { target: { value: '450' } })
    fireEvent.blur(field)
    await waitFor(() => expect(JSON.parse(disk.read(SETTINGS)!).monthlyBudget).toBe(450))
    const plants = viewer().getByLabelText('Plants')
    fireEvent.change(plants, { target: { value: '60' } })
    fireEvent.keyDown(plants, { key: 'Enter' })
    await waitFor(() => expect(JSON.parse(disk.read(SETTINGS)!).categoryBudgets).toEqual({ Plants: 60 }))
  })
})

describe('calories', () => {
  it('shows today against the target, set on the page', async () => {
    await openTrackers()
    show('Calories')
    await waitFor(() => expect(tile('today')).toBe('570 kcal'))
    const target = viewer().getByLabelText('A day’s target, kcal')
    fireEvent.change(target, { target: { value: '500' } })
    fireEvent.blur(target)
    await waitFor(() => expect(JSON.parse(disk.read(SETTINGS)!).calorieTarget).toBe(500))
    await waitFor(() => expect(document.querySelector('.day-totals .day-total')!.hasAttribute('data-over')).toBe(true))
  })
})

describe('habits', () => {
  const cell = (habit: string, day: string) => {
    const date = dayDate(day)
    return viewer().getByRole('button', { name: `${habit}, ${weekdayName.format(date)} ${shortDate.format(date)}` })
  }

  it('ticks a day into the table and takes it back, and adds a habit as a column', async () => {
    await openTrackers()
    show('Habits')
    await waitFor(() => expect(cell('water', today).getAttribute('aria-pressed')).toBe('true'))
    fireEvent.click(cell('water', today))
    await waitFor(() => expect(disk.read(HABITS)).toBe(habits.replace(`${today},1,`, `${today},,`)))
    fireEvent.click(viewer().getByRole('button', { name: 'Add a habit' }))
    const field = viewer().getByRole('textbox')
    fireEvent.change(field, { target: { value: 'read' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(disk.read(HABITS)!.split('\n')[0]).toBe('day,water,stretch,read'))
  })
})

/** The time in each app, as the Mac counted it into its table. */
describe('apps', () => {
  it('shows today’s and the week’s time by app, and turns the counting off', async () => {
    disk.write('/v/Trackers/apps.csv', ['day,app,minutes', `${today},Mail,25`, `${today},Terminal,65`, ''].join('\n'))
    await openTrackers({ trackers: { ...tracked, apps: 'Trackers/apps.csv' } })
    show('Apps')
    await waitFor(() => expect(tile('in apps today')).toBe('1:30'))
    expect(tile('the last seven days')).toBe('1:30')
    expect(viewer().getAllByText('Terminal').length).toBeGreaterThan(0)
    fireEvent.click(viewer().getByRole('button', { name: 'Counting' }))
    await waitFor(() => expect(JSON.parse(disk.read(SETTINGS)!).trackApps).toBe(false))
    expect(viewer().getByRole('button', { name: 'Not counting' })).toBeTruthy()
  })
})

/** The day's plan, Today’s 8: one table, shown at the top of each daily note and in Trackers. */
describe('the day’s plan', () => {
  const PLAN = '/v/Trackers/plan.csv'
  const yesterday = () => localDateStamp(new Date(dayDate(today).getTime() - 86400000))
  const plan = () => ['day,thing,done', ...Array.from({ length: 8 }, (_, n) => `${yesterday()},thing ${n + 1},1`), `${today},call the ferry,1`, `${today},row the boat,`, ''].join('\n')
  const section = () => within(document.querySelector('.viewer:not([hidden]) .day-plan') as HTMLElement)

  async function openToday(settings: Record<string, unknown>) {
    disk.write(`/v/Daily/${today}.md`, '## Log\n\n## Notes\n')
    disk.write(SETTINGS, JSON.stringify(settings))
    const { default: App } = await import('../App')
    render(<App />)
    fireEvent.click(await screen.findByText('Daily'))
    fireEvent.click(await screen.findByText(today))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .day-plan')).toBeTruthy())
  }

  it('is shown at the top of the day’s note, ticked and added to in its table, the note left as it is', async () => {
    disk.write(PLAN, plan())
    await openToday({ trackers: { ...tracked, plan: 'Trackers/plan.csv' } })
    await waitFor(() => expect(section().getByText('row the boat')).toBeTruthy())
    expect(section().getByRole('checkbox', { name: 'call the ferry: done' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(section().getByRole('checkbox', { name: 'row the boat: done' }))
    await waitFor(() => expect(disk.read(PLAN)).toContain(`${today},row the boat,1`))
    const field = section().getByLabelText('Something to work on')
    expect(field.getAttribute('placeholder')).toBe('6 more things to work on')
    fireEvent.change(field, { target: { value: 'water the fern' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(disk.read(PLAN)).toMatch(new RegExp(`${today},water the fern,\\n$`)))
    expect(disk.read(`/v/Daily/${today}.md`)).toBe('## Log\n\n## Notes\n')
  })

  it('makes its table beside the others with the first thing', async () => {
    await openToday({ trackers: tracked })
    fireEvent.change(section().getByLabelText('Something to work on'), { target: { value: 'call the ferry' } })
    fireEvent.keyDown(section().getByLabelText('Something to work on'), { key: 'Enter' })
    await waitFor(() => expect(disk.read(PLAN)).toBe(`day,thing,done\n${today},call the ferry,\n`))
    await waitFor(() => expect(JSON.parse(disk.read(SETTINGS)!).trackers.plan).toBe('Trackers/plan.csv'))
  })

  it('has a page of its own in Trackers, and is a habit kept on the days all eight were done', async () => {
    disk.write(PLAN, plan())
    await openTrackers({ trackers: { ...tracked, plan: 'Trackers/plan.csv' } })
    show('Today’s 8')
    await waitFor(() => expect(tile('done today')).toBe('1 of 8'))
    expect(tile('days this month with all done')).toBe(yesterday().startsWith(month) ? '1 of 2' : '0 of 1')
    expect(tile('days in a row')).toBe('1')
    show('Habits')
    const date = dayDate(yesterday())
    await waitFor(() =>
      expect(viewer().getByRole('button', { name: `Today’s 8, ${weekdayName.format(date)} ${shortDate.format(date)}` }).getAttribute('aria-pressed')).toBe('true')
    )
  })
})

/** The end of a day's note: what the tables hold for it, so what is not there has not been put in a table yet. */
describe('a daily note', () => {
  it('ends with what the trackers hold for its day', async () => {
    disk.write(`/v/Daily/${today}.md`, 'lunch by the harbour, 30\n')
    disk.write(SETTINGS, JSON.stringify({ trackers: tracked, calorieTarget: 2000 }))
    const { default: App } = await import('../App')
    render(<App />)
    fireEvent.click(await screen.findByText('Daily'))
    fireEvent.click(await screen.findByText(today))
    const section = await waitFor(() => {
      const found = [...document.querySelectorAll('.viewer:not([hidden]) .note-section')].find((one) => one.textContent?.startsWith('Tracked'))
      expect(found).toBeTruthy()
      return within(found as HTMLElement)
    })
    expect(section.getByText('lunch')).toBeTruthy()
    expect(section.getByText(`570 of 2,000 kcal`)).toBeTruthy()
    expect(section.getByText('1 of 2')).toBeTruthy()
  })
})

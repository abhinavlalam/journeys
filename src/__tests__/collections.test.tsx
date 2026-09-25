/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * **A collection's row is not a file.**
 *
 * It was one — clicking `expense` wrote an empty
 * `.config/actions/collections/expense.md` — and an empty page named after a thing
 * is not the thing. What someone wants from `expense` is the lines of the vault
 * that say `--expense`, with whatever is written under each, and where they are.
 * The file is back as the collection's *declaration*: one line saying how its lines
 * are written, which is the second half of this file.
 *
 * So this drives the whole way through: a keyword in a note, a row in the pane, a
 * click, and the lines in the reading pane. `actions.test.ts` pins the gathering
 * and the declaration format; what is here is that the pane, the view and the disk
 * agree — in particular that opening one writes nothing.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
})

/** A journal page in the shape these are actually written in: the clock first, the
 *  keyword where the sentence puts it, and the detail nested under the line. */
const TUESDAY = [
  '# Tuesday',
  '',
  '09:42 --expense on [[Harbour Bistro]]',
  '  - amount:: 480',
  '  - paid by card',
  '10:00 - Making --feature-updates for [[Journeys]]',
  '',
].join('\n')

const WEDNESDAY = ['# Wednesday', '', '13:15 --expense at the airport', ''].join('\n')

/** The one file the structures live in — see `COLLECTIONS_FILE`. */
const STRUCTURES = '/v/.config/actions/collections.json'
const declaring = (structures: Record<string, string>) =>
  disk.write(
    STRUCTURES,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(structures).map(([name, structure]) => [name, { structure, fields: [] }])
      ),
      null,
      2
    )
  )

const pane = () => within(document.querySelector('.sidebar')!)
const viewer = () => within(document.querySelector('.viewer')!)
const collected = () => [...document.querySelectorAll('.collected-lines li')].map((li) => li.textContent)
/** The declared structure as the page draws it: one string, marked up in spans. */
const structure = () => document.querySelector('.collection-line-text')?.textContent

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

/** To a collection's rows: the section, then every group open. */
async function openCollections() {
  await waitFor(() => expect(pane().getByText('Collections')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Expand all actions'))
}

/** The title, and not `getByText('--expense')`: the keyword is marked wherever it
 *  appears now — in the structure and on every gathered line — so the name alone
 *  matches a dozen elements. */
const title = () => document.querySelector('.viewer-title')!.textContent

async function open(keyword: string) {
  await openCollections()
  await waitFor(() => expect(pane().getByText(keyword)).toBeTruthy())
  fireEvent.click(pane().getByText(keyword))
  await waitFor(() => expect(title()).toBe(`--${keyword}`))
}

describe('opening a collection', () => {
  /** A line nested under an entry reads as the note reads, the way a tag's page
   *  already read it: the two pages drew their lists separately, and this one
   *  showed the nested line's bytes. */
  it('reads a link in a nested line as its name', async () => {
    disk.write('/v/tuesday.md', ['09:42 --expense on lunch', '  - at [[Areas/Corner Shop]]', ''].join('\n'))
    await openApp()
    await open('expense')
    await waitFor(() => expect(collected()).toHaveLength(1))
    expect(collected()[0]).toBe(['09:42 --expense on lunch', '  - at Corner Shop'].join('\n'))
  })

  it('shows the lines that carry the keyword, with what is nested under them', async () => {
    disk.write('/v/tuesday.md', TUESDAY)
    await openApp()
    await open('expense')

    await waitFor(() => expect(collected()).toHaveLength(1))
    // The entry and its run as one block, the indent that says which line is under
    // which kept as written.
    // The entry is rendered the way the note renders it — a link reads as its name
    // — and the lines under it keep their indent.
    expect(collected()[0]).toBe(
      ['09:42 --expense on Harbour Bistro', '  - amount:: 480', '  - paid by card'].join('\n')
    )
    // The other keyword's line belongs to the other collection.
    expect(collected()[0]).not.toContain('feature-updates')
  })

  it('groups the lines by the note they are in, and names it', async () => {
    disk.write('/v/tuesday.md', TUESDAY)
    disk.write('/v/wednesday.md', WEDNESDAY)
    await openApp()
    await open('expense')

    await waitFor(() => expect(collected()).toHaveLength(2))
    expect(viewer().getByText('tuesday')).toBeTruthy()
    expect(viewer().getByText('wednesday')).toBeTruthy()
    expect(collected()[1]).toBe('13:15 --expense at the airport')
  })

  /** The count in the header is the lines, not the notes: what a collection holds
   *  is a number of lines. */
  it('counts the lines in the header', async () => {
    disk.write('/v/tuesday.md', TUESDAY)
    disk.write('/v/wednesday.md', WEDNESDAY)
    await openApp()
    await open('expense')
    await waitFor(() => expect(viewer().getByText('2 lines')).toBeTruthy())

    // One line reads as one line, because "1 lines" is the mark of a count nobody
    // looked at.
    await open('feature-updates')
    await waitFor(() => expect(viewer().getByText('1 line')).toBeTruthy())
  })

  /** **Nothing is written.** The version before this one created the file as the
   *  row was clicked, which is what put six empty pages in a real vault. */
  it('writes no file just for being opened', async () => {
    disk.write('/v/tuesday.md', TUESDAY)
    await openApp()
    await open('expense')
    await waitFor(() => expect(collected()).toHaveLength(1))
    // The structure is written when one is typed — not by clicking the row, which
    // is what left six empty pages in a vault.
    expect(disk.has(STRUCTURES)).toBe(false)
  })

  /** The row reads as selected the way an open file's row does — a collection has
   *  no path to compare, so the pane is told which one is open. */
  it('marks the row it opened', async () => {
    disk.write('/v/tuesday.md', TUESDAY)
    await openApp()
    await open('expense')
    await waitFor(() =>
      expect(pane().getByText('expense').closest('button')!.className).toContain('selected')
    )
  })

  /** The graph's own trade: the tree stays, the note pane becomes the view, and
   *  opening a note from it hands the pane back. */
  it('opens the note a line is in, and gives the pane back', async () => {
    disk.write('/v/tuesday.md', TUESDAY)
    await openApp()
    await open('expense')
    await waitFor(() => expect(viewer().getByText('tuesday')).toBeTruthy())

    fireEvent.click(viewer().getByText('tuesday'))
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())
    expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toContain('--expense')
    // The view is gone, not stacked behind the note.
    expect(document.querySelector('.collected-lines')).toBeNull()
  })

  it('says so when no line carries the keyword any more', async () => {
    disk.write('/v/tuesday.md', TUESDAY)
    await openApp()
    await open('expense')
    await waitFor(() => expect(collected()).toHaveLength(1))

    // The lines went while the view was open — the vault is re-read on focus.
    disk.write('/v/tuesday.md', '# Tuesday\n')
    fireEvent.focus(window)
    await waitFor(() => expect(viewer().getByText('No line carries this yet.')).toBeTruthy())
  })
})

/**
 * **The declaration**: one line at the top of the page saying how this
 * collection's lines are written, and the line `--expense` completes to in a note.
 * One string, two places — the page that defines the shape and the popup that
 * writes it cannot disagree, because there is only one of it.
 */
describe('declaring a structure', () => {
  const STRUCTURE = '--expense <<amount>> on [[<<merchant>>]] using <<method>>'

  it('offers the declaration to type, and writes it to the collection’s file', async () => {
    disk.write('/v/tuesday.md', TUESDAY)
    await openApp()
    await open('expense')

    fireEvent.click(viewer().getByText(/Declare how a --expense line is written/))
    const field = screen.getByLabelText('Line structure')
    // Prefilled with the keyword, so what is typed is the structure.
    expect((field as HTMLInputElement).value).toBe('--expense ')
    fireEvent.change(field, { target: { value: STRUCTURE } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() =>
      expect(JSON.parse(disk.read(STRUCTURES)!).expense.structure).toBe(STRUCTURE)
    )
    // The field names are written beside it, for whatever reads the file without
    // this code — an agent walking the vault, most of all.
    expect(JSON.parse(disk.read(STRUCTURES)!).expense.fields).toEqual([
      'amount',
      'merchant',
      'method',
    ])
    // And it is what the page shows once the read catches up.
    await waitFor(() => expect(structure()).toBe(STRUCTURE))
  })

  it('shows a structure the file already holds, and leaves the others alone', async () => {
    declaring({ expense: STRUCTURE, quotes: '--quotes <<said>> — <<who>>' })
    await openApp()
    await open('expense')
    await waitFor(() => expect(structure()).toBe(STRUCTURE))

    fireEvent.click(document.querySelector('.collection-line') as HTMLElement)
    const field = screen.getByLabelText('Line structure')
    fireEvent.change(field, { target: { value: '--expense amount::<<>>' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() =>
      expect(JSON.parse(disk.read(STRUCTURES)!).expense.structure).toBe('--expense amount::<<>>')
    )
    // Every other collection is untouched: one entry changed, not the file.
    expect(JSON.parse(disk.read(STRUCTURES)!).quotes.structure).toBe('--quotes <<said>> — <<who>>')
  })

  it('abandons the typing on Escape', async () => {
    disk.write('/v/tuesday.md', TUESDAY)
    await openApp()
    await open('expense')

    fireEvent.click(viewer().getByText(/Declare how a --expense line is written/))
    const field = screen.getByLabelText('Line structure')
    fireEvent.change(field, { target: { value: STRUCTURE } })
    fireEvent.keyDown(field, { key: 'Escape' })

    expect(screen.queryByLabelText('Line structure')).toBeNull()
    expect(disk.has(STRUCTURES)).toBe(false)
  })

  /** A collection can be declared before anything carries it: the `+` makes the
   *  file, and the view it lands in is where the structure is typed. */
  it('makes a collection from the + and lands on its page', async () => {
    await openApp()
    await openCollections()
    fireEvent.click(screen.getByLabelText('New collection'))

    const name = screen.getByPlaceholderText('Collection name…')
    fireEvent.change(name, { target: { value: 'errands' } })
    fireEvent.keyDown(name, { key: 'Enter' })

    // The view, not a file behind it — there is no file behind it.
    await waitFor(() => expect(viewer().getByText('--errands')).toBeTruthy())
    expect(viewer().getByText('No line carries this yet.')).toBeTruthy()

    // An entry with no shape yet: declared, so the pane lists it before any note
    // carries one, and the page asks for a structure rather than showing an empty
    // line. And no stray file anywhere: a collection is not one.
    await waitFor(() => expect(JSON.parse(disk.read(STRUCTURES)!).errands).toEqual({
      structure: '',
      fields: [],
    }))
    expect(disk.has('/v/.config/errands.md')).toBe(false)
    expect(disk.has('/v/.config/actions/collections/errands.md')).toBe(false)
  })

  /** Someone may be editing this file by hand, and a stray comma is not a reason
   *  to lose their structures — so the write is refused and said out loud. */
  it('refuses to write over a file it cannot read', async () => {
    disk.write(STRUCTURES, '{ "expense": ')
    disk.write('/v/tuesday.md', TUESDAY)
    await openApp()
    await open('expense')

    fireEvent.click(viewer().getByText(/Declare how a --expense line is written/))
    const field = screen.getByLabelText('Line structure')
    fireEvent.change(field, { target: { value: STRUCTURE } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('left alone'))
    expect(disk.read(STRUCTURES)).toBe('{ "expense": ')
  })
})

/**
 * **A declaration with fields makes the page a table.**
 *
 * One string does three jobs: the snippet you type into, the documentation of the
 * shape, and the parser that reads the values back out. So a collection becomes a
 * report without a note carrying any second syntax — and without the app ever
 * telling someone their line is wrong, because the read is partial by design.
 */
describe('a collection with a declared structure', () => {
  const STRUCTURE = '--expense amount:: <<amount>> at <<merchant>> via <<method>>'

  const declared = async () => {
    declaring({ expense: STRUCTURE })
    disk.write(
      '/v/tuesday.md',
      [
        '# Tuesday',
        '',
        '09:42 --expense amount:: <<480>> at <<[[Harbour Bistro]]>> via <<card>>',
        '13:15 --expense amount:: <<60>> at <<[[Airport Kiosk]]>> via <<cash>>',
        // Written before the structure was declared: no amount, other words.
        '18:00 --expense on [[Corner Shop]] using',
        '',
      ].join('\n')
    )
    await openApp()
    await open('expense')
    await waitFor(() => expect(document.querySelector('.collection-table')).toBeTruthy(), {})
  }

  /** The cells of the table, row by row, as the page renders them. */
  const grid = () =>
    [...document.querySelectorAll('.collection-table tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim() ?? '')
    )

  /** **Where it was written comes first**, then when, then the declared fields:
   *  a gathered line is a quotation, and whose it is leads. */
  it('names a column per field, behind the note and the clock', async () => {
    await declared()
    expect(grid()[0]).toEqual(['note', 'when', 'amount', 'merchant', 'method'])
  })

  /**
   * **The page draws what the note draws.** The editor showed a link's name and
   * this page showed its whole target, so one link read two ways in one app; both
   * read `linkLabelSpan` now. And `|!n` reaches here for the same reason — a name
   * that is a fragment is a fragment wherever it is quoted.
   */
  it('shows a link’s name in a cell, and the last n names for |!n', async () => {
    declaring({ expense: STRUCTURE })
    disk.write(
      '/v/friday.md',
      [
        '# Friday',
        '',
        '09:42 --expense amount:: <<480>> at <<[[Entities/Cafes/Bean Street/Lakeside Arrival]]>> via <<card>>',
        '13:15 --expense amount:: <<60>> at <<[[Entities/Cafes/Bean Street/Lakeside Arrival|!2]]>> via <<cash>>',
        '',
      ].join('\n')
    )
    await openApp()
    await open('expense')
    await waitFor(() => expect(document.querySelector('.collection-table')).toBeTruthy(), {})

    expect(grid()[1][3]).toBe('Lakeside Arrival')
    expect(grid()[2][3]).toBe('Bean Street/Lakeside Arrival')
  })

  /**
   * **A sum under every column that is numbers.** A ledger's one question is "how
   * much", and 21 expense lines with no total was the finding. A footer is a
   * *reading* of the rows, so the table stays read-only. `amount` sums to 540 over
   * the two lines that carry one; `merchant` and `method` are words and get no sum.
   */
  it('sums the columns that are numbers, and only those', async () => {
    await declared()
    const foot = [...document.querySelectorAll('.collection-table tfoot td')].map(
      (cell) => cell.textContent?.trim() ?? ''
    )
    expect(foot).toEqual(['sum', '', '540', '', ''])
  })

  it('reads the values out of each line', async () => {
    await declared()
    expect(grid()[1]).toEqual(['tuesday', '09:42', '480', 'Harbour Bistro', 'card'])
    expect(grid()[2]).toEqual(['tuesday', '13:15', '60', 'Airport Kiosk', 'cash'])
  })

  /**
   * **A line that says less is a row with blanks**, not an error and not a line
   * left out. It is still in the collection, and its own text is still what the row
   * carries.
   */
  it('keeps a line that matches nothing, as a row of blanks', async () => {
    await declared()
    expect(grid()[3]).toEqual(['tuesday', '18:00', '', '', ''])
    expect(document.querySelectorAll('.collection-table tbody tr')).toHaveLength(3)
  })

  /** The table is a reading of the line, and the reading is partial — so the
   *  sentence it came from stays one hover away. */
  it('carries the line itself on the row', async () => {
    await declared()
    const rows = [...document.querySelectorAll('.collection-table tbody tr')]
    expect(rows[0].getAttribute('title')).toBe(
      '09:42 --expense amount:: <<480>> at <<[[Harbour Bistro]]>> via <<card>>'
    )
  })

  /** **A cell is a link because the value is one**, not because the declaration
   *  said so: a slot holds whatever was typed between its brackets, a `[[link]]`
   *  included. So the note decides, which is also how someone actually writes it. */
  it('opens the note a link field names', async () => {
    await declared()
    fireEvent.click(viewer().getByText('Harbour Bistro'))
    await waitFor(() =>
      expect(document.querySelector('.viewer-title')!.textContent).toBe('Harbour Bistro'),
      {}
    )
  })

  it('opens the note a row came from', async () => {
    await declared()
    fireEvent.click(viewer().getAllByText('tuesday')[0])
    await waitFor(() => expect(document.querySelector('.viewer-title')!.textContent).toBe('tuesday'))
  })

  /** A declaration with no holes buys no table: the page stays the list of lines,
   *  which is what there is to show. */
  it('stays a list of lines when the structure names no field', async () => {
    declaring({ expense: '--expense a plain note of one' })
    disk.write('/v/tuesday.md', '09:42 --expense on [[Bistro]]\n')
    await openApp()
    await open('expense')
    await waitFor(() => expect(collected()).toHaveLength(1))
    expect(document.querySelector('.collection-table')).toBeNull()
  })

  /** A field the notes are not carrying yet is a column of blanks, and a heading
   *  that only takes width. */
  it('drops a column no line fills', async () => {
    declaring({ expense: STRUCTURE })
    disk.write('/v/tuesday.md', '09:42 --expense amount:: <<480>> at <<[[Bistro]]>>\n')
    await openApp()
    await open('expense')
    await waitFor(() => expect(document.querySelector('.collection-table')).toBeTruthy(), {})
    expect(grid()[0]).toEqual(['note', 'when', 'amount', 'merchant'])
  })
})

/**
 * **The table and the lines are two readings of the same rows**, and switching
 * between them is opening one section and shutting the other. A button that
 * swapped one for the other would be a mode — a second thing to be in, and a way
 * to have neither.
 */
describe('the table and the lines', () => {
  const SHAPE = '--expense spent amount::<<>> at merchant:: <<>>'
  const both = async () => {
    declaring({ expense: SHAPE })
    disk.write('/v/tuesday.md', TUESDAY)
    await openApp()
    await open('expense')
    await waitFor(() => expect(document.querySelector('.collection-table')).toBeTruthy())
  }

  /** The `folder-header` a section's title sits in — the row that opens and shuts
   *  it. */
  const heading = (title: string) =>
    within(document.querySelector('.viewer')!)
      .getAllByText(title)
      .map((node) => node.closest('.folder-header'))
      .find((node): node is HTMLElement => node instanceof HTMLElement)!

  it('offers both, with the table open and the lines shut', async () => {
    await both()
    expect(document.querySelector('.collection-table')).toBeTruthy()
    // The lines are there to open, and not showing.
    expect(heading('Lines')).toBeTruthy()
    expect(document.querySelector('.collected-lines')).toBeNull()
  })

  it('shows the text when the Lines section is opened', async () => {
    await both()
    fireEvent.click(within(heading('Lines')).getByText('Lines'))
    await waitFor(() => expect(document.querySelector('.collected-lines')).toBeTruthy())
    expect(collected()[0]).toContain('--expense')
    // Both at once is allowed: they are two readings, not two modes.
    expect(document.querySelector('.collection-table')).toBeTruthy()

    fireEvent.click(within(heading('Table')).getByText('Table'))
    await waitFor(() => expect(document.querySelector('.collection-table')).toBeNull())
    expect(document.querySelector('.collected-lines')).toBeTruthy()
  })

  /** With nothing declared there is no table to offer, so the lines open as they
   *  always did and there is no empty section above them. */
  it('offers no table when nothing is declared', async () => {
    disk.write('/v/tuesday.md', TUESDAY)
    await openApp()
    await open('expense')
    await waitFor(() => expect(document.querySelector('.collected-lines')).toBeTruthy())
    expect(within(document.querySelector('.viewer')!).queryByText('Table')).toBeNull()
  })
})

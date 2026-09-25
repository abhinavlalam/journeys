/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'
import { BUILT_IN_KINDS, creatable } from '../actionKinds'

/**
 * The Actions section: the vault's own action files, in the left pane.
 *
 * Most kinds are markdown files, and what tells them apart is the folder they live
 * in under `.config/actions/` — so these tests are mostly about the bytes that end
 * up on disk, which is the part a later change to how they are *processed* has to
 * keep working.
 *
 * **Collections are the exception and have their own file**: a collection is not a
 * file at all, so nothing here writes one. `collections.test.tsx` covers what its
 * rows do instead.
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

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

/** The Actions section is always on screen, open to begin with. */
const openActions = async () => {
  await waitFor(() => expect(screen.getByText('Collections')).toBeTruthy())
}

/**
 * **A group is shut until it is opened**, as the tree's folders are, so a test
 * about rows opens the group holding them. `Expand all` is the pane's own way of
 * saying "all of them", which is what most of these want.
 */
const openGroups = () => fireEvent.click(screen.getByLabelText('Expand all actions'))

const openActionsExpanded = async () => {
  await openActions()
  openGroups()
}

/**
 * Every row's label with its count run together — `reading2` is the row named
 * `reading` with a `2` beside it, which is what the DOM gives. Used by both unions,
 * because both draw the same row.
 */
const rowLabels = () =>
  within(document.querySelector('.sidebar')!)
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')

/** Scoped to the left pane. A file's name is in the reading pane's header too, so
 *  an unscoped `getByText` matches twice the moment one is open. */
const pane = () => within(document.querySelector('.sidebar')!)

const labels = (selector: string) =>
  [...document.querySelectorAll(`${selector} button`)].map((button) =>
    button.getAttribute('aria-label')
  )

describe('where the buttons are', () => {
  /** **Three sections, each with its controls on its heading** — search, the
   *  collapse pair and `+`, revealed on hover — and the app's own views as rows
   *  in the third. It was two panes behind two icons over one shared rail. */
  it('stacks Notes, Actions and Applications, each heading carrying its own controls', async () => {
    await openApp()
    const sections = [...document.querySelectorAll('.pane-section')]
    expect(sections.map((one) => one.querySelector('.row-name')?.textContent)).toEqual([
      'Notes',
      'Actions',
      'Applications',
    ])
    expect(labels('.pane-section:nth-of-type(1) > .folder-header .folder-actions')).toEqual([
      'Search in notes',
      'Collapse all notes',
      'Expand all notes',
      'New note',
      'New locked note',
    ])
    expect(labels('.pane-section:nth-of-type(2) > .folder-header .folder-actions')).toEqual([
      'Search in actions',
      'Collapse all actions',
      'Expand all actions',
      'New action',
    ])
    expect(labels('.pane-section:nth-of-type(3) .file-list')).toEqual([
      'Open the note graph',
      'Calendar',
      'Sync',
      'Terminal',
      'Settings',
    ])
  })
})

/**
 * **Config is `.config` itself**, so whatever is kept beside the settings shows up:
 * `settings.json`, and the notes the app and its agent keep about themselves. The
 * kind of a file is still the folder it sits in — this one's folder is the root.
 */
describe('the Config group', () => {
  it('lists what is beside the settings, the settings included', async () => {
    disk.write('/v/.config/app.md', '# App\n')
    disk.write('/v/.config/claude.md', '# Claude\n')
    await openApp()
    await openActionsExpanded()

    await waitFor(() => expect(pane().getByText('Config')).toBeTruthy())
    for (const name of ['app', 'claude', 'settings.json']) {
      await waitFor(() => expect(pane().getByText(name)).toBeTruthy())
    }
    // The action folders are folders, not files: they belong to their own groups.
    expect(pane().queryByText('actions')).toBeNull()
  })

  /** `settings.json` is the one file that is not just a file: saving it
   *  reconfigures the app, so it opens in the view that has a Save. */
  it('opens settings.json in the view with the Save', async () => {
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('settings.json')).toBeTruthy())

    fireEvent.click(pane().getByText('settings.json'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
  })

  /** **Not something you make.** `settings.json` arrives with the app and the
   *  notes beside it are put there, so Config is the one kind with no folder of its
   *  own and the one `creatable` says no to. */
  it('is not one of the things the + offers to create', async () => {
    await openApp()
    await openActions()
    fireEvent.click(screen.getByLabelText('New action'))

    const offered = [...document.querySelectorAll('.context-menu button')].map(
      (button) => button.textContent
    )
    // **Neither Property nor Tag is here**, and for the same reason: each exists
    // because a note carries it, so there is nothing for a `+` to write. Property
    // *was* offered for a while, writing a default into `properties.json` for every
    // new note to start with; no vault ever used it, and a template stamped into
    // every new note is a data-collection mechanism in a journal, so it went. Config
    // is the one kind with files the `+` still refuses: those arrive with the app.
    expect(offered).toEqual(['Collection', 'Skill'])
  })

  /** Each kind's own `+`, on its own group row: the rail's asks which kind, and
   *  this one already knows. */
  it('makes a kind from that kind’s own row', async () => {
    await openApp()
    await openActions()
    fireEvent.click(screen.getByLabelText('New skill'))

    const field = screen.getByPlaceholderText('Skill name…')
    fireEvent.change(field, { target: { value: 'summarise' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(disk.has('/v/.claude/skills/summarise/SKILL.md')).toBe(true))
  })
})

describe('the pane', () => {
  /** A section shuts like a folder: its rows go, the others stay, and the note in
   *  the reading pane is untouched — this is the left pane's business alone. */
  it('shuts a section and leaves the others and the reading pane alone', async () => {
    await openApp()
    fireEvent.click(within(document.querySelector('.file-list')!).getByText('roadmap'))
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Collapse Notes'))
    // The tree's rows are gone — its icon buttons are the part only it has.
    await waitFor(() => expect(screen.queryByLabelText('Icon for roadmap')).toBeNull())
    expect(pane().getByText('Collections')).toBeTruthy()
    expect(screen.getByTestId('editor')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Expand Notes'))
    await waitFor(() => expect(screen.getByLabelText('Icon for roadmap')).toBeTruthy())
  })

  // Five kinds, and `BUILT_IN_KINDS` is the only place that says so: the groups,
  // the `+` menu, and what collapse-all acts on all read it.
  /** Every kind's icon has to be one of the drawn set: an unknown key renders as
   *  its own name, and the create menu read "settingsConfig note". */
  it('names an icon the set actually has', async () => {
    const { NOTE_ICONS } = await import('../icons')
    const drawn = new Set(NOTE_ICONS.map((icon) => icon.key))
    for (const kind of BUILT_IN_KINDS) expect(drawn.has(kind.icon), kind.key).toBe(true)
  })

  it('shows a group for every kind', async () => {
    await openApp()
    await openActions()
    for (const kind of BUILT_IN_KINDS) expect(pane().getByText(kind.label)).toBeTruthy()
  })

  it('lists what is already on disk, under its kind', async () => {
    disk.write('/v/.claude/skills/summarise/SKILL.md', '---\nname: summarise\n---\n')
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('summarise')).toBeTruthy())
  })

  /**
   * **A skill written by other hands appears on the next window focus.** The agent
   * in the Terminal tab made `.claude/skills/wiki/SKILL.md` twenty-three seconds
   * after the app had read this list, and the row stayed missing until a relaunch —
   * reported as "I do not see it". The notes that agent wrote showed up on focus,
   * because `useVaultTexts` re-reads on it; this listing had no such trigger. Now
   * it is the same trigger, for the same reason: this vault is written by more than
   * this app.
   */
  it('shows a skill added outside the app once the window is focused again', async () => {
    await openApp()
    await openActionsExpanded()
    expect(pane().queryByText('wiki')).toBeNull()

    disk.write('/v/.claude/skills/wiki/SKILL.md', '---\nname: wiki\n---\n')
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(pane().getByText('wiki')).toBeTruthy())
  })

  /** **A tag is a row because a note carries it**, which is Properties' own
   *  arrangement: the pane lists what the notes say, and no file is involved. */
  it('lists a tag the notes carry, with the number carrying it', async () => {
    disk.write('/v/roadmap.md', '# Roadmap\n\nsomeday #travel and #travel again\n')
    disk.write('/v/inbox.md', '# Inbox\n\nbook it #travel\n')
    await openApp()
    await openActionsExpanded()
    // Two notes, not three mentions: the count is notes, as it is for a property.
    await waitFor(() => expect(rowLabels().some((text) => text === 'travel2')).toBe(true))
  })
})

describe('the + ', () => {
  it('asks which kind, naming every one it can make', async () => {
    await openApp()
    await openActions()
    fireEvent.click(screen.getByLabelText('New action'))
    const menu = within(document.querySelector('.context-menu')!)
    for (const kind of BUILT_IN_KINDS.filter(creatable)) {
      expect(menu.getByText(kind.singular)).toBeTruthy()
    }
  })

  it('writes a skill, and opens it', async () => {
    await openApp()
    await openActionsExpanded()
    fireEvent.click(screen.getByLabelText('New action'))
    fireEvent.click(screen.getByText('Skill'))

    const field = screen.getByPlaceholderText('Skill name…')
    fireEvent.change(field, { target: { value: 'Reading list' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(disk.read('/v/.claude/skills/Reading list/SKILL.md')).toContain('name: Reading list'))
    // Listed by its **folder's** name — every skill's file is `SKILL.md`, so the
    // basename names nothing — and opened on the frontmatter that makes it a skill:
    // Claude Code will not load one whose `name` is missing. Nothing else is
    // written; a heading repeating the name is a line the user has to delete.
    await waitFor(() => expect(pane().getByText('Reading list')).toBeTruthy())
    await waitFor(() =>
      expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe(
        '---\nname: Reading list\ndescription:\n---\n'
      )
    )
  })

  /** It used to write `.config/actions/tags/Later.md`, and an empty page named
   *  after a thing is not the thing — the third time this app has made that
   *  correction, after collections and properties. */
  it('does not offer a tag at all, because a tag has no file', async () => {
    await openApp()
    await openActions()
    fireEvent.click(screen.getByLabelText('New action'))
    expect(screen.queryByText('Tag')).toBeNull()
  })

  it('writes a skill where skills live', async () => {
    await openApp()
    await openActions()
    fireEvent.click(screen.getByLabelText('New action'))
    fireEvent.click(screen.getByText('Skill'))
    const field = screen.getByPlaceholderText('Skill name…')
    fireEvent.change(field, { target: { value: 'Summarise' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(disk.has('/v/.claude/skills/Summarise/SKILL.md')).toBe(true))
  })

  // The creators' rule everywhere else a name is typed: the path is spliced from
  // it, so a `/` would put the file somewhere nobody picked.
  it('folds a name that would leave the folder', async () => {
    await openApp()
    await openActions()
    fireEvent.click(screen.getByLabelText('New action'))
    fireEvent.click(screen.getByText('Skill'))
    const field = screen.getByPlaceholderText('Skill name…')
    fireEvent.change(field, { target: { value: '../../escape' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    // Every separator folded to a `-`, so the file lands in the folder it was
    // named in and nowhere else.
    await waitFor(() => expect(disk.has('/v/.claude/skills/..-..-escape/SKILL.md')).toBe(true))
    expect(disk.has('/v/.config/escape.md')).toBe(false)
    expect(disk.has('/v/escape.md')).toBe(false)
  })

  it('abandons the name on Escape', async () => {
    await openApp()
    await openActions()
    fireEvent.click(screen.getByLabelText('New action'))
    fireEvent.click(screen.getByText('Skill'))
    const field = screen.getByPlaceholderText('Skill name…')
    fireEvent.change(field, { target: { value: 'nothing' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Skill name…')).toBeNull()
    expect(disk.has('/v/.claude/skills/nothing/SKILL.md')).toBe(false)
  })
})

/**
 * The row of controls acts on whichever section is open, which is the whole reason
 * there is one row and not two. In this section: search filters the rows by name,
 * and the pair opens and shuts the two groups — through the *same*
 * `useFolderOpenState` the tree's folders use, so there is one mechanism behind a
 * group's chevron and the collapse button.
 */
describe('the controls, in this section', () => {
  const seeded = () => {
    // Tags are rows because the notes carry them; skills are rows because a file
    // is there. Both kinds in the fixture, so the controls are exercised over each.
    // The notes are named nothing like the tags they carry: a note called
    // `reading` would put that word in the *tree* as well, and a row matched there
    // is not the row this section is about.
    disk.write('/v/monday.md', '# Monday\n\nstarted #reading today\n')
    disk.write('/v/tuesday.md', '# Tuesday\n\n#inbox-triage before lunch\n')
    disk.write('/v/.claude/skills/summarise/SKILL.md', '---\nname: summarise\n---\n')
  }

  it('filters the rows by name', async () => {
    seeded()
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('summarise')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Search in actions'))
    // The field names what it is over: rows here, note text in the tree.
    fireEvent.change(screen.getByLabelText('Search actions'), { target: { value: 'triage' } })

    await waitFor(() => expect(pane().queryByText('summarise')).toBeNull())
    expect(pane().getByText('inbox-triage')).toBeTruthy()
    expect(pane().queryByText('reading')).toBeNull()
    // The groups stay: they are what says where a hit lives.
    expect(pane().getByText('Tags')).toBeTruthy()
  })

  it('shuts both groups and opens them again', async () => {
    seeded()
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('summarise')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Collapse all actions'))
    expect(pane().queryByText('summarise')).toBeNull()
    expect(pane().queryByText('reading')).toBeNull()
    // The groups themselves are still there to open.
    expect(pane().getByText('Skills')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Expand all actions'))
    await waitFor(() => expect(pane().getByText('summarise')).toBeTruthy())
  })

  it('opens and shuts one group from its own chevron', async () => {
    seeded()
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('summarise')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Collapse Skills'))
    expect(pane().queryByText('summarise')).toBeNull()
    // The other group is untouched, which is what makes it a group and not a mode.
    expect(pane().getByText('reading')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Expand Skills'))
    expect(pane().getByText('summarise')).toBeTruthy()
  })

  /** **Shut on arrival**, which is what the tree's folders do: five groups spread
   *  open is a wall of rows nobody asked for. Opening one is remembered. */
  it('starts with every group shut', async () => {
    seeded()
    await openApp()
    await openActions()
    await waitFor(() => expect(pane().getByText('Collections')).toBeTruthy())
    expect(pane().queryByText('reading')).toBeNull()
    expect(pane().queryByText('summarise')).toBeNull()

    openGroups()
    await waitFor(() => expect(pane().getByText('reading')).toBeTruthy())
    expect(pane().getByText('summarise')).toBeTruthy()
  })
})

/**
 * **A collection is what the notes carry, and nothing else.**
 *
 * Properties are a union — the names in use *and* the files defining them — and
 * Collections was built the same way, which put an empty
 * `.config/actions/collections/expense.md` on disk the moment a row was clicked. A
 * collection has no file: its rows are the `--keyword`s the lines carry, and what
 * clicking one does is `collections.test.tsx`.
 */
describe('the Collections group', () => {
  it('lists a keyword the notes use, and counts the notes', async () => {
    disk.write('/v/roadmap.md', '# Roadmap\n\n- --reading The Nutmeg\n')
    disk.write('/v/standup.md', '# Standup\n\n--reading again\n--errands milk\n')
    await openApp()
    await openActionsExpanded()

    await waitFor(() => expect(pane().getByText('reading')).toBeTruthy())
    expect(rowLabels().some((text) => text === 'reading2')).toBe(true)
    expect(rowLabels().some((text) => text === 'errands1')).toBe(true)
  })

  /**
   * **A declared collection has a row before any note carries it**, because
   * declaring the structure is how one is set up: write `--expense <amount>` on the
   * page, then start writing the lines.
   */
  it('lists a collection that has only declared a structure', async () => {
    disk.write(
      '/v/.config/actions/collections.json',
      JSON.stringify({ expense: { structure: '--expense amount::<<>>', fields: ['amount'] } })
    )
    await openApp()
    await openActionsExpanded()

    await waitFor(() => expect(pane().getByText('expense')).toBeTruthy())
    // No count: no note carries it yet, and the row is still a row.
    expect(rowLabels().some((text) => text === 'expense')).toBe(true)
  })

  /** One row for a collection that is both declared and in use — the union
   *  Properties has, over a declaration rather than an empty page. */
  it('shows one row when a collection is declared and in use', async () => {
    disk.write(
      '/v/.config/actions/collections.json',
      JSON.stringify({ expense: { structure: '--expense amount::<<>>', fields: ['amount'] } })
    )
    disk.write('/v/roadmap.md', '# Roadmap\n\n09:42 --expense on [[Harbour Bistro]]\n')
    await openApp()
    await openActionsExpanded()

    await waitFor(() => expect(rowLabels().some((text) => text === 'expense1')).toBe(true))
    expect(pane().getAllByText('expense')).toHaveLength(1)
  })
})

/**
 * **Properties are the union of what defines one and what uses one.**
 *
 * A property typed into a note's block turns up in the group, with the number of
 * notes carrying it; a name added from the `+` is a file that defines it. Clicking
 * a name that has no file yet writes that file, which is the same act minus the
 * typing.
 */
describe('the Properties group', () => {
  it('lists a property the notes carry, and counts them', async () => {
    // `stage` and not `status`: the seeded vault's own `pingbird` carries a
    // `status:`, and a count is a fact about the whole vault.
    disk.write('/v/roadmap.md', '---\nowner: me\nstage: draft\n---\n# Roadmap\n')
    disk.write('/v/inbox.md', '---\nowner: you\n---\n# Inbox\n')
    await openApp()
    await openActionsExpanded()

    // `owner` in two notes, `stage` in one.
    await waitFor(() => expect(pane().getByText('owner')).toBeTruthy())
    expect(rowLabels().some((text) => text === 'owner2')).toBe(true)
    expect(rowLabels().some((text) => text === 'stage1')).toBe(true)
  })

  /** A file named after a property is not a property, so it is not a row. */
  it('does not list a stray properties file as a property', async () => {
    disk.write('/v/.config/actions/properties/owner.md', '# owner\n')
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('Properties')).toBeTruthy())
    expect(pane().queryByText('owner')).toBeNull()
  })

  /**
   * **The row opens the property's page**: every note carrying it, with the value
   * each one gives — the note leading, as a collection's table leads with it. It
   * used to write an empty file named after the property and open that.
   */
  it('opens the property’s page, a note and its value per row', async () => {
    disk.write('/v/roadmap.md', '---\nowner: me\n---\n# Roadmap\n')
    disk.write('/v/inbox.md', '---\nowner: [[Rhea]]\n---\n# Inbox\n')
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('owner')).toBeTruthy())

    fireEvent.click(pane().getByText('owner'))
    await waitFor(() =>
      expect(document.querySelector('.viewer-title')!.textContent).toBe('owner:')
    )
    const rows = [...document.querySelectorAll('.collection-table tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim())
    )
    expect(rows).toEqual([
      ['inbox', 'Rhea'],
      ['roadmap', 'me'],
    ])
    // A `[[link]]` value is a link, as it is in a collection's table.
    expect(document.querySelector('.collection-table .collection-link')!.textContent).toBe('Rhea')
    // And nothing was written: the page is a question asked of the notes.
    expect(disk.has('/v/.config/actions/properties/owner.md')).toBe(false)
    // The row is marked as the open one.
    expect(pane().getByText('owner').closest('.file-row')!.className).toContain('selected')
  })

  // `Status` and `status` are one property to anything reading the block, and the
  // first spelling met is the one shown.
  it('counts one property however it is spelled', async () => {
    disk.write('/v/roadmap.md', '---\nStage: draft\n---\n# Roadmap\n')
    disk.write('/v/inbox.md', '---\nstage: done\n---\n# Inbox\n')
    await openApp()
    await openActionsExpanded()
    // **One** row, counted twice. Which of the two spellings it wears is whichever
    // note the read met first — tree order — and that is not worth pinning; that
    // there is one row and it counts both notes is.
    await waitFor(() =>
      expect(rowLabels().filter((text) => text.toLowerCase() === 'stage2')).toHaveLength(1)
    )
  })
})

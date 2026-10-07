/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'
import { BUILT_IN_KINDS, creatable } from '../actionKinds'

/**
 * The Actions section of the left pane. Skills and Config are files, and these tests
 * are mostly about the bytes that land on disk. Tags and properties are not files,
 * so nothing here writes one; `tagPage.test.tsx` covers what a tag's row opens.
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


/** The Actions section is always on screen, open to begin with. */
const openActions = async () => {
  await waitFor(() => expect(screen.getByText('Tags')).toBeTruthy())
}

/**
 * A group is shut until opened, like the tree's folders, so a test
 * about rows opens its group first. `Expand all` opens them all.
 */
const openGroups = () => fireEvent.click(screen.getByLabelText('Expand all actions'))

const openActionsExpanded = async () => {
  await openActions()
  openGroups()
}

/**
 * Every row's label with its count joined (`reading2` is
 * `reading` with a `2`), as the DOM gives it.
 */
const rowLabels = () =>
  within(document.querySelector('.sidebar')!)
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')

/** Scoped to the left pane: an open file's name is in the reading pane's header too. */
const pane = () => within(document.querySelector('.sidebar')!)

const labels = (selector: string) =>
  [...document.querySelectorAll(`${selector} button`)].map((button) =>
    button.getAttribute('aria-label')
  )

describe('where the buttons are', () => {
  /**
   * Three sections, each with its controls on the heading (search, collapse
   * pair, `+`, shown on hover), and the app's own views as rows in the third.
   */
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
      'Timeline',
      'Tasks',
      'Log',
      'Sync',
      'Terminal',
      'Settings',
    ])
  })
})

/**
 * Config is `.config` itself, so whatever sits beside the settings
 * shows: `settings.json` and the notes the app and its agent keep.
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
    // Folders there belong to their own groups.
    expect(pane().queryByText('actions')).toBeNull()
  })

  /**
   * `settings.json` reconfigures the app when saved, so it opens
   * in the view with a Save.
   */
  it('opens settings.json in the view with the Save', async () => {
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('settings.json')).toBeTruthy())

    fireEvent.click(pane().getByText('settings.json'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy())
  })

  /**
   * Not something you make: `settings.json` comes with the app,
   * so Config is the one kind `creatable` refuses.
   */
  it('is not one of the things the + offers to create', async () => {
    await openApp()
    await openActions()
    fireEvent.click(screen.getByLabelText('New action'))

    const offered = [...document.querySelectorAll('.context-menu button')].map(
      (button) => button.textContent
    )
    // Property is not here: a property exists because a note carries
    // it, so a `+` has nothing to write. Tag is, since its structure
    // is written to `tags.json`. Config's files come with the app.
    expect(offered).toEqual(['Skill', 'Tag'])
  })

  /** Each kind's own `+`, on its group row. */
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
  /**
   * A section folds like a folder: its rows go, the others stay,
   * and the open note is untouched.
   */
  it('shuts a section and leaves the others and the reading pane alone', async () => {
    await openApp()
    fireEvent.click(within(document.querySelector('.file-list')!).getByText('roadmap'))
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Collapse Notes'))
    // The tree's rows are gone; its icon buttons are what only it has.
    await waitFor(() => expect(screen.queryByLabelText('Icon for roadmap')).toBeNull())
    expect(pane().getByText('Tags')).toBeTruthy()
    expect(screen.getByTestId('editor')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Expand Notes'))
    await waitFor(() => expect(screen.getByLabelText('Icon for roadmap')).toBeTruthy())
  })

  // `BUILT_IN_KINDS` is the one list of kinds: the groups, the
  // `+` menu and Collapse all read it.
  /**
   * Every kind's icon must be in the drawn set: an unknown key shows
   * its own name, and the create menu read "settingsConfig note".
   */
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
   * A skill written by someone else appears on the next window focus. The
   * agent in the terminal made `.claude/skills/wiki/SKILL.md` after the
   * app had listed the folder, and the row stayed missing until a
   * relaunch. The listing now uses the same focus trigger as the notes.
   */
  it('shows a skill added outside the app once the window is focused again', async () => {
    await openApp()
    await openActionsExpanded()
    expect(pane().queryByText('wiki')).toBeNull()

    disk.write('/v/.claude/skills/wiki/SKILL.md', '---\nname: wiki\n---\n')
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(pane().getByText('wiki')).toBeTruthy())
  })

  /**
   * A tag is a row because a note carries it, as with
   * properties: the pane lists what the notes say.
   */
  it('lists a tag the notes carry, with the number carrying it', async () => {
    disk.write('/v/roadmap.md', '# Roadmap\n\nsomeday #travel and #travel again\n')
    disk.write('/v/inbox.md', '# Inbox\n\nbook it #travel\n')
    await openApp()
    await openActionsExpanded()
    // Two notes, not three mentions: the count is notes, as for a property.
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
    // Listed by its folder's name, since every skill file is `SKILL.md`,
    // and opened with the YAML that makes it a skill: Claude Code will
    // not load one without a `name`. Nothing else is written.
    await waitFor(() => expect(pane().getByText('Reading list')).toBeTruthy())
    await waitFor(() =>
      expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe(
        '---\nname: Reading list\ndescription:\n---\n'
      )
    )
  })

  /**
   * A tag's `+` declares it: an entry in `tags.json`, in the tag's folded
   * spelling, and its page opens to add properties. No file of its own.
   */
  it('declares a tag into tags.json and opens its page, writing no file of its own', async () => {
    await openApp()
    await openActionsExpanded()
    fireEvent.click(screen.getByLabelText('New action'))
    fireEvent.click(screen.getByText('Tag'))
    const field = screen.getByPlaceholderText('Tag name…')
    fireEvent.change(field, { target: { value: '#Travel' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() =>
      expect(JSON.parse(disk.read('/v/.config/tags.json')!)).toEqual({ travel: { properties: [] } })
    )
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('#travel'))
    // Listed as soon as it is declared, before any note carries it.
    expect(pane().getByText('travel')).toBeTruthy()
    expect(disk.paths().some((path) => path.includes('/tags/'))).toBe(false)
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

  // Typed names go through the same rule everywhere: the path is
  // built from it, so a `/` would put the file somewhere else.
  it('folds a name that would leave the folder', async () => {
    await openApp()
    await openActions()
    fireEvent.click(screen.getByLabelText('New action'))
    fireEvent.click(screen.getByText('Skill'))
    const field = screen.getByPlaceholderText('Skill name…')
    fireEvent.change(field, { target: { value: '../../escape' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    // Every separator becomes a `-`, so the file lands in the folder it was named in.
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
 * The row of controls acts on whichever section it is on. Here search
 * filters rows by name, and the pair opens and shuts the groups
 * through the same `useFolderOpenState` the tree's folders use.
 */
describe('the controls, in this section', () => {
  const seeded = () => {
    // Tags are rows because notes carry them; skills because a file is
    // there. Both are in the fixture. The notes are named unlike the
    // tags, so a match in the tree is not confused with a row here.
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
    // The field says what it searches: rows here, note text in the tree.
    fireEvent.change(screen.getByLabelText('Search actions'), { target: { value: 'triage' } })

    await waitFor(() => expect(pane().queryByText('summarise')).toBeNull())
    expect(pane().getByText('inbox-triage')).toBeTruthy()
    expect(pane().queryByText('reading')).toBeNull()
    // The groups stay: they show where a hit lives.
    expect(pane().getByText('Tags')).toBeTruthy()
  })

  it('opens a shut section when one of its controls is pressed, so the field it opens is seen', async () => {
    seeded()
    await openApp()
    await openActionsExpanded()
    fireEvent.click(screen.getByLabelText('Collapse Actions'))
    expect(pane().queryByText('Tags')).toBeNull()
    fireEvent.click(screen.getByLabelText('Search in actions'))
    expect(screen.getByLabelText('Search actions')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Collapse Notes'))
    fireEvent.click(screen.getByLabelText('New note'))
    expect(screen.getByPlaceholderText('Note title…')).toBeTruthy()
  })

  it('shuts both groups and opens them again', async () => {
    seeded()
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('summarise')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Collapse all actions'))
    expect(pane().queryByText('summarise')).toBeNull()
    expect(pane().queryByText('reading')).toBeNull()
    // The groups are still there to open.
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
    // The other group is untouched.
    expect(pane().getByText('reading')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Expand Skills'))
    expect(pane().getByText('summarise')).toBeTruthy()
  })

  /** Shut on arrival, like the tree's folders. An opened group is remembered. */
  it('starts with every group shut', async () => {
    seeded()
    await openApp()
    await openActions()
    await waitFor(() => expect(pane().getByText('Tags')).toBeTruthy())
    expect(pane().queryByText('reading')).toBeNull()
    expect(pane().queryByText('summarise')).toBeNull()

    openGroups()
    await waitFor(() => expect(pane().getByText('reading')).toBeTruthy())
    expect(pane().getByText('summarise')).toBeTruthy()
  })
})

/**
 * Only notes feed tags and properties: a `#comment` in a config
 * file is not a tag. A text file is still found by search.
 */
describe('a text file', () => {
  it('feeds no tag or property, and is still found by search', async () => {
    disk.write('/v/notes.txt', 'plain #fromtext mood:: calm see [[roadmap]]\n')
    disk.write('/v/monday.md', '# Monday\n\n#fromnote\n')
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('fromnote')).toBeTruthy())
    expect(pane().queryByText('fromtext')).toBeNull()
    expect(pane().queryByText('mood')).toBeNull()

    fireEvent.click(screen.getByLabelText('Search in notes'))
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: 'fromtext' } })
    expect(await screen.findByText(/plain #fromtext/)).toBeTruthy()
  })
})

/** One row for a tag both declared and in use. */
describe('the Tags group', () => {
  it('shows one row when a tag is declared and in use', async () => {
    disk.write('/v/.config/tags.json', JSON.stringify({ expense: { properties: ['amount'] } }))
    disk.write('/v/roadmap.md', '# Roadmap\n\n09:42 #expense on [[Harbour Bistro]]\n')
    await openApp()
    await openActionsExpanded()

    await waitFor(() => expect(rowLabels().some((text) => text === 'expense1')).toBe(true))
    expect(pane().getAllByText('expense')).toHaveLength(1)
  })

  /**
   * `/` groups tags: `#listening/podcast` is its own tag, page and
   * structure, drawn under `listening`. A head that is a tag opens its page
   * from its name, as a folder opens its note; one that is not only folds.
   */
  it('nests a tag under its head, and opens a head that is a tag', async () => {
    disk.write('/v/monday.md', '# Monday\n\n#listening/podcast one\n#listening/audiobook two\n#listening\n#watching/series\n')
    await openApp()
    await openActions()
    fireEvent.click(screen.getByLabelText('Expand Tags'))
    await waitFor(() => expect(pane().getByText('listening')).toBeTruthy())
    // Shut until opened, like every group.
    expect(pane().queryByText('podcast')).toBeNull()

    fireEvent.click(screen.getByLabelText('Expand listening'))
    expect(pane().getByText('podcast')).toBeTruthy()
    expect(pane().getByText('audiobook')).toBeTruthy()
    fireEvent.click(pane().getByText('podcast'))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('#listening/podcast'))
    fireEvent.click(pane().getByText('listening'))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('#listening'))

    // `watching` is no tag of its own: its name folds.
    fireEvent.click(pane().getByText('watching'))
    expect(pane().getByText('series')).toBeTruthy()
  })

  it('opens the nested groups with Expand all', async () => {
    disk.write('/v/monday.md', '# Monday\n\n#listening/podcast one\n')
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('podcast')).toBeTruthy())
  })
})

/**
 * Properties are what the notes carry: a property in a note's
 * block appears in the group with the number of notes carrying it.
 */
describe('the Properties group', () => {
  it('lists a property the notes carry, and counts them', async () => {
    // `stage`, not `status`: the seeded `pingbird` carries a
    // `status:`, and a count covers the whole vault.
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
   * The row opens the property's page: every note carrying it,
   * with each note's value, the note first as in a tag's table.
   */
  it('opens the property’s page, a note and its value per row', async () => {
    disk.write('/v/roadmap.md', '---\nowner: me\n---\n# Roadmap\n')
    disk.write('/v/inbox.md', '---\nowner: [[Mira Vance]]\n---\n# Inbox\n')
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('owner')).toBeTruthy())

    fireEvent.click(pane().getByText('owner'))
    await waitFor(() =>
      expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('owner::')
    )
    const rows = [...document.querySelectorAll('.line-table tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim())
    )
    expect(rows).toEqual([
      ['inbox', 'Mira Vance'],
      ['roadmap', 'me'],
    ])
    // A `[[link]]` value is a link, as in a tag's table.
    expect(document.querySelector('.line-table .line-link')!.textContent).toBe('Mira Vance')
    // And nothing was written: the page is built from the notes.
    expect(disk.has('/v/.config/actions/properties/owner.md')).toBe(false)
    // The row is marked as the open one.
    expect(pane().getByText('owner').closest('.file-row')!.className).toContain('selected')
  })

  /** A value reads as the note shows it (`Live`): an address is a link to it. */
  it('shows an address value as a link', async () => {
    disk.write('/v/vendor.md', 'website:: https://northwind.example/orders\n# Vendor\n')
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('website')).toBeTruthy())
    fireEvent.click(pane().getByText('website'))
    await waitFor(() =>
      expect(document.querySelector('.line-table .line-link')?.textContent).toBe('https://northwind.example/orders')
    )
  })

  /**
   * A block property is a property: `amount:: 480` on a line is
   * listed with the page ones, counted by notes, and its page has
   * a row per value, so a note that says it twice appears twice.
   */
  it('lists a block property with the page ones, a row per value', async () => {
    disk.write('/v/roadmap.md', 'owner:: me\n\n08:10 lunch amount:: 480\n12:00 coffee amount:: 5\n')
    disk.write('/v/inbox.md', '# Inbox\n\n- supplies amount:: 12\n')
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(rowLabels().some((text) => text === 'amount2')).toBe(true))
    expect(rowLabels().some((text) => text === 'owner1')).toBe(true)

    fireEvent.click(pane().getByText('amount'))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('amount::'))
    const rows = [...document.querySelectorAll('.line-table tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim())
    )
    expect(rows).toEqual([
      ['inbox', '12'],
      ['roadmap', '480'],
      ['roadmap', '5'],
    ])
  })

  /**
   * A property's type is set on its page for the whole vault,
   * into `.config/properties.json` beside the rest of the file.
   * `icon` and `path` are the app's, with fixed types.
   */
  it('sets a property’s type from its page, and shows the app’s own fixed', async () => {
    disk.write('/v/.config/properties.json', '{\n  "owner": { "type": "backlink", "note": "kept" }\n}\n')
    disk.write('/v/roadmap.md', 'icon:: book\n\n08:10 lunch amount:: 480\n')
    await openApp()
    await openActionsExpanded()
    await waitFor(() => expect(pane().getByText('amount')).toBeTruthy())

    fireEvent.click(pane().getByText('amount'))
    const type = () => screen.getByRole('combobox', { name: 'Type' }) as HTMLSelectElement
    await waitFor(() => expect(type().value).toBe('text'))
    expect([...type().options].map((one) => one.value)).toEqual(['text', 'number', 'date', 'backlink', 'url', 'icon', 'path'])
    fireEvent.change(type(), { target: { value: 'number' } })
    await waitFor(() =>
      expect(JSON.parse(disk.read('/v/.config/properties.json')!)).toEqual({
        amount: { type: 'number' },
        owner: { type: 'backlink', note: 'kept' },
      })
    )
    await waitFor(() => expect(type().value).toBe('number'))

    fireEvent.click(pane().getByText('icon'))
    await waitFor(() => expect(document.querySelector('.viewer:not([hidden]) .viewer-title')!.textContent).toBe('icon::'))
    expect(type().value).toBe('icon')
    expect(type().disabled).toBe(true)
    expect(document.querySelector('.save-status')?.textContent).toContain('the app’s own')
  })

  // `Status` and `status` are one property, shown in the first spelling met.
  it('counts one property however it is spelled', async () => {
    disk.write('/v/roadmap.md', '---\nStage: draft\n---\n# Roadmap\n')
    disk.write('/v/inbox.md', '---\nstage: done\n---\n# Inbox\n')
    await openApp()
    await openActionsExpanded()
    // One row, counting both notes. Which spelling it shows
    // depends on read order, which is not worth pinning.
    await waitFor(() =>
      expect(rowLabels().filter((text) => text.toLowerCase() === 'stage2')).toHaveLength(1)
    )
  })
})

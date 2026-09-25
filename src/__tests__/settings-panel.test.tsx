/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { SettingsPanel } from '../SettingsPanel'
import { BOUNDS, DEFAULT_SETTINGS, FACES, type Settings } from '../settings'
import type { Sync } from '../useSync'
import type { SyncStatus } from '../sync'

/**
 * The panel, driven the way it is used: a parent holds the `Settings` and the
 * panel reports whole ones back.
 *
 * No `localStorage` and no `matchMedia` stub here, deliberately — the panel reads
 * neither. Storage belongs to `saveSettings` and the OS query to `resolveMode`,
 * both in `settings.ts` and both already covered by `settings.test.ts`, which does
 * carry the Node 26 storage workaround. A test that stubs what it never touches
 * reads as if the panel persisted something.
 *
 * jsdom lays nothing out, so nothing below asserts a size or a position: only
 * structure, ARIA, and what a keystroke changes.
 */

/** Visibly fictional, and every field off the default, so nothing passes by
 *  accidentally matching `DEFAULT_SETTINGS`. */
const START: Settings = {
  ...DEFAULT_SETTINGS,
  mode: 'light',
  scheme: 'moss',
  dailyFolder: 'Logbook',
}

/** A sync with nothing to say, for the sections that are not about it. */
const quietSync = (status: SyncStatus | null = null): Sync => ({
  status,
  phase: 'idle',
  syncedAt: null,
  now: vi.fn(async () => {}),
  configure: vi.fn(async () => {}),
  setToken: vi.fn(async () => {}),
  forgetToken: vi.fn(async () => {}),
})

function Harness({
  settings = START,
  onChange,
  startOpen = true,
  sync = quietSync(),
}: {
  settings?: Settings
  onChange?: () => void
  sync?: Sync
  /** `false` to test the open→close focus round trip, which needs a real opener
   *  that held focus first — jsdom's `click` does not move focus by itself. */
  startOpen?: boolean
}) {
  const [current, setCurrent] = useState(settings)
  const [open, setOpen] = useState(startOpen)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open settings</button>
      {open && (
        <SettingsPanel
          settings={current}
          onChange={(next) => {
            onChange?.()
            setCurrent(next)
          }}
          onClose={() => setOpen(false)}
          sync={sync}
        />
      )}
    </>
  )
}

const rail = (name: string) => screen.getByRole('button', { name })
const keybind = () => screen.getByRole('button', { name: "Open today's page" })

afterEach(cleanup)

describe('the dialog itself', () => {
  it('is a labelled modal that takes focus and gives it back', () => {
    render(<Harness startOpen={false} />)
    const opener = screen.getByRole('button', { name: 'Open settings' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // Labelled *by the title*, not by a duplicated aria-label.
    expect(screen.getByRole('heading', { name: 'Settings' }).id).toBe(
      dialog.getAttribute('aria-labelledby')
    )
    expect(document.activeElement).toBe(dialog)

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // Back to the opener. Without this the caret lands nowhere and the next Tab
    // starts from the top of the document.
    expect(document.activeElement).toBe(opener)
  })

  it('keeps Tab inside itself', () => {
    render(<Harness />)
    const dialog = screen.getByRole('dialog')
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, input'))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    // And backwards off the front edge. jsdom does not move focus on Tab itself,
    // so this asserts the wrap the handler does and nothing else.
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('closes on Escape', () => {
    render(<Harness />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows one section at a time, and the rail says which', () => {
    render(<Harness />)
    expect(screen.getByRole('heading', { name: 'Appearance', level: 3 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Typography', level: 3 })).toBeNull()
    expect(rail('Appearance').className).toContain('active')

    fireEvent.click(rail('Typography'))
    expect(screen.getByRole('heading', { name: 'Typography', level: 3 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Appearance', level: 3 })).toBeNull()
    expect(rail('Typography').className).toContain('active')
    expect(rail('Appearance').className).not.toContain('active')
  })
})

describe('appearance', () => {
  it('reports the mode a radio picks, and the radios are real radios', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const dark = screen.getByRole('radio', { name: 'Dark' })
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveProperty('checked', true)

    fireEvent.click(dark)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(dark).toHaveProperty('checked', true)
  })

  it('carries each swatch its own scheme, which is what the sheet colours off', () => {
    render(<Harness />)
    const ember = screen.getByRole('button', { name: /Ember/ })
    // `data-scheme` is the hook for `.settings-swatch[data-scheme=…]`; losing it
    // leaves five identically coloured swatches.
    expect(ember.getAttribute('data-scheme')).toBe('ember')
    expect(screen.getByRole('button', { name: /Moss/ }).getAttribute('aria-pressed')).toBe('true')
    expect(ember.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(ember)
    expect(ember.getAttribute('aria-pressed')).toBe('true')
    expect(ember.className).toContain('selected')
  })
})

describe('the measure, in characters', () => {
  /**
   * The pairing that shipped wrong once: the prose size moved and the measure
   * silently went from 85 characters to 91 with the width slider untouched. Both
   * of those numbers are pinned here.
   */
  it('reads 85 at the defaults', () => {
    render(<Harness settings={{ ...START, readingWidth: 720, proseSize: 14.5 }} />)
    fireEvent.click(rail('Typography'))
    expect(screen.getByText('720px · 85 characters — wide')).toBeTruthy()
  })

  it('reads 91 at the same width one size down — the widening that shipped', () => {
    render(<Harness settings={{ ...START, readingWidth: 720, proseSize: 13.5 }} />)
    fireEvent.click(rail('Typography'))
    expect(screen.getByText('720px · 91 characters — wide')).toBeTruthy()
  })

  it('moves when the width slider does', () => {
    render(<Harness />)
    fireEvent.click(rail('Typography'))
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '1000' } })
    // (1000 − 80) / (0.516 × 14.5) = 122.9
    expect(screen.getByText('1000px · 122 characters — wide')).toBeTruthy()
  })
})

describe('the reading face', () => {
  const menu = () => screen.getByLabelText('Face') as HTMLSelectElement

  it('offers every face, grouped by category', () => {
    render(<Harness />)
    fireEvent.click(rail('Typography'))
    // Grouped, because eighteen names in one flat list is a wall. The headings
    // are `<optgroup label>`, so they are not options and cannot be chosen — and
    // the labels are asserted, not just the count: an `<optgroup>` with no label
    // still groups, silently, with nothing on screen to say what by.
    expect(Array.from(menu().querySelectorAll('optgroup'), (group) => group.label)).toEqual([
      'Sans',
      'Serif',
      'Mono',
    ])
    expect(menu().options.length).toBe(FACES.length)
    expect(screen.getByRole('option', { name: 'Hoefler Text' })).toBeTruthy()
    // And under the right heading, which is the `filter`.
    expect(screen.getByRole('option', { name: 'Georgia' }).closest('optgroup')?.label).toBe('Serif')
    // The categories the faces replaced are gone as choices.
    expect(screen.queryByRole('option', { name: 'Serif' })).toBeNull()
  })

  it('reports the face picked, by id', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(rail('Typography'))
    expect(menu().value).toBe('system')

    fireEvent.change(menu(), { target: { value: 'iowan-old-style' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    // Back down from the parent's state, so this is the round trip.
    expect(menu().value).toBe('iowan-old-style')
  })

  it('shows each name in its own face, which is what makes it a font menu', () => {
    render(<Harness />)
    fireEvent.click(rail('Typography'))
    const georgia = screen.getByRole('option', { name: 'Georgia' })
    expect(georgia.getAttribute('style')).toContain('Georgia')
  })
})

describe('row spacing', () => {
  /** The slider's ends come from `BOUNDS`, not from three numbers typed into the
   *  JSX: a hand-written `max` is how the panel comes to offer a value
   *  `parseSettings` then clamps away on the next launch. */
  it('offers the bounds it stores', () => {
    render(<Harness />)
    fireEvent.click(rail('Typography'))
    const slider = screen.getByLabelText('Line height')
    expect(slider).toHaveProperty('min', String(BOUNDS.lineHeight.min))
    expect(slider).toHaveProperty('max', String(BOUNDS.lineHeight.max))
  })

  /** Two gaps, two sliders: the note's lines and the panes' rows are read
   *  differently, and the panel is where that becomes visible. */
  it('offers the row gap beside the line gap, each on its own', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(rail('Typography'))

    const rows = screen.getByLabelText('Rows')
    expect(rows).toHaveProperty('max', String(BOUNDS.rowGap.max))
    fireEvent.change(rows, { target: { value: '4' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(rows).toHaveProperty('value', '4')

    // The other slider did not move with it: two numbers, two controls.
    const lines = screen.getByLabelText('Lines') as HTMLInputElement
    expect(lines.value).toBe(String(START.lineGap))
    fireEvent.change(lines, { target: { value: '8' } })
    expect(lines).toHaveProperty('value', '8')
    expect(rows).toHaveProperty('value', '4')
  })

  it('reports the value the slider is dragged to', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(rail('Typography'))
    expect(screen.getByText('1.85')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Line height'), { target: { value: '1.5' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    // The readout follows the value that came back down, so this is the round
    // trip and not the input's own state.
    expect(screen.getByText('1.5')).toBeTruthy()
  })
})

describe('capturing a shortcut', () => {
  it('takes the next keypress as the combo', () => {
    render(<Harness />)
    fireEvent.click(rail('Shortcuts'))
    expect(keybind().textContent).toBe('⇧⌘O')

    fireEvent.click(keybind())
    expect(keybind().className).toContain('capturing')
    // Only modifiers down is not a combo yet: ⌘ alone must not commit — and must
    // not be *refused* either. Without the `comboFromEvent` null guard it reaches
    // `findConflict` as an unreadable combo, which still leaves the button
    // capturing; the absence of a complaint is what tells the two apart.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Meta', metaKey: true })
    expect(keybind().className).toContain('capturing')
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'k', metaKey: true, altKey: true })
    expect(keybind().className).not.toContain('capturing')
    expect(keybind().textContent).toBe('⌥⌘K')
  })

  it('refuses a taken combo, shows why, and does not save it', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(rail('Shortcuts'))
    fireEvent.click(keybind())

    // ⌘B is the editor's own bold, so it is in `EDITOR_COMBOS` and `findConflict`
    // says so rather than letting two things answer one key.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'b', metaKey: true })
    expect(screen.getByText('The editor already uses ⌘B.')).toBeTruthy()
    // The whole point: rejected means never written.
    expect(onChange).not.toHaveBeenCalled()

    // Still capturing, so the next press is the retry; the old combo is intact.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(keybind().textContent).toBe('⇧⌘O')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses a plain key, which would fire mid-sentence', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(rail('Shortcuts'))
    fireEvent.click(keybind())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'k' })
    expect(screen.getByText(/Hold ⌘/)).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('cancels capture on Escape instead of closing the dialog', () => {
    render(<Harness />)
    fireEvent.click(rail('Shortcuts'))
    fireEvent.click(keybind())
    expect(keybind().className).toContain('capturing')

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    // Both halves matter: the capture ended, and the panel is still open.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(keybind().className).not.toContain('capturing')
    expect(keybind().textContent).toBe('⇧⌘O')

    // And Escape closes again once nothing is capturing.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('puts a rebound shortcut back with the reset', () => {
    render(<Harness />)
    fireEvent.click(rail('Shortcuts'))
    fireEvent.click(keybind())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'k', metaKey: true, altKey: true })
    expect(keybind().textContent).toBe('⌥⌘K')

    fireEvent.click(screen.getByRole('button', { name: "Reset Open today's page" }))
    expect(keybind().textContent).toBe('⇧⌘O')
  })
})

describe('the daily folder', () => {
  it('saves a clean name', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(rail('Notes'))
    const input = screen.getByLabelText('Daily notes folder')
    expect(input).toHaveProperty('value', 'Logbook')

    fireEvent.change(input, { target: { value: 'Journal' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(input).toHaveProperty('value', 'Journal')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the reason for a name that cannot go to disk, and saves nothing', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(rail('Notes'))
    const input = screen.getByLabelText('Daily notes folder')

    // A leading dot: `walk` skips dot-prefixed entries, so the folder would exist
    // and never appear. `safeNewName` refuses it rather than folding it.
    fireEvent.change(input, { target: { value: '.hidden' } })
    expect(screen.getByRole('alert').textContent).toContain('starts with a dot')
    expect(onChange).not.toHaveBeenCalled()
    // The typed text stays put, or the field fights whoever is editing it.
    expect(input).toHaveProperty('value', '.hidden')

    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByRole('alert').textContent).toContain('Name required.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('says so when the name will not round-trip', () => {
    render(<Harness />)
    fireEvent.click(rail('Notes'))
    // `safeName` folds `/ \ : * ? " < > |` to `-`, so what is stored differs from
    // what was typed and the panel has to admit it.
    fireEvent.change(screen.getByLabelText('Daily notes folder'), {
      target: { value: 'Day/Book' },
    })
    expect(screen.getByText(/Saved as “Day-Book”/)).toBeTruthy()
  })
})

/** A feed address is a secret: masked until Show, kept only once Add or Enter says
 *  the whole thing has been pasted, and refused unless it is a web address. */
describe('calendar feeds', () => {
  const FEED = 'https://calendar.example/ical/abc/private-xyz/basic.ics'

  it('adds an address on Add, once, and refuses one that is not a web address', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(rail('Calendar'))
    const input = screen.getByLabelText('Add a calendar')
    expect(input).toHaveProperty('type', 'password')
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true)

    fireEvent.change(input, { target: { value: 'not an address' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('alert').textContent).toContain('web address')
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Calendar name'), { target: { value: ' Work ' } })
    fireEvent.change(input, { target: { value: ` ${FEED} ` } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(1)
    // Saved under the name it was given, which is what `source::` will say.
    expect(screen.getByLabelText('Calendar 1')).toHaveProperty('value', FEED)
    expect(screen.getByLabelText('Name of calendar 1')).toHaveProperty('value', 'Work')
    expect(input).toHaveProperty('value', '')
    expect(screen.getByLabelText('Calendar name')).toHaveProperty('value', '')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('masks a saved address until Show, and removes it on Remove', () => {
    render(<Harness settings={{ ...START, calendarFeeds: [{ name: '', url: FEED }] }} />)
    fireEvent.click(rail('Calendar'))
    const saved = screen.getByLabelText('Calendar 1')
    expect(saved).toHaveProperty('type', 'password')
    expect(saved).toHaveProperty('value', FEED)
    // A name is given, or changed, in place: it is not a secret.
    fireEvent.change(screen.getByLabelText('Name of calendar 1'), { target: { value: 'Home' } })
    expect(screen.getByLabelText('Name of calendar 1')).toHaveProperty('value', 'Home')

    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(saved).toHaveProperty('type', 'text')
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(saved).toHaveProperty('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.queryByLabelText('Calendar 1')).toBeNull()
  })

  it('sets the days ahead within the bounds it stores', () => {
    render(<Harness />)
    fireEvent.click(rail('Calendar'))
    const slider = screen.getByLabelText('Days ahead')
    expect(slider).toHaveProperty('max', '60')
    fireEvent.change(slider, { target: { value: '14' } })
    expect(slider).toHaveProperty('value', '14')
    expect(screen.getByText('14 days')).toBeTruthy()
  })
})

/**
 * Sync: one section, whose first line is the sync's one sentence and whose button
 * is the same act at every stage — the first backup and every "now" after it.
 */
describe('sync', () => {
  const REMOTE = 'https://github.com/mira/journal'
  const backedUp: SyncStatus = {
    isRepo: true,
    remote: REMOTE,
    name: 'Mira Vance',
    email: 'mira@example',
    dirty: 0,
    ahead: 0,
    behind: 0,
    lastCommit: 1_700_000_000,
    hasToken: true,
  }

  it('backs a fresh vault up once the identity is typed, in one press', async () => {
    const sync = quietSync({ ...backedUp, isRepo: false, remote: null, name: '', email: '', hasToken: false, lastCommit: null })
    render(<Harness sync={sync} />)
    fireEvent.click(rail('Sync'))
    expect(screen.getByText('Not backed up')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Back up this vault' })
    expect(button).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mira Vance' } })
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'mira@example' } })
    fireEvent.change(screen.getByLabelText('Repository address'), { target: { value: ` ${REMOTE} ` } })
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'ghp_fictional' } })
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    // By hand: the one round that may carry a deletion of more than half the vault.
    await waitFor(() => expect(sync.now).toHaveBeenCalledWith(true))
    expect(sync.configure).toHaveBeenCalledWith(` ${REMOTE} `, 'Mira Vance', 'mira@example')
    expect(sync.setToken).toHaveBeenCalledWith('ghp_fictional')
    // The token is never shown back.
    expect(screen.getByLabelText('Token')).toHaveProperty('value', '')
  })

  it('shows a backed-up vault its state and offers Sync now and Forget token', async () => {
    const sync = { ...quietSync(backedUp), syncedAt: Date.now() - 120_000 }
    render(<Harness sync={sync} />)
    fireEvent.click(rail('Sync'))
    expect(screen.getByText('Synced 2 minutes ago')).toBeTruthy()
    expect(screen.getByLabelText('Repository address')).toHaveProperty('value', REMOTE)
    expect(screen.getByLabelText('Your name')).toHaveProperty('value', 'Mira Vance')
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(sync.now).toHaveBeenCalled())
    // Nothing typed differently, so nothing is re-configured.
    expect(sync.configure).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Forget token' }))
    expect(sync.forgetToken).toHaveBeenCalled()
  })

  it('says when the token is missing, and stores one', async () => {
    const sync = quietSync({ ...backedUp, hasToken: false })
    render(<Harness sync={sync} />)
    fireEvent.click(rail('Sync'))
    expect(screen.getByText('Needs the token')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save token' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: ' ghp_fictional ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))
    await waitFor(() => expect(sync.setToken).toHaveBeenCalledWith('ghp_fictional'))
  })

  it('sets how often a round runs, in the app`s bounds', () => {
    render(<Harness />)
    fireEvent.click(rail('Sync'))
    const slider = screen.getByLabelText('Sync every')
    expect(slider).toHaveProperty('min', '15')
    fireEvent.change(slider, { target: { value: '120' } })
    expect(screen.getByText('2 minutes')).toBeTruthy()
  })
})

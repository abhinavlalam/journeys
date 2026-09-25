/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applySettings,
  applySettingsLive,
  BOUNDS,
  DEFAULT_SETTINGS,
  FACES,
  FACE_IDS,
  faceStack,
  loadSettings,
  parseSettings,
  prefersDarkScheme,
  resolveMode,
  saveSettings,
  SETTINGS_KEY,
  validateDailyFolder,
  settingsJson,
} from '../settings'

let store: Map<string, string>

beforeEach(() => {
  store = new Map()
  // Node 26 ships a gated `localStorage` global that shadows jsdom's — the same
  // workaround as `folderReveal.test.tsx`, without which this file tests nothing.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    },
  })
})

/** jsdom has no `matchMedia`. This one can be flipped, so `mode: 'system'` can be
 *  tested reacting rather than only resolving. */
function stubMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>()
  const mql = {
    matches: dark,
    addEventListener: (_type: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => void listeners.delete(fn),
  }
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => mql,
  })
  return {
    get listenerCount() {
      return listeners.size
    },
    flip(next: boolean) {
      mql.matches = next
      for (const fn of listeners) fn()
    },
  }
}

afterEach(() => {
  const el = document.documentElement
  el.removeAttribute('data-theme')
  el.removeAttribute('data-scheme')
  el.removeAttribute('style')
  Reflect.deleteProperty(globalThis, 'matchMedia')
})

// ---------------------------------------------------------------------------

/**
 * The gap between a list marker and its text, and the step the text sits on.
 *
 * The step is a **measurement**: the indent in a note is space characters and the
 * prose face is proportional, so it has no width CSS can name. `applySettings` is
 * where it is taken, because that already runs on every change to the face and the
 * size — the only two things the answer depends on.
 */
describe('the list marker’s gap', () => {
  it('is a setting, clamped like the rest', () => {
    expect(parseSettings(JSON.stringify({ markerGap: 0.4 })).markerGap).toBe(0.4)
    expect(parseSettings(JSON.stringify({ markerGap: -5 })).markerGap).toBe(BOUNDS.markerGap.min)
    expect(parseSettings(JSON.stringify({ markerGap: 500 })).markerGap).toBe(BOUNDS.markerGap.max)
    expect(parseSettings('{}').markerGap).toBe(DEFAULT_SETTINGS.markerGap)
    expect(parseSettings(JSON.stringify({ markerGap: 'wide' })).markerGap).toBe(
      DEFAULT_SETTINGS.markerGap
    )
  })

  /**
   * **The gap is a share of the step, so it cannot be the whole step.** It was
   * pixels, and 6px of gap against a 2-space step of 7.16px left a 1.16px box for
   * the marker — measured in Chrome, every list's text sat off the grid.
   */
  it('reaches the page as a share of the step, which scales with the indent', () => {
    const root = document.createElement('div')
    applySettings({ ...DEFAULT_SETTINGS, markerGap: 0.25, indentWidth: 4 }, root)
    // Four spaces of *something*: jsdom lays nothing out, so the fallback answers
    // — what matters here is that the token is written and scales with the indent.
    const four = parseFloat(root.style.getPropertyValue('--indent-step'))
    expect(parseFloat(root.style.getPropertyValue('--marker-gap'))).toBeCloseTo(four * 0.25, 5)

    applySettings({ ...DEFAULT_SETTINGS, markerGap: 0.25, indentWidth: 8 }, root)
    const eight = parseFloat(root.style.getPropertyValue('--indent-step'))
    expect(eight).toBeCloseTo(four * 2, 5)
    // And the gap doubles with it, because it is measured in steps.
    expect(parseFloat(root.style.getPropertyValue('--marker-gap'))).toBeCloseTo(eight * 0.25, 5)
  })

  /** A gap can never eat the step the marker sits in: half of one is the end of
   *  the slider, and a stored 6 — the old pixel default — clamps to it. */
  it('cannot be wider than half a step', () => {
    expect(BOUNDS.markerGap.max).toBeLessThanOrEqual(0.5)
    expect(parseSettings(JSON.stringify({ markerGap: 6 })).markerGap).toBe(BOUNDS.markerGap.max)
  })
})

describe('the defaults', () => {
  it('are what index.css already renders', () => {
    // 0.90625rem × 16, and `--line-height-prose` and `--reading-width` from
    // `index.css`'s `:root`. Changing one of these without the sheet makes opening
    // the panel a visible edit.
    expect(DEFAULT_SETTINGS.proseSize).toBeCloseTo(0.90625 * 16, 5)
    expect(DEFAULT_SETTINGS.lineHeight).toBe(1.85)
    // Zero, so a note and a tree are as tight as their leading makes them; the
    // slider adds to both at once.
    expect(DEFAULT_SETTINGS.lineGap).toBe(0)
    expect(DEFAULT_SETTINGS.readingWidth).toBe(640)
    expect(DEFAULT_SETTINGS.mode).toBe('dark')
    expect(DEFAULT_SETTINGS.scheme).toBe('slate')
    // `--font-prose: var(--font-sans)` in the sheet, which is what the System
    // face's stack is — so a fresh install renders in the face it already had.
    expect(DEFAULT_SETTINGS.fontFamily).toBe('system')
    expect(faceStack('system')).toBe('var(--font-sans), sans-serif')
    expect(DEFAULT_SETTINGS.dailyFolder).toBe('Daily')
    expect(DEFAULT_SETTINGS.shortcuts).toEqual({
      openToday: 'mod+shift+o',
      insertTime: 'mod+shift+t'
    })
  })

  it('sit inside their own bounds', () => {
    expect(DEFAULT_SETTINGS.proseSize).toBeGreaterThanOrEqual(BOUNDS.proseSize.min)
    expect(DEFAULT_SETTINGS.proseSize).toBeLessThanOrEqual(BOUNDS.proseSize.max)
    expect(DEFAULT_SETTINGS.lineHeight).toBeGreaterThanOrEqual(BOUNDS.lineHeight.min)
    expect(DEFAULT_SETTINGS.readingWidth).toBeLessThanOrEqual(BOUNDS.readingWidth.max)
  })
})

describe('reading what was stored', () => {
  it('takes the defaults when there is nothing', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('takes the defaults when the JSON is malformed, without throwing', () => {
    expect(parseSettings('{"mode":')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('null')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('7')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('[1,2]')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('"dark"')).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back per field, so one bad value keeps the rest', () => {
    const parsed = parseSettings(
      JSON.stringify({
        mode: 'light',
        scheme: 'aubergine', // not a scheme
        fontFamily: 'georgia',
        proseSize: 'large', // not a number
        lineHeight: 1.8,
        readingWidth: null,
        dailyFolder: null,
        // `shortcuts` absent entirely — an older stored shape.
      })
    )
    expect(parsed.scheme).toBe(DEFAULT_SETTINGS.scheme)
    expect(parsed.proseSize).toBe(DEFAULT_SETTINGS.proseSize)
    expect(parsed.readingWidth).toBe(DEFAULT_SETTINGS.readingWidth)
    expect(parsed.dailyFolder).toBe(DEFAULT_SETTINGS.dailyFolder)
    expect(parsed.shortcuts).toEqual(DEFAULT_SETTINGS.shortcuts)
    // …and the good fields survived.
    expect(parsed.mode).toBe('light')
    expect(parsed.fontFamily).toBe('georgia')
    expect(parsed.lineHeight).toBe(1.8)
  })

  it('clamps a number instead of rendering it', () => {
    const big = parseSettings(
      JSON.stringify({ proseSize: 900, lineHeight: 40, readingWidth: 99999, lineGap: 99 })
    )
    expect(big.proseSize).toBe(BOUNDS.proseSize.max)
    expect(big.lineHeight).toBe(BOUNDS.lineHeight.max)
    expect(big.readingWidth).toBe(BOUNDS.readingWidth.max)
    expect(big.lineGap).toBe(BOUNDS.lineGap.max)

    const small = parseSettings(
      JSON.stringify({ proseSize: 0, lineHeight: -3, readingWidth: 10, lineGap: -4 })
    )
    expect(small.proseSize).toBe(BOUNDS.proseSize.min)
    expect(small.lineHeight).toBe(BOUNDS.lineHeight.min)
    expect(small.readingWidth).toBe(BOUNDS.readingWidth.min)
    expect(small.lineGap).toBe(BOUNDS.lineGap.min)
  })

  /**
   * **The note's gap and the panes' gap are two numbers now.** One slider moved
   * both, on the reasoning that a row is one line of the note tall — but a list of
   * names does not want the air a paragraph does.
   *
   * A vault whose settings were written before the split has only `lineGap`, and
   * that number *was* the row gap, so it is read as both: the vault looks exactly
   * as it did until someone moves the new slider.
   */
  it('gives the rows their own gap, inherited from the old one', () => {
    expect(parseSettings(JSON.stringify({ lineGap: 6 })).rowGap).toBe(6)
    // Written down, it wins.
    expect(parseSettings(JSON.stringify({ lineGap: 6, rowGap: 2 })).rowGap).toBe(2)
    expect(parseSettings('{}').rowGap).toBe(DEFAULT_SETTINGS.rowGap)
    // Clamped like the rest, and a rubbish value falls back rather than rendering.
    expect(parseSettings(JSON.stringify({ rowGap: 99 })).rowGap).toBe(BOUNDS.rowGap.max)
    expect(parseSettings(JSON.stringify({ rowGap: -4 })).rowGap).toBe(BOUNDS.rowGap.min)
    expect(parseSettings(JSON.stringify({ rowGap: 'roomy', lineGap: 3 })).rowGap).toBe(3)
  })

  /**
   * **The note's weight is a setting.** Reported from the running app: the reading
   * pane was harder to read than it should be, and a face's idea of "regular"
   * differs across the eighteen stacks. Anything with a weight of its own — a
   * heading, a `**bold**` run — still sets it.
   */
  it('writes the prose weight, clamped to what a face can carry', () => {
    const root = document.createElement('div')
    applySettings({ ...DEFAULT_SETTINGS, proseWeight: 350 }, root)
    expect(root.style.getPropertyValue('--fw-prose')).toBe('350')
    expect(parseSettings(JSON.stringify({ proseWeight: 900 })).proseWeight).toBe(
      BOUNDS.proseWeight.max
    )
    expect(parseSettings(JSON.stringify({ proseWeight: 100 })).proseWeight).toBe(
      BOUNDS.proseWeight.min
    )
    expect(parseSettings('{}').proseWeight).toBe(400)
  })

  /**
   * **One weight for every glyph, and it is a dial.** A `stroke-width` is in viewBox
   * units, so the same number renders differently on every grid: the set once ran
   * 0.85px to 1.50px across seven hand-written values, with the `+` heaviest of all.
   * The sheet derives each stroke from this one share — see `svg[data-grid]` —
   * measured 0.78px, 1.14px and 1.69px at the ends and the default.
   */
  it('writes the icon weight, clamped like the rest', () => {
    const root = document.createElement('div')
    applySettings({ ...DEFAULT_SETTINGS, iconWeight: 0.1 }, root)
    expect(root.style.getPropertyValue('--icon-weight')).toBe('0.1')
    expect(parseSettings(JSON.stringify({ iconWeight: 9 })).iconWeight).toBe(BOUNDS.iconWeight.max)
    expect(parseSettings(JSON.stringify({ iconWeight: 0 })).iconWeight).toBe(BOUNDS.iconWeight.min)
    expect(parseSettings('{}').iconWeight).toBe(0.088)
  })

  it('writes both gaps to the page, so the panes can differ', () => {
    const root = document.createElement('div')
    applySettings({ ...DEFAULT_SETTINGS, lineGap: 7, rowGap: 2 }, root)
    expect(root.style.getPropertyValue('--line-gap')).toBe('7px')
    expect(root.style.getPropertyValue('--row-gap')).toBe('2px')
  })

  it('rejects NaN and Infinity, which are numbers', () => {
    // They cannot come through `JSON.parse`, but they can come through a slider.
    const parsed = parseSettings(JSON.stringify({ proseSize: null, readingWidth: null }))
    expect(Number.isFinite(parsed.proseSize)).toBe(true)
    expect(parseSettings('{"lineHeight":1e999}').lineHeight).toBe(DEFAULT_SETTINGS.lineHeight)
  })

  it('keeps a rebound shortcut and defaults the unreadable one', () => {
    const parsed = parseSettings(
      JSON.stringify({ shortcuts: { openToday: 'Cmd+Shift+J', insertTime: 'nonsense' } })
    )
    expect(parsed.shortcuts.openToday).toBe('mod+shift+j')
    expect(parsed.shortcuts.insertTime).toBe('mod+shift+t')
  })

  it('survives a stored swap of the two defaults', () => {
    const parsed = parseSettings(
      JSON.stringify({ shortcuts: { openToday: 'mod+shift+t', insertTime: 'mod+shift+o' } })
    )
    expect(parsed.shortcuts).toEqual({
      openToday: 'mod+shift+t',
      insertTime: 'mod+shift+o'
    })
  })

  it('breaks a stored duplicate rather than binding one combo twice', () => {
    const parsed = parseSettings(
      JSON.stringify({ shortcuts: { openToday: 'mod+shift+j', insertTime: 'mod+shift+j' } })
    )
    expect(parsed.shortcuts.openToday).toBe('mod+shift+j')
    expect(parsed.shortcuts.insertTime).toBe('mod+shift+t')
  })

  it('round-trips through storage', () => {
    const settings = { ...DEFAULT_SETTINGS, mode: 'light' as const, proseSize: 17 }
    saveSettings(settings)
    expect(store.get(SETTINGS_KEY)).toContain('"mode":"light"')
    expect(loadSettings()).toEqual(settings)
  })

  it('survives storage that refuses to answer', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('localStorage is not available')
      },
    })
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow()
  })
})

describe('the daily folder', () => {
  it('refuses a leading dot, with vault.ts’s own reason', () => {
    const check = validateDailyFolder('.Journal')
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toMatch(/starts with a dot/)
  })

  it('refuses an empty name', () => {
    expect(validateDailyFolder('   ').ok).toBe(false)
    expect(validateDailyFolder(null).ok).toBe(false)
    expect(validateDailyFolder(undefined).ok).toBe(false)
  })

  it('folds characters a path cannot carry, and says what it saved', () => {
    const check = validateDailyFolder(' Day: notes? ')
    expect(check).toEqual({ ok: true, value: 'Day- notes' })
  })

  it('keeps an ordinary name as typed', () => {
    expect(validateDailyFolder('Journal')).toEqual({ ok: true, value: 'Journal' })
  })

  it('does not let a dot-folder reach the settings object', () => {
    expect(parseSettings(JSON.stringify({ dailyFolder: '.hidden' })).dailyFolder).toBe('Daily')
  })
})

describe('the faces', () => {
  /** The one thing every stack has to do, and the reason it is a list and not a
   *  name: a face that is missing has to fall to its category's other system
   *  faces and then to the generic. A stack that ends on a *named* face ends on
   *  Times, which is nobody's choice of reading face. */
  it('ends every stack in its category’s generic, through its category’s token', () => {
    const generic = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' }
    for (const face of FACES) {
      expect(face.stack.endsWith(`, ${generic[face.category]}`)).toBe(true)
      expect(face.stack).toContain(`var(--font-${face.category})`)
    }
  })

  it('has one entry per id, and a stack for every id', () => {
    expect(new Set(FACE_IDS).size).toBe(FACES.length)
    for (const id of FACE_IDS) expect(faceStack(id)).toBeTruthy()
  })

  /**
   * The three values `fontFamily` held before today. Anyone who chose Serif has
   * one of these on disk, and `pick` alone would read it as unknown and hand back
   * the default — a reset that looks like the app forgetting rather than a
   * migration. Each maps to the face its old stack actually resolved to.
   */
  it('migrates the three old categories onto the faces they rendered as', () => {
    expect(parseSettings(JSON.stringify({ fontFamily: 'sans' })).fontFamily).toBe('system')
    expect(parseSettings(JSON.stringify({ fontFamily: 'serif' })).fontFamily).toBe('new-york')
    expect(parseSettings(JSON.stringify({ fontFamily: 'mono' })).fontFamily).toBe('sf-mono')
  })

  it('still refuses a face that does not exist', () => {
    // Including the shapes a `Record` lookup would have answered for.
    expect(parseSettings(JSON.stringify({ fontFamily: 'papyrus' })).fontFamily).toBe('system')
    expect(parseSettings(JSON.stringify({ fontFamily: 'constructor' })).fontFamily).toBe('system')
    expect(parseSettings(JSON.stringify({ fontFamily: 7 })).fontFamily).toBe('system')
  })

  it('keeps a named face across a save and a load', () => {
    saveSettings({ ...DEFAULT_SETTINGS, fontFamily: 'iowan-old-style' })
    expect(loadSettings().fontFamily).toBe('iowan-old-style')
  })
})

describe('applying to the document', () => {
  it('writes the attributes and the five inline properties', () => {
    applySettings({
      ...DEFAULT_SETTINGS,
      mode: 'light',
      scheme: 'moss',
      fontFamily: 'sf-mono',
      proseSize: 16,
      lineHeight: 1.8,
      readingWidth: 900,
      lineGap: 6,
    })
    const el = document.documentElement
    expect(el.getAttribute('data-theme')).toBe('light')
    expect(el.getAttribute('data-scheme')).toBe('moss')
    expect(el.style.getPropertyValue('--fs-prose')).toBe('16px')
    expect(el.style.getPropertyValue('--line-height-prose')).toBe('1.8')
    expect(el.style.getPropertyValue('--reading-width')).toBe('900px')
    expect(el.style.getPropertyValue('--line-gap')).toBe('6px')
    expect(el.style.getPropertyValue('--font-prose')).toBe(
      "ui-monospace, 'SF Mono', var(--font-mono), monospace"
    )
  })

  it('writes the chosen face’s own stack, not its category’s', () => {
    // The distinction the categories could not make: Georgia and Baskerville are
    // both serif and must not land on the same value.
    applySettings({ ...DEFAULT_SETTINGS, fontFamily: 'georgia' })
    const written = document.documentElement.style.getPropertyValue('--font-prose')
    expect(written).toBe('Georgia, var(--font-serif), serif')
    expect(written).not.toBe(faceStack('baskerville'))
  })

  it('never writes data-theme="system"', () => {
    stubMatchMedia(false)
    applySettings({ ...DEFAULT_SETTINGS, mode: 'system' })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    stubMatchMedia(true)
    applySettings({ ...DEFAULT_SETTINGS, mode: 'system' })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('stays dark when the OS cannot be asked', () => {
    Reflect.deleteProperty(globalThis, 'matchMedia')
    expect(prefersDarkScheme()).toBe(true)
    expect(resolveMode('system')).toBe('dark')
    expect(() => applySettings({ ...DEFAULT_SETTINGS, mode: 'system' })).not.toThrow()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('ignores the OS when the mode is explicit', () => {
    stubMatchMedia(true)
    expect(resolveMode('light')).toBe('light')
    expect(resolveMode('dark')).toBe('dark')
  })
})

describe('following the OS', () => {
  it('re-resolves when the OS theme changes under it', () => {
    const media = stubMatchMedia(true)
    const stop = applySettingsLive({ ...DEFAULT_SETTINGS, mode: 'system' })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    media.flip(false)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    media.flip(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    stop()
  })

  it('tears the listener down', () => {
    const media = stubMatchMedia(true)
    const stop = applySettingsLive({ ...DEFAULT_SETTINGS, mode: 'system' })
    expect(media.listenerCount).toBe(1)
    stop()
    expect(media.listenerCount).toBe(0)
    // And a torn-down watcher does not keep writing.
    media.flip(false)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('subscribes to nothing when the mode is explicit', () => {
    const media = stubMatchMedia(false)
    const stop = applySettingsLive({ ...DEFAULT_SETTINGS, mode: 'dark' })
    expect(media.listenerCount).toBe(0)
    media.flip(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    stop()
  })

  it('does not throw where matchMedia is absent', () => {
    Reflect.deleteProperty(globalThis, 'matchMedia')
    const stop = applySettingsLive({ ...DEFAULT_SETTINGS, mode: 'system' })
    expect(() => stop()).not.toThrow()
  })
})

describe('the indent width', () => {
  it('defaults to two spaces, which is what a markdown list nests on', () => {
    expect(DEFAULT_SETTINGS.indentWidth).toBe(4)
  })

  it('clamps a stored value instead of handing the editor a silly one', () => {
    expect(parseSettings(JSON.stringify({ indentWidth: 99 })).indentWidth).toBe(
      BOUNDS.indentWidth.max
    )
    expect(parseSettings(JSON.stringify({ indentWidth: 0 })).indentWidth).toBe(
      BOUNDS.indentWidth.min
    )
    expect(parseSettings(JSON.stringify({ indentWidth: 'four' })).indentWidth).toBe(4)
  })
})

/**
 * `graphHides`: folders the graph leaves out. No control in the panel, since a list
 * of folders is a thing to type into `settings.json`, so the parse is the whole
 * interface and has to be forgiving of what a hand writes there.
 */
describe('graphHides', () => {
  it('is empty by default and keeps only the strings', () => {
    expect(parseSettings(null).graphHides).toEqual([])
    expect(parseSettings('{"graphHides":["Entities/Currencies", 7, null, ""]}').graphHides).toEqual([
      'Entities/Currencies',
    ])
  })

  it('takes a trailing slash and stray space off, and refuses a non-array', () => {
    expect(parseSettings('{"graphHides":[" Entities/Cards/ "]}').graphHides).toEqual(['Entities/Cards'])
    expect(parseSettings('{"graphHides":"Entities"}').graphHides).toEqual([])
  })

  /** Written back as it was read, so a saved file keeps the list. */
  it('survives a round trip through the file', () => {
    const settings = parseSettings('{"graphHides":["Entities/Currencies"]}')
    expect(parseSettings(settingsJson(settings)).graphHides).toEqual(['Entities/Currencies'])
  })
})

/** The calendar's two: the feed addresses, read like `graphHides`, and how many
 *  days ahead it shows — a number with bounds, like every other number here. */
describe('calendar settings', () => {
  it('keeps a feed as a name and an address, and reads a bare address as one with no name', () => {
    expect(parseSettings(null).calendarFeeds).toEqual([])
    expect(
      parseSettings(
        '{"calendarFeeds":[" https://calendar.example/ical/abc/basic.ics ", {"name":" Work ","url":"https://calendar.example/ical/w/basic.ics"}, {"name":"No address"}, 3, ""]}'
      ).calendarFeeds
    ).toEqual([
      { name: '', url: 'https://calendar.example/ical/abc/basic.ics' },
      { name: 'Work', url: 'https://calendar.example/ical/w/basic.ics' },
    ])
    expect(parseSettings('{"calendarFeeds":"https://calendar.example"}').calendarFeeds).toEqual([])
  })

  it('runs a sync round every minute by default, within its bounds', () => {
    expect(parseSettings(null).syncSeconds).toBe(60)
    expect(parseSettings('{"syncSeconds":300}').syncSeconds).toBe(300)
    expect(parseSettings('{"syncSeconds":1}').syncSeconds).toBe(15)
    expect(parseSettings('{"syncSeconds":"often"}').syncSeconds).toBe(60)
  })

  it('reads the calendar every five minutes by default, within its bounds', () => {
    expect(parseSettings(null).lockMinutes).toBe(5)
    expect(parseSettings('{"lockMinutes":0}').lockMinutes).toBe(1)
    expect(parseSettings(null).calendarMinutes).toBe(5)
    expect(parseSettings('{"calendarMinutes":15}').calendarMinutes).toBe(15)
    expect(parseSettings('{"calendarMinutes":0}').calendarMinutes).toBe(1)
    expect(parseSettings('{"calendarMinutes":"often"}').calendarMinutes).toBe(5)
  })

  it('shows a week by default and clamps the days', () => {
    expect(parseSettings(null).calendarDays).toBe(7)
    expect(parseSettings('{"calendarDays":14}').calendarDays).toBe(14)
    expect(parseSettings('{"calendarDays":400}').calendarDays).toBe(60)
    expect(parseSettings('{"calendarDays":"soon"}').calendarDays).toBe(7)
  })
})

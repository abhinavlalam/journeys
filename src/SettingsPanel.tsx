/**
 * The settings panel: a centred modal over a dimmed app, four sections on a rail.
 *
 * Everything it knows how to decide lives in `settings.ts` and `shortcuts.ts` —
 * this file renders those two and reports a whole new `Settings` upward. It holds
 * no copy of a setting: the only local state is which section is showing, which
 * keybind is capturing, and the daily-folder text *as typed*, which is the one
 * value that can legitimately be mid-edit and invalid.
 *
 * **Not `Settings.tsx`, and this is not a style preference.** macOS is
 * case-insensitive, and `tsconfig.json`'s `include: ["src"]` expansion keeps one
 * file per path-without-extension, keyed case-insensitively, with `.ts` ranked
 * above `.tsx`. A `src/Settings.tsx` beside `src/settings.ts` is therefore dropped
 * from the program: `tsc --noEmit` passes with the panel never type-checked at
 * all, while Vite bundles it anyway. Verified by putting
 * `const n: number = 'no'` in a `src/Probe.tsx` next to a `src/probe.ts` — clean
 * check — and watching it fail the moment the lowercase twin was deleted. Never
 * give a file a name that differs from another in `src` only by case.
 */
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import {
  BOUNDS,
  DEFAULT_SETTINGS,
  FACES,
  MODES,
  SCHEMES,
  validateDailyFolder,
  type FaceCategory,
  type FaceId,
  type Mode,
  type Scheme,
  type Settings,
} from './settings'
import { ACTIONS, comboFromEvent, findConflict, formatCombo, type ActionId } from './shortcuts'
import { characterWidth, COLUMN_PADDING } from './settings'
import { syncWord, type Sync } from './useSync'
import { agoWord } from './clock'

interface SettingsProps {
  settings: Settings
  /** A whole new `Settings`. Live — there is no OK button, so nothing to discard. */
  onChange: (next: Settings) => void
  onClose: () => void
  /** The vault's sync, for its own section. */
  sync: Sync
  /** Which section to open on: the Sync row under Applications opens Sync. */
  initialSection?: SectionId
}

const SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'typography', label: 'Typography' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'notes', label: 'Notes' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'sync', label: 'Sync' },
] as const

/** What a feed address has to be before it is kept: the Rust side answers for
 *  these two schemes and nothing else, so the panel says so here rather than at
 *  the first Sync. */
const FEED_ADDRESS = /^https?:\/\//i

/** The three the repository keeps, in the order they are asked for. */
const SYNC_FIELDS = [
  { key: 'name', label: 'Your name', placeholder: '' },
  { key: 'email', label: 'Your email', placeholder: '' },
  { key: 'remote', label: 'Repository address', placeholder: 'https://github.com/you/journal' },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

/** `MODES` is storage order — dark first, because dark is what ships. Light-first
 *  is the *display* order, so the three read as a ramp with the deferral last.
 *  A rank rather than a second literal list: `MODES` stays the only statement of
 *  which modes exist, and a new one is a type error here instead of a mode that
 *  silently never renders. */
const MODE_RANK: Record<Mode, number> = { light: 0, dark: 1, system: 2 }
const MODE_ORDER = [...MODES].sort((a, b) => MODE_RANK[a] - MODE_RANK[b])

const MODE_LABELS: Record<Mode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

const SCHEME_LABELS: Record<Scheme, string> = {
  slate: 'Slate',
  graphite: 'Graphite',
  moss: 'Moss',
  ember: 'Ember',
  ink: 'Ink',
  midnight: 'Midnight',
}

/** The `<optgroup>` headings, in menu order. A category with no face in `FACES`
 *  renders no group at all, so this list cannot put an empty heading on screen. */
const CATEGORY_ORDER: readonly FaceCategory[] = ['sans', 'serif', 'mono']

const CATEGORY_LABELS: Record<FaceCategory, string> = {
  sans: 'Sans',
  serif: 'Serif',
  mono: 'Mono',
}

// ---------------------------------------------------------------------------
// The measure, in characters
// ---------------------------------------------------------------------------

/**
 * Characters on a line, and whether that is a comfortable number of them.
 *
 * **Measured, not assumed.** This was `EM_PER_CHARACTER = 0.516`, one face's ratio
 * applied to all eighteen — at Helvetica Neue 13.5 it said about 100 where a
 * measured line holds 105. `characterWidth` asks the face, the way the indent step
 * already does.
 *
 * And it says *wide* or *narrow*, because a number alone is not advice: reported
 * from the running app as "readability is poor when a page is long enough", with
 * the column sitting at 105 characters. Forty-five to eighty is the band prose has
 * been set in for a century; past it the eye loses the line it is returning to, and
 * the longer the page the more that costs.
 */
const COMFORTABLE = { from: 45, to: 80 }

function lineCharacters(readingWidth: number, settings: Settings): number {
  return Math.floor((readingWidth - COLUMN_PADDING) / characterWidth(settings))
}

function measureReadout(readingWidth: number, settings: Settings): string {
  const characters = lineCharacters(readingWidth, settings)
  const verdict =
    characters > COMFORTABLE.to ? ' — wide' : characters < COMFORTABLE.from ? ' — narrow' : ''
  return `${readout(readingWidth)}px · ${characters} characters${verdict}`
}

/** `0.5` steps land on floats: `1.7000000000000002` is a real slider value. */
function readout(value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * One slider row: the label, the track, the value.
 *
 * Eight of these were eight copies of the same fourteen lines, and the copies had
 * begun to differ — one carried a hint, its neighbour did not, and the readouts
 * did not all say what their unit was. The `format` is the only thing a row
 * genuinely owns.
 */
function Slider({
  uid,
  name,
  label,
  bounds,
  value,
  onChange,
  format,
}: {
  uid: string
  /** Suffix for the field's own id, so the label and the readout can point at it. */
  name: string
  label: string
  bounds: { min: number; max: number; step: number }
  value: number
  onChange: (value: number) => void
  format: (value: number) => string
}) {
  const id = `${uid}-${name}`
  return (
    <div className="settings-field">
      <label htmlFor={id}>{label}</label>
      <div className="settings-slider">
        <input
          id={id}
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={value}
          // How much of the track is filled. The sheet draws the track itself — a
          // hairline rather than the platform's rail — and a track of our own is
          // not painted half-full by WebKit, so the one place that knows the value
          // hands it over.
          style={{ '--fill': `${((value - bounds.min) / (bounds.max - bounds.min)) * 100}%` } as CSSProperties}
          onChange={(e) => onChange(e.currentTarget.valueAsNumber)}
        />
        <output htmlFor={id}>{format(value)}</output>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const FOCUSABLE = 'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])'

export function SettingsPanel({ settings, onChange, onClose, sync, initialSection = 'appearance' }: SettingsProps) {
  const [section, setSection] = useState<SectionId>(initialSection)
  const [capturing, setCapturing] = useState<ActionId | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  // The folder *as typed*. Held locally because a half-typed name is invalid and
  // must not be pushed up — `settings.dailyFolder` only ever holds a name that
  // passed `validateDailyFolder`.
  const [dailyDraft, setDailyDraft] = useState(settings.dailyFolder)
  // A feed address being typed or pasted, kept until Add or Enter: an address is
  // one string, and committing it a keystroke at a time would save a dozen
  // half-addresses. `shownFeeds` is which of the saved ones are unmasked — a
  // secret address is masked until asked for, per row.
  const [feedDraft, setFeedDraft] = useState({ name: '', url: '' })
  const [feedError, setFeedError] = useState<string | null>(null)
  const [shownFeeds, setShownFeeds] = useState<ReadonlySet<string>>(new Set())
  // The repository's address and the identity, as typed; they go to the repository
  // on Enter or blur, since a half-typed address is not one. Seeded from the
  // repository when it is first read. The token is a draft until saved and is
  // never shown back — it is in the keychain, not in anything the panel reads.
  const [syncDraft, setSyncDraft] = useState({ remote: '', name: '', email: '' })
  const [tokenDraft, setTokenDraft] = useState('')
  const seeded = useRef(false)
  useEffect(() => {
    if (!sync.status || seeded.current) return
    seeded.current = true
    setSyncDraft({ remote: sync.status.remote ?? '', name: sync.status.name, email: sync.status.email })
  }, [sync.status])

  const dialog = useRef<HTMLDivElement>(null)
  const uid = useId()
  const titleId = `${uid}-title`

  // Focus into the dialog on open and back to the opener on close. The opener is
  // read on mount rather than passed in: by the time this unmounts the button
  // that opened it may have been re-rendered, but the node is still the one the
  // browser will accept a focus() on.
  useEffect(() => {
    const opener = document.activeElement
    dialog.current?.focus()
    return () => {
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [])

  const patch = (next: Partial<Settings>) => onChange({ ...settings, ...next })

  /** What is typed goes to the repository — the address, the identity — when it
   *  differs from what the repository holds. */
  async function saveSyncDraft() {
    const s = sync.status
    const same =
      s && (s.remote ?? '') === syncDraft.remote.trim() && s.name === syncDraft.name.trim() && s.email === syncDraft.email.trim()
    if (same) return
    await sync.configure(syncDraft.remote, syncDraft.name, syncDraft.email)
  }
  /** Into the keychain, and out of the field: the panel never shows a token back. */
  async function storeToken() {
    await sync.setToken(tokenDraft.trim())
    setTokenDraft('')
  }
  /** The first backup and every "now" after it are the same act: make sure the
   *  repository knows the address and the identity, then run a round. */
  async function backUpNow() {
    await saveSyncDraft()
    if (tokenDraft.trim()) await storeToken()
    await sync.now(true)
  }

  function addFeed() {
    const url = feedDraft.url.trim()
    if (!FEED_ADDRESS.test(url)) {
      setFeedError('A feed is a web address, starting https://.')
      return
    }
    if (!settings.calendarFeeds.some((one) => one.url === url)) {
      patch({ calendarFeeds: [...settings.calendarFeeds, { name: feedDraft.name.trim(), url }] })
    }
    setFeedDraft({ name: '', url: '' })
    setFeedError(null)
  }

  function startCapture(id: ActionId) {
    setConflict(null)
    setCapturing(id)
  }

  /** A captured or reset combo, or the reason it cannot be used. The rejected
   *  combo is never written — `findConflict` is asked before `onChange`, not
   *  after. */
  function commit(id: ActionId, combo: string) {
    const reason = findConflict(combo, id, settings.shortcuts)
    if (reason) {
      setConflict(reason)
      return
    }
    setConflict(null)
    setCapturing(null)
    patch({ shortcuts: { ...settings.shortcuts, [id]: combo } })
  }

  function resetCombo(id: ActionId) {
    const action = ACTIONS.find((a) => a.id === id)
    if (action) commit(id, action.defaultCombo)
  }

  /**
   * One handler for the whole dialog, because the three jobs are ordered and not
   * independent.
   *
   * While capturing, every keystroke belongs to the capture — including Tab, and
   * including Escape, which **cancels** rather than closing the dialog. Losing
   * that ordering is how Escape ends up shutting the panel out from under someone
   * who only wanted to abandon a rebind.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (capturing) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(null)
        setConflict(null)
        return
      }
      // `null` while only modifiers are down: ⌘ on its own is not a combo yet.
      const combo = comboFromEvent(event)
      if (combo) commit(capturing, combo)
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }

    if (event.key !== 'Tab') return
    const root = dialog.current
    if (!root) return
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1
    )
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const daily = validateDailyFolder(dailyDraft)

  return (
    <div className="settings-overlay">
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={onKeyDown}
      >
        <h2 className="settings-title" id={titleId}>
          Settings
        </h2>
        <button className="settings-close" onClick={onClose} aria-label="Close settings">
          ✕
        </button>

        <div className="settings-body">
          <nav className="settings-rail" aria-label="Settings sections">
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                className={entry.id === section ? 'active' : undefined}
                aria-current={entry.id === section ? 'true' : undefined}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {section === 'appearance' && (
              <section className="settings-section">
                <h3>Appearance</h3>

                <div className="settings-field">
                  <label id={`${uid}-mode`}>Mode</label>
                  <div className="settings-radios" role="radiogroup" aria-labelledby={`${uid}-mode`}>
                    {MODE_ORDER.map((mode) => (
                      <label className="settings-radio" key={mode}>
                        <input
                          type="radio"
                          name={`${uid}-mode-input`}
                          value={mode}
                          checked={settings.mode === mode}
                          onChange={() => patch({ mode })}
                        />
                        {MODE_LABELS[mode]}
                      </label>
                    ))}
                  </div>
                  {settings.mode === 'system' && (
                    <p className="settings-field-hint">Follows the OS, and changes with it.</p>
                  )}
                </div>

                <div className="settings-field">
                  <label id={`${uid}-scheme`}>Scheme</label>
                  <div className="settings-swatches" role="group" aria-labelledby={`${uid}-scheme`}>
                    {SCHEMES.map((scheme) => (
                      <button
                        key={scheme}
                        className={
                          scheme === settings.scheme ? 'settings-swatch selected' : 'settings-swatch'
                        }
                        // The sheet keys each swatch's own accent off this, since a
                        // scheme's colour cannot come from the palette in force.
                        data-scheme={scheme}
                        aria-pressed={scheme === settings.scheme}
                        onClick={() => patch({ scheme })}
                      >
                        {SCHEME_LABELS[scheme]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-field">
                  <label htmlFor={`${uid}-inherit`}>Inherit icons</label>
                  <input
                    id={`${uid}-inherit`}
                    type="checkbox"
                    checked={settings.inheritIcons}
                    onChange={(e) => patch({ inheritIcons: e.currentTarget.checked })}
                  />
                  <p className="settings-field-hint">
                    A folder’s icon is written into the notes inside it that have none.
                  </p>
                </div>
              </section>
            )}

            {section === 'typography' && (
              <section className="settings-section">
                <h3>Typography</h3>

                {/* **Two groups, and the labels are the whole explanation.** Nine
                    controls read as a wall of prose when each carries a sentence,
                    and the sentences said what the label and the readout already
                    say. What is left is the one thing a label cannot: which face
                    the setting reaches. */}
                <p className="settings-group">Text</p>

                {/* A grouped `<select>`, not the radio list this replaced:
                    eighteen faces as radios is eighteen rows in a dialog that is
                    capped and already scrolls, and `<optgroup>` states the
                    category once instead of once per row. The native menu also
                    gives keyboard type-ahead over the names for free. */}
                <div className="settings-field">
                  <label htmlFor={`${uid}-font`}>Face</label>
                  <select
                    id={`${uid}-font`}
                    className="settings-select"
                    value={settings.fontFamily}
                    // Every `<option>` below carries a `FaceId`, so this is the
                    // one place the string can be narrowed back to one.
                    onChange={(e) => patch({ fontFamily: e.currentTarget.value as FaceId })}
                  >
                    {CATEGORY_ORDER.map((category) => (
                      <optgroup key={category} label={CATEGORY_LABELS[category]}>
                        {FACES.filter((face) => face.category === category).map((face) => (
                          // The option in its own face, where the platform honours
                          // it — a font menu that shows the fonts. Cosmetic: a
                          // native popup that ignores it still reads correctly.
                          <option key={face.id} value={face.id} style={{ fontFamily: face.stack }}>
                            {face.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <p className="settings-field-hint">
                    The note’s. The sidebar and code keep their own.
                  </p>
                </div>

                <Slider
                  uid={uid}
                  name="size"
                  label="Size"
                  bounds={BOUNDS.proseSize}
                  value={settings.proseSize}
                  onChange={(proseSize) => patch({ proseSize })}
                  format={(value) => `${readout(value)}px`}
                />
                <Slider
                  uid={uid}
                  name="weight"
                  label="Weight"
                  bounds={BOUNDS.proseWeight}
                  value={settings.proseWeight}
                  onChange={(proseWeight) => patch({ proseWeight })}
                  format={readout}
                />
                {/* Beside the text's weight, because it is the same question for
                    the glyphs: a `stroke-width` is in viewBox units, so the sheet
                    turns this one number into a stroke per grid. */}
                <Slider
                  uid={uid}
                  name="iconweight"
                  label="Icon weight"
                  bounds={BOUNDS.iconWeight}
                  value={settings.iconWeight}
                  onChange={(iconWeight) => patch({ iconWeight })}
                  format={(value) => `${Math.round((value / DEFAULT_SETTINGS.iconWeight) * 100)}%`}
                />
                <Slider
                  uid={uid}
                  name="line"
                  label="Line height"
                  bounds={BOUNDS.lineHeight}
                  value={settings.lineHeight}
                  onChange={(lineHeight) => patch({ lineHeight })}
                  format={readout}
                />
                {/* The measure rides in the readout rather than on a line of its
                    own: it is the number that matters here, and it moves with the
                    *size* as well as the width — which is how a note quietly went
                    from 85 characters to 91 with this slider untouched. */}
                <Slider
                  uid={uid}
                  name="width"
                  label="Width"
                  bounds={BOUNDS.readingWidth}
                  value={settings.readingWidth}
                  onChange={(readingWidth) => patch({ readingWidth })}
                  format={(value) =>
                    measureReadout(value, settings)
                  }
                />

                <p className="settings-group">Spacing</p>

                {/* Between the lines rather than inside them, so it reads as a
                    paragraph gap and not more leading. The rows have their own:
                    one slider moved both for a while, and a list of names does not
                    want the air a paragraph does. */}
                <Slider
                  uid={uid}
                  name="gap"
                  label="Lines"
                  bounds={BOUNDS.lineGap}
                  value={settings.lineGap}
                  onChange={(lineGap) => patch({ lineGap })}
                  format={(value) => `${readout(value)}px`}
                />
                <Slider
                  uid={uid}
                  name="rowgap"
                  label="Rows"
                  bounds={BOUNDS.rowGap}
                  value={settings.rowGap}
                  onChange={(rowGap) => patch({ rowGap })}
                  format={(value) => `${readout(value)}px`}
                />
                <Slider
                  uid={uid}
                  name="indent"
                  label="Indent"
                  bounds={BOUNDS.indentWidth}
                  value={settings.indentWidth}
                  onChange={(indentWidth) => patch({ indentWidth })}
                  format={(value) => `${readout(value)} spaces`}
                />
                {/* A share of one step, not pixels: see `settings.ts`. */}
                <Slider
                  uid={uid}
                  name="marker"
                  label="Marker gap"
                  bounds={BOUNDS.markerGap}
                  value={settings.markerGap}
                  onChange={(markerGap) => patch({ markerGap })}
                  format={(value) => `${Math.round(value * 100)}%`}
                />
              </section>
            )}

            {section === 'shortcuts' && (
              <section className="settings-section">
                <h3>Shortcuts</h3>
                {/* Each row reads across, not down: the sheet turns it with
                    `:has(.settings-keybind)` rather than taking a fifth class. */}
                {ACTIONS.map((action) => (
                  <div className="settings-field" key={action.id}>
                    <label id={`${uid}-${action.id}`}>{action.label}</label>
                    <button
                      className={
                        capturing === action.id ? 'settings-keybind capturing' : 'settings-keybind'
                      }
                      aria-labelledby={`${uid}-${action.id}`}
                      onClick={() => startCapture(action.id)}
                    >
                      {capturing === action.id
                        ? 'Press a key…'
                        : formatCombo(settings.shortcuts[action.id])}
                    </button>
                    <button
                      className="settings-keybind-reset"
                      aria-label={`Reset ${action.label}`}
                      onClick={() => resetCombo(action.id)}
                    >
                      ↺
                    </button>
                  </div>
                ))}
                {conflict && (
                  <p className="settings-conflict" role="alert">
                    {conflict}
                  </p>
                )}
                <p className="settings-field-hint">
                  Escape cancels a capture without changing the shortcut.
                </p>
              </section>
            )}

            {section === 'notes' && (
              <section className="settings-section">
                <h3>Notes</h3>
                <div className="settings-field">
                  <label htmlFor={`${uid}-daily`}>Daily notes folder</label>
                  <input
                    id={`${uid}-daily`}
                    className="settings-text-input"
                    type="text"
                    value={dailyDraft}
                    onChange={(e) => {
                      const typed = e.currentTarget.value
                      setDailyDraft(typed)
                      // Only a name that passes goes up. An invalid one stays in
                      // the box, so the field can be empty mid-edit without the
                      // app losing where its daily notes live.
                      const check = validateDailyFolder(typed)
                      if (check.ok) patch({ dailyFolder: check.value })
                    }}
                  />
                  {daily.ok ? (
                    daily.value !== dailyDraft && (
                      <p className="settings-field-hint">Saved as “{daily.value}”.</p>
                    )
                  ) : (
                    <p className="settings-conflict" role="alert">
                      {daily.reason}
                    </p>
                  )}
                  <p className="settings-field-hint">
                    At the top of the vault. Today’s page goes here.
                  </p>
                </div>
                <Slider
                  uid={uid}
                  name="lock-minutes"
                  label="Lock notes after"
                  bounds={BOUNDS.lockMinutes}
                  value={settings.lockMinutes}
                  onChange={(value) => patch({ lockMinutes: value })}
                  format={(value) => `${value} ${value === 1 ? 'minute' : 'minutes'} unused`}
                />
              </section>
            )}

            {section === 'calendar' && (
              <section className="settings-section">
                <h3>Calendar</h3>
                {/* One row per calendar: its name, typed here and changed here — that
                    name is what `source::` says on every line the sync writes — and
                    the address masked: it is a secret, and anyone holding it can read
                    the calendar. Show unmasks one. */}
                {settings.calendarFeeds.map((feed, at) => {
                  const id = `${uid}-feed-${at}`
                  const shown = shownFeeds.has(feed.url)
                  const rename = (name: string) =>
                    patch({ calendarFeeds: settings.calendarFeeds.map((one) => (one.url === feed.url ? { ...one, name } : one)) })
                  return (
                    <div className="settings-field" key={feed.url}>
                      <label htmlFor={id}>Calendar {at + 1}</label>
                      <div className="settings-inline">
                        <input
                          className="settings-text-input settings-feed-name"
                          type="text"
                          aria-label={`Name of calendar ${at + 1}`}
                          placeholder="Name"
                          value={feed.name}
                          onChange={(e) => rename(e.currentTarget.value)}
                        />
                        <input
                          id={id}
                          className="settings-text-input"
                          type={shown ? 'text' : 'password'}
                          value={feed.url}
                          readOnly
                        />
                        <button
                          className="settings-action"
                          aria-pressed={shown}
                          onClick={() =>
                            setShownFeeds((current) => {
                              const next = new Set(current)
                              if (shown) next.delete(feed.url)
                              else next.add(feed.url)
                              return next
                            })
                          }
                        >
                          {shown ? 'Hide' : 'Show'}
                        </button>
                        <button
                          className="settings-action"
                          onClick={() => patch({ calendarFeeds: settings.calendarFeeds.filter((one) => one.url !== feed.url) })}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )
                })}
                <div className="settings-field">
                  <label htmlFor={`${uid}-feed-new`}>Add a calendar</label>
                  <div className="settings-inline">
                    <input
                      className="settings-text-input settings-feed-name"
                      type="text"
                      aria-label="Calendar name"
                      placeholder="Name"
                      value={feedDraft.name}
                      onChange={(e) => setFeedDraft({ ...feedDraft, name: e.currentTarget.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addFeed()
                      }}
                    />
                    <input
                      id={`${uid}-feed-new`}
                      className="settings-text-input"
                      type="password"
                      placeholder="Secret address in iCal format"
                      value={feedDraft.url}
                      onChange={(e) => {
                        setFeedDraft({ ...feedDraft, url: e.currentTarget.value })
                        setFeedError(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addFeed()
                      }}
                    />
                    <button className="settings-action" onClick={addFeed} disabled={feedDraft.url.trim() === ''}>
                      Add
                    </button>
                  </div>
                  {feedError && (
                    <p className="settings-conflict" role="alert">
                      {feedError}
                    </p>
                  )}
                  <p className="settings-field-hint">
                    In Google Calendar: Settings, the calendar, Integrate calendar, “Secret
                    address in iCal format”. The name is what each event says it came from.
                    Then Sync on the calendar page.
                  </p>
                </div>
                <Slider
                  uid={uid}
                  name="calendar-days"
                  label="Days ahead"
                  bounds={BOUNDS.calendarDays}
                  value={settings.calendarDays}
                  onChange={(value) => patch({ calendarDays: value })}
                  format={(value) => `${value} ${value === 1 ? 'day' : 'days'}`}
                />
                <Slider
                  uid={uid}
                  name="calendar-minutes"
                  label="Check every"
                  bounds={BOUNDS.calendarMinutes}
                  value={settings.calendarMinutes}
                  onChange={(value) => patch({ calendarMinutes: value })}
                  format={(value) => `${value} ${value === 1 ? 'minute' : 'minutes'}`}
                />
              </section>
            )}

            {section === 'sync' && (
              <section className="settings-section">
                <h3>Sync</h3>
                {/* The one sentence, the same one the row under Applications says. */}
                <p className="settings-sync-word">
                  {syncWord(sync)}
                  {sync.status?.lastCommit && (
                    <span className="row-count">last saved {agoWord(sync.status.lastCommit * 1000)}</span>
                  )}
                </p>
                <p className="settings-field-hint">
                  Every change is saved into the vault’s own history here, and pushed to a private
                  repository on GitHub if one is set, so another device can pull it. Nothing is
                  sent until you press Back up. The token stays in the keychain.
                </p>
                {SYNC_FIELDS.map(({ key, label, placeholder }) => (
                  <div className="settings-field" key={key}>
                    <label htmlFor={`${uid}-sync-${key}`}>{label}</label>
                    <input
                      id={`${uid}-sync-${key}`}
                      className="settings-text-input"
                      type="text"
                      placeholder={placeholder}
                      value={syncDraft[key]}
                      onChange={(e) => setSyncDraft({ ...syncDraft, [key]: e.currentTarget.value })}
                      onBlur={() => void saveSyncDraft()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveSyncDraft()
                      }}
                    />
                  </div>
                ))}
                <div className="settings-field">
                  <label htmlFor={`${uid}-sync-token`}>Token</label>
                  <div className="settings-inline">
                    <input
                      id={`${uid}-sync-token`}
                      className="settings-text-input"
                      type="password"
                      placeholder={sync.status?.hasToken ? 'Stored in the keychain' : 'Fine-grained token, Contents: read and write'}
                      value={tokenDraft}
                      onChange={(e) => setTokenDraft(e.currentTarget.value)}
                    />
                    <button
                      className="settings-action"
                      disabled={tokenDraft.trim() === '' || !syncDraft.remote.trim()}
                      onClick={async () => {
                        await saveSyncDraft()
                        await storeToken()
                      }}
                    >
                      Save token
                    </button>
                    {sync.status?.hasToken && (
                      <button className="settings-action" onClick={() => void sync.forgetToken()}>
                        Forget token
                      </button>
                    )}
                  </div>
                </div>
                <div className="settings-field">
                  <span />
                  <div className="settings-inline">
                    <button
                      className="settings-action"
                      disabled={sync.phase === 'working' || !syncDraft.name.trim() || !syncDraft.email.trim()}
                      onClick={() => void backUpNow()}
                    >
                      {sync.status?.remote && sync.status.hasToken ? 'Sync now' : sync.status?.isRepo ? 'Save now' : 'Back up this vault'}
                    </button>
                  </div>
                </div>
                <Slider
                  uid={uid}
                  name="sync-seconds"
                  label="Sync every"
                  bounds={BOUNDS.syncSeconds}
                  value={settings.syncSeconds}
                  onChange={(value) => patch({ syncSeconds: value })}
                  format={(value) => (value < 60 ? `${value} seconds` : `${value / 60} ${value === 60 ? 'minute' : 'minutes'}`)}
                />
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The settings panel: a modal with its sections down the side.
 *
 * The rules are in `settings.ts` and `shortcuts.ts`. This file draws them
 * and sends up a whole new `Settings`. Its only own state is the open
 * section, the key being captured, and the drafts still being typed.
 *
 * It is named `SettingsPanel.tsx` and not `Settings.tsx` on purpose. macOS
 * ignores case, and tsc then keeps only one of `settings.ts` and
 * `Settings.tsx`, so the panel was never type-checked while Vite still
 * built it. Never give two files in `src` names that differ only by case.
 */
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import {
  BOUNDS,
  DEFAULT_SETTINGS,
  FACES,
  MODES,
  SCHEMES,
  validateFolder,
  validateTag,
  type FaceCategory,
  type FaceId,
  type Mode,
  type Scheme,
  type Settings,
} from './settings'
import { ACTIONS, comboFromEvent, findConflict, formatCombo, type ActionId } from './shortcuts'
import { characterWidth, COLUMN_PADDING } from './settings'
import { syncWord, type Sync } from './useSync'
import { agoWord, SECOND_MS } from './clock'
import { numberText } from './properties'

interface SettingsProps {
  settings: Settings
  /** A whole new `Settings`. Changes apply at once; there is no OK button. */
  onChange: (next: Settings) => void
  onClose: () => void
  /** The vault's sync, for its own section. */
  sync: Sync
  /** The section to open on. The Sync row under Applications opens Sync. */
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

/**
 * A feed address must start with one of these. Rust fetches nothing
 * else, so the panel says so now rather than at the first sync.
 */
const FEED_ADDRESS = /^https?:\/\//i

/** What the repository keeps, in the order they are asked for. */
const SYNC_FIELDS = [
  { key: 'name', label: 'Your name', placeholder: '' },
  { key: 'email', label: 'Your email', placeholder: '' },
  { key: 'remote', label: 'Repository address', placeholder: 'https://github.com/you/journal' },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

/**
 * The menu shows light, dark, system. `MODES` stays the one list of
 * modes, so a new mode is a type error here rather than a missing button.
 */
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

/** The menu's groups, in order. A group with no face is not drawn. */
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
 * Characters on a line, and whether that is a comfortable number.
 *
 * Measured from the face (`characterWidth`), not a fixed ratio:
 * a fixed 0.516 said about 100 where a line held 105.
 *
 * Forty-five to eighty reads well. Past that the eye loses its
 * place when it goes back to the start of the next line, so the
 * readout says wide or narrow and not just a number.
 */
const COMFORTABLE = { from: 45, to: 80 }

function lineCharacters(readingWidth: number, settings: Settings): number {
  return Math.floor((readingWidth - COLUMN_PADDING) / characterWidth(settings))
}

function measureReadout(readingWidth: number, settings: Settings): string {
  const characters = lineCharacters(readingWidth, settings)
  const verdict =
    characters > COMFORTABLE.to ? ' — wide' : characters < COMFORTABLE.from ? ' — narrow' : ''
  return `${numberText(readingWidth)}px · ${characters} characters${verdict}`
}

/** One slider row: label, track, value. */
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
  /** Added to the field's id, so the label and the readout can point at it. */
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
          // The sheet draws its own track, which WebKit does not
          // fill, so the fill is passed in.
          style={{ '--fill': `${((value - bounds.min) / (bounds.max - bounds.min)) * 100}%` } as CSSProperties}
          onChange={(e) => onChange(e.currentTarget.valueAsNumber)}
        />
        <output htmlFor={id}>{format(value)}</output>
      </div>
    </div>
  )
}

/**
 * A folder or tag named in a field. Only a valid name goes up; an invalid one stays
 * in the field with its reason, so it can be empty while typing without losing the
 * setting. A name saved other than as typed says so.
 */
function NameSetting({
  uid,
  name,
  label,
  value,
  check,
  onChange,
  hint,
}: {
  uid: string
  name: string
  label: string
  value: string
  check: (typed: string) => { ok: true; value: string } | { ok: false; reason: string }
  onChange: (value: string) => void
  hint: string
}) {
  const [draft, setDraft] = useState(value)
  const read = check(draft)
  return (
    <div className="settings-field">
      <label htmlFor={`${uid}-${name}`}>{label}</label>
      <input
        id={`${uid}-${name}`}
        className="settings-text-input"
        type="text"
        value={draft}
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => {
          const typed = e.currentTarget.value
          setDraft(typed)
          const next = check(typed)
          if (next.ok) onChange(next.value)
        }}
      />
      {read.ok ? (
        read.value !== draft && <p className="settings-field-hint">Saved as “{read.value}”.</p>
      ) : (
        <p className="settings-conflict" role="alert">
          {read.reason}
        </p>
      )}
      <p className="settings-field-hint">{hint}</p>
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
  // A feed being typed or pasted, kept until Add or Enter, so a half address
  // is never saved. `shownFeeds` are the saved addresses shown unmasked.
  const [feedDraft, setFeedDraft] = useState({ name: '', url: '' })
  const [feedError, setFeedError] = useState<string | null>(null)
  const [shownFeeds, setShownFeeds] = useState<ReadonlySet<string>>(new Set())
  // The repository's address and the identity as typed. They are saved on
  // Enter or blur, and seeded from the repository once it is read. The token
  // is a draft until saved and never shown again; it lives in the keychain.
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

  // Focus the dialog on open and give focus back to the opener on close.
  // The opener is read on mount, while it is still the node that had focus.
  useEffect(() => {
    const opener = document.activeElement
    dialog.current?.focus()
    return () => {
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [])

  const patch = (next: Partial<Settings>) => onChange({ ...settings, ...next })

  /** Save the typed address and identity when they differ from the repository's. */
  async function saveSyncDraft() {
    const s = sync.status
    const same =
      s && (s.remote ?? '') === syncDraft.remote.trim() && s.name === syncDraft.name.trim() && s.email === syncDraft.email.trim()
    if (same) return
    await sync.configure(syncDraft.remote, syncDraft.name, syncDraft.email)
  }
  /**
   * Save the token to the keychain and clear the field. A token is never shown again.
   */
  async function storeToken() {
    await sync.setToken(tokenDraft.trim())
    setTokenDraft('')
  }
  /**
   * The first backup and every Sync now do the same: save the
   * address, the identity and the token, then run a round.
   */
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

  /**
   * Save a captured or reset combo, or say why it cannot be
   * used. A combo that conflicts is never saved.
   */
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
   * One key handler for the whole dialog. While a key is being
   * captured, every key goes to the capture, Tab and Escape included.
   * Escape then cancels the capture and does not close the panel.
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
      // `null` while only modifiers are down: ⌘ alone is not a combo.
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
                        // The sheet colours each swatch by its
                        // own scheme, not the one in use.
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

                {/* The labels are enough. Only a hint the label cannot
                    give is kept: which text the setting changes. */}
                <p className="settings-group">Text</p>

                {/* A grouped menu rather than eighteen radio
                    buttons. It also gives type-ahead over the names. */}
                <div className="settings-field">
                  <label htmlFor={`${uid}-font`}>Face</label>
                  <select
                    id={`${uid}-font`}
                    className="settings-select"
                    value={settings.fontFamily}
                    // Every option's value is a `FaceId`.
                    onChange={(e) => patch({ fontFamily: e.currentTarget.value as FaceId })}
                  >
                    {CATEGORY_ORDER.map((category) => (
                      <optgroup key={category} label={CATEGORY_LABELS[category]}>
                        {FACES.filter((face) => face.category === category).map((face) => (
                          // Each option in its own face, where the menu allows it.
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
                  format={(value) => `${numberText(value)}px`}
                />
                <Slider
                  uid={uid}
                  name="weight"
                  label="Weight"
                  bounds={BOUNDS.proseWeight}
                  value={settings.proseWeight}
                  onChange={(proseWeight) => patch({ proseWeight })}
                  format={numberText}
                />
                {/* Next to text weight: the sheet turns this one
                    number into a stroke width for each icon grid. */}
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
                  format={numberText}
                />
                {/* The characters per line are in the readout, since
                    they change with the size as well as the width. */}
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

                {/* Space between lines, not more leading. The rows have their
                    own gap: a list of names does not want a paragraph's air. */}
                <Slider
                  uid={uid}
                  name="gap"
                  label="Lines"
                  bounds={BOUNDS.lineGap}
                  value={settings.lineGap}
                  onChange={(lineGap) => patch({ lineGap })}
                  format={(value) => `${numberText(value)}px`}
                />
                <Slider
                  uid={uid}
                  name="rowgap"
                  label="Rows"
                  bounds={BOUNDS.rowGap}
                  value={settings.rowGap}
                  onChange={(rowGap) => patch({ rowGap })}
                  format={(value) => `${numberText(value)}px`}
                />
                <Slider
                  uid={uid}
                  name="indent"
                  label="Indent"
                  bounds={BOUNDS.indentWidth}
                  value={settings.indentWidth}
                  onChange={(indentWidth) => patch({ indentWidth })}
                  format={(value) => `${numberText(value)} spaces`}
                />
              </section>
            )}

            {section === 'shortcuts' && (
              <section className="settings-section">
                <h3>Shortcuts</h3>
                {/* The sheet lays each row out across with `:has(.settings-keybind)`. */}
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
                <NameSetting
                  uid={uid}
                  name="daily"
                  label="Daily notes folder"
                  value={settings.dailyFolder}
                  check={validateFolder}
                  onChange={(dailyFolder) => patch({ dailyFolder })}
                  hint="At the top of the vault. Today’s page goes here."
                />
                <NameSetting
                  uid={uid}
                  name="files"
                  label="Files folder"
                  value={settings.filesFolder}
                  check={validateFolder}
                  onChange={(filesFolder) => patch({ filesFolder })}
                  hint="At the top of the vault. A photo or file added on the phone, or shared into it, is kept here."
                />
                <NameSetting
                  uid={uid}
                  name="timeline-group"
                  label="Timeline group"
                  value={settings.timelineGroup}
                  check={validateTag}
                  onChange={(timelineGroup) => patch({ timelineGroup })}
                  hint="A tag. A new timeline entry whose tags head no group of their own goes under this one, made at the day’s end if missing."
                />
                <NameSetting
                  uid={uid}
                  name="share-tag"
                  label="Share tag"
                  value={settings.shareTag}
                  check={validateTag}
                  onChange={(shareTag) => patch({ shareTag })}
                  hint="What another app shares into the phone is filed in its day with this tag."
                />
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
                {/* One row per calendar: its name, which every synced line's
                    `source::` carries, and its address, masked because
                    anyone with it can read the calendar. Show unmasks one. */}
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
                {/* The same words the Sync row under Applications shows. */}
                <p className="settings-sync-word">
                  {syncWord(sync)}
                  {sync.status?.lastCommit && (
                    <span className="row-count">last saved {agoWord(sync.status.lastCommit * SECOND_MS)}</span>
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

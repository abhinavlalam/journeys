/**
 * The settings: what each can be, how it is stored, and how it reaches
 * the page. The defaults match `index.css`'s `:root`, so changing
 * nothing in the panel changes nothing on screen; if they ever disagree,
 * the stylesheet is right. No React: pure functions and one DOM write.
 */
import { DAILY_FOLDER, readConfigFile, safeNewName, writeConfigFile } from './vault'
import { SETTINGS_FILE } from './vaultModel'
import { ACTIONS, defaultShortcuts, normalizeCombo, type ActionId } from './shortcuts'

export type { ActionId }

export type Mode = 'dark' | 'light' | 'system'
export type Scheme = 'slate' | 'graphite' | 'moss' | 'ember' | 'ink' | 'midnight'
export type FaceCategory = 'sans' | 'serif' | 'mono'

/**
 * A row in `FACES`. Only used to type the list below, which is where the ids come from.
 */
interface FaceShape {
  id: string
  /** As shown in the menu. */
  name: string
  category: FaceCategory
  /**
   * The face first, then the sheet's token for its category, then the generic family.
   * A stack ending on a named face falls back to Times when that face is missing.
   */
  stack: string
}

/**
 * The faces on offer, in menu order, grouped by `category`. Every one is installed with
 * macOS (checked in `/System/Library/Fonts` and the other font folders); nothing is
 * downloaded. Check for the file before adding one: a missing face is a silent no-op.
 *
 * Two entries start with `ui-serif` and `ui-monospace`, which is how New York and
 * SF Mono are reached: SF Mono's family name is hidden from font matching unless
 * it was installed separately. The quoted names are the fallback for that case.
 */
export const FACES = [
  // The system face is what `--font-sans` already names first, so
  // the default and `:root`'s `--font-prose` are the same value.
  { id: 'system', name: 'System', category: 'sans', stack: 'var(--font-sans), sans-serif' },
  {
    id: 'helvetica-neue',
    name: 'Helvetica Neue',
    category: 'sans',
    stack: "'Helvetica Neue', var(--font-sans), sans-serif",
  },
  {
    id: 'avenir-next',
    name: 'Avenir Next',
    category: 'sans',
    stack: "'Avenir Next', var(--font-sans), sans-serif",
  },
  { id: 'avenir', name: 'Avenir', category: 'sans', stack: 'Avenir, var(--font-sans), sans-serif' },
  { id: 'optima', name: 'Optima', category: 'sans', stack: 'Optima, var(--font-sans), sans-serif' },
  {
    id: 'verdana',
    name: 'Verdana',
    category: 'sans',
    stack: 'Verdana, var(--font-sans), sans-serif',
  },
  {
    id: 'new-york',
    name: 'New York',
    category: 'serif',
    stack: "ui-serif, 'New York', var(--font-serif), serif",
  },
  { id: 'georgia', name: 'Georgia', category: 'serif', stack: 'Georgia, var(--font-serif), serif' },
  {
    id: 'palatino',
    name: 'Palatino',
    category: 'serif',
    stack: 'Palatino, var(--font-serif), serif',
  },
  {
    id: 'iowan-old-style',
    name: 'Iowan Old Style',
    category: 'serif',
    stack: "'Iowan Old Style', var(--font-serif), serif",
  },
  {
    id: 'baskerville',
    name: 'Baskerville',
    category: 'serif',
    stack: 'Baskerville, var(--font-serif), serif',
  },
  { id: 'charter', name: 'Charter', category: 'serif', stack: 'Charter, var(--font-serif), serif' },
  {
    id: 'hoefler-text',
    name: 'Hoefler Text',
    category: 'serif',
    stack: "'Hoefler Text', var(--font-serif), serif",
  },
  {
    id: 'times-new-roman',
    name: 'Times New Roman',
    category: 'serif',
    stack: "'Times New Roman', var(--font-serif), serif",
  },
  {
    id: 'sf-mono',
    name: 'SF Mono',
    category: 'mono',
    stack: "ui-monospace, 'SF Mono', var(--font-mono), monospace",
  },
  { id: 'menlo', name: 'Menlo', category: 'mono', stack: 'Menlo, var(--font-mono), monospace' },
  { id: 'monaco', name: 'Monaco', category: 'mono', stack: 'Monaco, var(--font-mono), monospace' },
  {
    id: 'courier-new',
    name: 'Courier New',
    category: 'mono',
    stack: "'Courier New', var(--font-mono), monospace",
  },
] as const satisfies readonly FaceShape[]

/** An id not in `FACES` is a type error at every call site. */
export type FaceId = (typeof FACES)[number]['id']

export interface Settings {
  mode: Mode
  scheme: Scheme
  /**
   * A face in `FACES`, not a category. Kept under the old key so
   * a stored `'sans'` can still be migrated (see `pickFace`).
   */
  fontFamily: FaceId
  /** px. */
  proseSize: number
  /** Unitless: the note's line height, and a tree row's height with it. */
  lineHeight: number
  /**
   * The weight the note's text is set in. Faces differ in how
   * heavy their regular looks, and this adjusts for it.
   */
  proseWeight: number
  /**
   * How heavy the app's glyphs are drawn, as a share of a glyph's size. The
   * sheet turns it into a stroke width per grid (see `svg[data-grid]`).
   */
  iconWeight: number
  /** px: space between a note's lines. */
  lineGap: number
  /**
   * px: space between the panes' rows. Separate from `lineGap`,
   * because a list of names wants less air than paragraphs. Falls
   * back to `lineGap` for settings written before it existed.
   */
  rowGap: number
  /** px: the note column's outer width, padding included. */
  readingWidth: number
  /**
   * Whether setting a folder's icon also writes it into the notes inside that
   * have none. A note always shows its own icon (see `resolveNoteIcon`).
   */
  inheritIcons: boolean
  /** Spaces per indent level: what Tab inserts, and what Enter steps back by. */
  indentWidth: number
  /** A single path segment under the vault root. */
  dailyFolder: string
  shortcuts: Record<ActionId, string>
  /**
   * Folders the graph leaves out, as vault-relative paths (`Archive/Old`). Useful
   * for notes that every line links, which crowd the graph. Set in `settings.json`;
   * there is no control in the panel.
   */
  graphHides: string[]
  /**
   * Which connections the graph draws, from the checkboxes along
   * its top: links in the text, links in properties, tags.
   */
  graphShows: { text: boolean; property: boolean; tag: boolean }
  /**
   * The calendars Sync reads: each a private iCal address (Google's secret
   * address in iCal format) and a name, which is what `source::` says on
   * every line it writes. An empty name falls back to the feed's own.
   */
  calendarFeeds: CalendarFeed[]
  /** How many days ahead the calendar shows and Sync writes, today included. */
  calendarDays: number
  /** How often, in minutes, the calendar reads its feeds on its own. */
  calendarMinutes: number
  /** How often the vault's sync runs: commit, pull, push. */
  syncSeconds: number
  /** Minutes an unlocked note may go unused before it locks again. */
  lockMinutes: number
}

export interface CalendarFeed {
  name: string
  url: string
}

export const MODES: readonly Mode[] = ['dark', 'light', 'system']
export const SCHEMES: readonly Scheme[] = ['slate', 'graphite', 'moss', 'ember', 'ink', 'midnight']
export const FACE_IDS: readonly FaceId[] = FACES.map((face) => face.id)

/**
 * `--font-prose`'s value for a face. The lookup is built once. An
 * id not in the list can't get here, since `parseSettings`
 * refuses it, but the default is the answer if one does.
 */
const STACKS = new Map<string, string>(FACES.map((face) => [face.id, face.stack]))

export function faceStack(id: FaceId): string {
  return STACKS.get(id) ?? STACKS.get(DEFAULT_SETTINGS.fontFamily)!
}

/**
 * The note column's inset, both sides together, in px. Kept here, not in
 * the sheet, because `applySettings` writes it as `--column-pad` (one side)
 * and `SettingsPanel` takes it off the width for its character count.
 */
export const COLUMN_PADDING = 80

/**
 * The sliders' ends. They are also the limits for stored values,
 * so a hand-edited `proseSize: 900` becomes 24.
 *
 * - `proseSize` 12–24 px: below 12 the sidebar (13 px) would outweigh
 *   the note; at 24 a heading is as big as the widest column allows.
 * - `lineHeight` 1.2–2.2: below 1.2 descenders touch the next line.
 * - `proseWeight` 300–600: 300 is the lightest the stacks have
 *   at reading size; past 600 text is as heavy as a heading.
 * - `iconWeight` 0.06–0.13: below 0.06 a line disappears; past
 *   0.13 the graph's dots and the gear run together.
 * - `lineGap` and `rowGap` 0–12 px: past about 12 a list of rows
 *   stops reading as a list.
 * - `readingWidth` 480–1200 px: 480 leaves a 400 px measure,
 *   about 50 characters, below which prose breaks mid-phrase.
 */
export const BOUNDS = {
  proseSize: { min: 12, max: 24, step: 0.5 },
  lineHeight: { min: 1.2, max: 2.2, step: 0.05 },
  proseWeight: { min: 300, max: 600, step: 25 },
  iconWeight: { min: 0.06, max: 0.13, step: 0.002 },
  lineGap: { min: 0, max: 12, step: 1 },
  rowGap: { min: 0, max: 12, step: 1 },
  readingWidth: { min: 480, max: 1200, step: 10 },
  indentWidth: { min: 2, max: 8, step: 1 },
  calendarDays: { min: 1, max: 60, step: 1 },
  calendarMinutes: { min: 1, max: 60, step: 1 },
  syncSeconds: { min: 15, max: 600, step: 15 },
  lockMinutes: { min: 1, max: 60, step: 1 },
} as const

export const DEFAULT_SETTINGS: Settings = {
  mode: 'dark',
  scheme: 'slate',
  fontFamily: 'system',
  // 0.90625rem at the browser's 16 px root, in the slider's unit.
  proseSize: 14.5,
  // `:root`'s `--line-height-prose`. It sets the rhythm of both
  // panes: a tree row is one note line tall.
  lineHeight: 1.85,
  // Zero for both gaps: the leading is already generous. 400 is
  // a face's regular weight.
  proseWeight: 400,
  // 0.088: about 1.14 px at a 13 px reading size.
  iconWeight: 0.088,
  lineGap: 0,
  rowGap: 0,
  // 640, not 720: after the padding that is about 77 characters
  // at the default size. Past about 80 the eye loses its line.
  readingWidth: 640,
  // Four spaces per level: two looks barely indented in a proportional face.
  indentWidth: 4,
  inheritIcons: true,
  // `vault.ts`'s constant, so this default and `ensureDailyNote`'s can't drift apart.
  dailyFolder: DAILY_FOLDER,
  shortcuts: defaultShortcuts(),
  graphHides: [],
  graphShows: { text: true, property: true, tag: true },
  calendarFeeds: [],
  calendarDays: 7,
  calendarMinutes: 5,
  syncSeconds: 60,
  lockMinutes: 5,
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Matches `journeys:vault` and `journeys:sidebar-width`. */
export const SETTINGS_KEY = 'journeys:settings'

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, value))
}

/**
 * A stored number, clamped. A string, `null`, `NaN` or `Infinity` takes the
 * default: `Number("large")` is `NaN`, so coercing first would render a bad value.
 */
function pickNumber(
  value: unknown,
  bounds: { min: number; max: number },
  fallback: number
): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, bounds) : fallback
}

function pickShortcuts(value: unknown): Record<ActionId, string> {
  const stored = (value ?? {}) as Partial<Record<ActionId, unknown>>
  const out = {} as Record<ActionId, string>
  const taken = new Set<string>()
  for (const action of ACTIONS) {
    const combo = normalizeCombo(stored[action.id])
    // Registry order decides: if one combo is stored twice, the later
    // action gets its default. Swapping two defaults is allowed.
    const chosen = combo && !taken.has(combo) ? combo : action.defaultCombo
    out[action.id] = chosen
    taken.add(chosen)
  }
  return out
}

/**
 * The three categories `fontFamily` held before faces had names, mapped to the face
 * each rendered as. Without this, anyone who chose serif would be silently reset. A
 * `Map`, because `LEGACY['constructor']` on an object literal is a function.
 */
const LEGACY_FACES = new Map<string, FaceId>([
  ['sans', 'system'],
  ['serif', 'new-york'],
  ['mono', 'sf-mono'],
])

function pickFace(value: unknown): FaceId {
  const legacy = typeof value === 'string' ? LEGACY_FACES.get(value) : undefined
  return legacy ?? pick(value, FACE_IDS, DEFAULT_SETTINGS.fontFamily)
}

/**
 * Per field, never the whole object: one bad value doesn't reset
 * the rest. Anything missing, of the wrong type, out of range or
 * from an older shape falls back on its own.
 */
export function parseSettings(raw: unknown): Settings {
  let stored: Partial<Record<keyof Settings, unknown>> = {}
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      // `JSON.parse('7')` and `JSON.parse('null')` both succeed.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        stored = parsed as Partial<Record<keyof Settings, unknown>>
      }
    } catch {
      // Malformed JSON is a missing setting, not an error to throw into a render.
    }
  }

  const daily = validateDailyFolder(stored.dailyFolder)

  return {
    mode: pick(stored.mode, MODES, DEFAULT_SETTINGS.mode),
    scheme: pick(stored.scheme, SCHEMES, DEFAULT_SETTINGS.scheme),
    fontFamily: pickFace(stored.fontFamily),
    proseSize: pickNumber(stored.proseSize, BOUNDS.proseSize, DEFAULT_SETTINGS.proseSize),
    lineHeight: pickNumber(stored.lineHeight, BOUNDS.lineHeight, DEFAULT_SETTINGS.lineHeight),
    proseWeight: pickNumber(stored.proseWeight, BOUNDS.proseWeight, DEFAULT_SETTINGS.proseWeight),
    iconWeight: pickNumber(stored.iconWeight, BOUNDS.iconWeight, DEFAULT_SETTINGS.iconWeight),
    lineGap: pickNumber(stored.lineGap, BOUNDS.lineGap, DEFAULT_SETTINGS.lineGap),
    // Falls back to `lineGap`: a vault written before the two were
    // separate used one number for both, and still looks the same.
    rowGap: pickNumber(
      stored.rowGap,
      BOUNDS.rowGap,
      pickNumber(stored.lineGap, BOUNDS.lineGap, DEFAULT_SETTINGS.rowGap)
    ),
    readingWidth: pickNumber(
      stored.readingWidth,
      BOUNDS.readingWidth,
      DEFAULT_SETTINGS.readingWidth
    ),
    inheritIcons: typeof stored.inheritIcons === 'boolean' ? stored.inheritIcons : true,
    indentWidth: pickNumber(
      stored.indentWidth,
      BOUNDS.indentWidth,
      DEFAULT_SETTINGS.indentWidth
    ),
    dailyFolder: daily.ok ? daily.value : DEFAULT_SETTINGS.dailyFolder,
    shortcuts: pickShortcuts(stored.shortcuts),
    // Trailing slashes off: a folder is named as the tree spells it.
    graphHides: pickStrings(stored.graphHides).map((one) => one.replace(/\/+$/, '')),
    graphShows: pickShows(stored.graphShows),
    calendarFeeds: pickFeeds(stored.calendarFeeds),
    calendarDays: pickNumber(stored.calendarDays, BOUNDS.calendarDays, DEFAULT_SETTINGS.calendarDays),
    calendarMinutes: pickNumber(stored.calendarMinutes, BOUNDS.calendarMinutes, DEFAULT_SETTINGS.calendarMinutes),
    syncSeconds: pickNumber(stored.syncSeconds, BOUNDS.syncSeconds, DEFAULT_SETTINGS.syncSeconds),
    lockMinutes: pickNumber(stored.lockMinutes, BOUNDS.lockMinutes, DEFAULT_SETTINGS.lockMinutes),
  }
}

/**
 * A feed is `{ name, url }`; a bare string is an address with no name, as
 * the first version wrote them. Anything without an address is skipped.
 */
function pickFeeds(value: unknown): CalendarFeed[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((one): CalendarFeed[] => {
    const url = typeof one === 'string' ? one : typeof one?.url === 'string' ? one.url : ''
    if (url.trim() === '') return []
    const name = typeof one?.name === 'string' ? one.name.trim() : ''
    return [{ name, url: url.trim() }]
  })
}

/**
 * The strings in a hand-written array, trimmed, blanks dropped.
 * Anything else is an empty list.
 */
function pickStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map((one) => one.trim())
    : []
}

/** Each checkbox on its own: a kind the file doesn't mention, or gets wrong, is on. */
function pickShows(value: unknown): Settings['graphShows'] {
  const given = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const pick = (kind: keyof Settings['graphShows']) => (typeof given[kind] === 'boolean' ? (given[kind] as boolean) : true)
  return { text: pick('text'), property: pick('property'), tag: pick('tag') }
}

export function loadSettings(): Settings {
  let raw: string | null = null
  try {
    raw = globalThis.localStorage?.getItem(SETTINGS_KEY) ?? null
  } catch {
    // Storage may be missing or refuse to answer; the defaults
    // still make a working app.
  }
  return parseSettings(raw)
}


/**
 * This vault's settings, or null when it has none yet, in which case the caller
 * writes them. A file of nonsense is different: it parses to the defaults and
 * is left exactly as it was, so a half-edited file is never overwritten.
 */
export async function loadVaultSettings(vaultPath: string): Promise<Settings | null> {
  const text = await readConfigFile(vaultPath, SETTINGS_FILE)
  return text === null ? null : parseSettings(text)
}

/**
 * The text of `.config/settings.json`: pretty-printed and ending
 * in a newline, since people open it. One function writes it, so
 * the pane that shows it can't drift from the file.
 */
export function settingsJson(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`
}

export function saveVaultSettings(vaultPath: string, settings: Settings): Promise<void> {
  return writeConfigFile(vaultPath, SETTINGS_FILE, settingsJson(settings))
}

/**
 * Settings without what belongs to the vault: its calendars and the folders
 * its graph hides. The rest is the person's, carried into a vault with no
 * settings yet and kept for the window before one opens. A calendar address
 * is a secret; carried, it once reached another vault's remote.
 */
export function portable(settings: Settings): Settings {
  return { ...settings, calendarFeeds: [], graphHides: [] }
}

export function saveSettings(settings: Settings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(portable(settings)))
  } catch {
    // A settings change isn't worth failing a render over.
  }
}

// ---------------------------------------------------------------------------
// The daily folder
// ---------------------------------------------------------------------------

type FolderCheck = { ok: true; value: string } | { ok: false; reason: string }

/**
 * The typed folder, cleaned, or why it can't be used. Uses
 * `safeNewName`, the app's one rule for names on disk, which also
 * refuses a leading dot (the folder would never appear in the tree).
 *
 * `value` can differ from the input, since `/ \ : * ? " < > |`
 * become `-`, so show it rather than assume it round-trips. One
 * segment only: `ensureDailyNote` doesn't create nested folders.
 */
export function validateDailyFolder(value: unknown): FolderCheck {
  if (typeof value !== 'string') return { ok: false, reason: 'Name required.' }
  try {
    return { ok: true, value: safeNewName(value) }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Reaching the page
// ---------------------------------------------------------------------------

const DARK_QUERY = '(prefers-color-scheme: dark)'

function darkMedia(): MediaQueryList | null {
  // jsdom has no `matchMedia`, and nor does a plain Node import of this file.
  return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(DARK_QUERY) : null
}

/**
 * Dark when the OS can't be asked: the app is dark, and a
 * missing `matchMedia` shouldn't turn it white.
 */
export function prefersDarkScheme(): boolean {
  return darkMedia()?.matches ?? true
}

/**
 * Never the literal `'system'`: `data-theme` names a palette,
 * and there is no palette called system.
 */
export function resolveMode(mode: Mode): 'dark' | 'light' {
  if (mode === 'system') return prefersDarkScheme() ? 'dark' : 'light'
  return mode
}

/**
 * Writes the settings onto the document. Colours go on as attributes; type
 * goes on as inline custom properties, which outrank `:root` and any
 * `[data-scheme]` block, so a scheme can't override the user's sizes.
 */
export function applySettings(settings: Settings, root?: HTMLElement): void {
  const el = root ?? globalThis.document?.documentElement
  if (!el) return
  el.setAttribute('data-theme', resolveMode(settings.mode))
  el.setAttribute('data-scheme', settings.scheme)
  el.style.setProperty('--fs-prose', `${settings.proseSize}px`)
  el.style.setProperty('--line-height-prose', String(settings.lineHeight))
  el.style.setProperty('--fw-prose', String(settings.proseWeight))
  el.style.setProperty('--icon-weight', String(settings.iconWeight))
  el.style.setProperty('--line-gap', `${settings.lineGap}px`)
  el.style.setProperty('--row-gap', `${settings.rowGap}px`)
  el.style.setProperty('--reading-width', `${settings.readingWidth}px`)
  // The column's inset on one side: half of what the panel's
  // character count takes off the width.
  el.style.setProperty('--column-pad', `${COLUMN_PADDING / 2}px`)
  el.style.setProperty('--font-prose', faceStack(settings.fontFamily))
  // A space's width, for how far an indented line's wrapped rows hang.
  el.style.setProperty('--space-w', `${spaceWidth(settings)}px`)
}

/**
 * The width of one space, in px, in the reading face at the reading
 * size. A note's indent is space characters in a proportional face, so
 * it has no width CSS can name; wrapped rows of an indented line hang by
 * this. Measured here because this runs whenever the face or size
 * changes. Falls back to half an em when there is no document (tests).
 */
function spaceWidth(settings: Settings): number {
  // Fifty spaces, so the answer isn't one glyph's rounding.
  return faceWidth(settings, ' '.repeat(50)) ?? settings.proseSize * 0.5
}

/**
 * The average character width, in px, for the reading face and
 * size: what the panel's character count uses. The sample is
 * lowercase prose weighted like English, not an even alphabet.
 */
const SAMPLE = 'the quick brown fox jumps over a lazy dog and then writes it all down '

/** The fallback, 0.516 em, is a good estimate taken from two face and size pairs. */
const EM_PER_CHARACTER = 0.516

export function characterWidth(settings: Settings): number {
  return faceWidth(settings, SAMPLE.repeat(3)) ?? settings.proseSize * EM_PER_CHARACTER
}

/**
 * The average advance of `sample` in the reading face, or null
 * with no document (tests).
 */
function faceWidth(settings: Settings, sample: string): number | null {
  const doc = globalThis.document
  if (!doc?.body) return null
  const probe = doc.createElement('span')
  probe.style.cssText = [
    'position:absolute',
    'visibility:hidden',
    'white-space:pre',
    `font-family:${faceStack(settings.fontFamily)}`,
    `font-size:${settings.proseSize}px`,
  ].join(';')
  probe.textContent = sample
  doc.body.append(probe)
  const width = probe.getBoundingClientRect().width / sample.length
  probe.remove()
  return width || null
}

/**
 * Writes the settings onto the document, and keeps them applied
 * while the OS theme changes. Returns the teardown, so the caller is
 * one effect: `useEffect(() => applySettingsLive(settings),
 * [settings])`. The listener only exists for `mode: 'system'`.
 */
export function applySettingsLive(settings: Settings, root?: HTMLElement): () => void {
  applySettings(settings, root)
  if (settings.mode !== 'system') return () => {}
  const media = darkMedia()
  if (!media || typeof media.addEventListener !== 'function') return () => {}
  const onChange = () => applySettings(settings, root)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

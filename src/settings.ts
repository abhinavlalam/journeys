/**
 * The options panel's model: what a setting can be, how it survives a restart,
 * and how it reaches the page.
 *
 * The defaults are the app as it already renders, read out of `index.css`'s
 * `:root` — so opening the panel and changing nothing must be a no-op. If a
 * default here and the stylesheet ever disagree, the stylesheet is right and this
 * is the copy that has drifted.
 *
 * No React. The panel component and the wiring live above this; everything here is
 * a pure function or a single documented DOM write.
 */
import { DAILY_FOLDER, readConfigFile, safeNewName, writeConfigFile } from './vault'
import { SETTINGS_FILE } from './vaultModel'
import { ACTIONS, defaultShortcuts, normalizeCombo, type ActionId } from './shortcuts'

export type { ActionId }

export type Mode = 'dark' | 'light' | 'system'
export type Scheme = 'slate' | 'graphite' | 'moss' | 'ember' | 'ink' | 'midnight'
export type FaceCategory = 'sans' | 'serif' | 'mono'

/** The shape of a row in `FACES`. Only used to constrain the literal below, which
 *  is where the ids come from — so a face cannot be added without one. */
interface FaceShape {
  id: string
  /** As it reads in the menu. */
  name: string
  category: FaceCategory
  /** The face named first, then the sheet's token for its category, then the
   *  generic. All three parts earn their place: the token carries the rest of the
   *  system faces, and the generic is the floor — a stack that ends on a *named*
   *  face lands on Times when that face is missing, which is the one outcome
   *  nobody chose. */
  stack: string
}

/**
 * The faces on offer, in menu order, grouped by `category` in the panel.
 *
 * **Every one of these is installed with macOS**, checked against
 * `/System/Library/Fonts`, its `Supplemental`, `/Library/Fonts` and
 * `~/Library/Fonts`. Nothing is fetched — a webfont would add a network
 * dependency and a Tauri CSP host, for a font. Do not add a face without looking
 * for its file: an unavailable name is a silent no-op, and the user cannot tell
 * "this face looks like the last one" from "this face is not here".
 *
 * Two entries lead with a `ui-*` keyword rather than the face's own name, and
 * that is deliberate. `ui-serif` and `ui-monospace` are how macOS's own New York
 * and SF Mono are reached: `SFNSMono.ttf`'s family name is dot-prefixed, so it is
 * hidden from font matching and `'SF Mono'` alone finds nothing unless the
 * separate download has been installed. The quoted names stay as the second stop
 * for exactly that case.
 */
export const FACES = [
  // The system face is what `--font-sans` already names first (`-apple-system`),
  // so naming it again here would be a second copy of the same decision — and
  // this way the default and `:root`'s `--font-prose` are the same value.
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

/** Derived, not restated: a face in the list is an id, and an id not in the list
 *  is a type error at every call site. */
export type FaceId = (typeof FACES)[number]['id']

export interface Settings {
  mode: Mode
  scheme: Scheme
  /** A face in `FACES`, not a category. Kept under the old key so a stored
   *  `'sans'` is still there to migrate — see `pickFace`. */
  fontFamily: FaceId
  /** px. */
  proseSize: number
  /** Unitless — the note's line height, and a tree row's height with it. */
  lineHeight: number
  /** px — space *between* lines of a note, and between rows of the tree. */
  /** The weight the note's own text is set in. A face at 400 in one family reads
   *  heavier than another's, and this is the dial for that. */
  proseWeight: number
  /** How heavy the app's own glyphs are drawn, as a share of a glyph's size. A
   *  `stroke-width` is in viewBox units, so the sheet turns this into one per grid
   *  — see `svg[data-grid]` — and every icon in the app moves together. */
  iconWeight: number
  lineGap: number
  /** The same space between the panes' **rows** — the tree, the Actions section
   *  and the two sections at the end of a note. Its own number because a note's
   *  lines and a list of rows are read differently: air between paragraphs is not
   *  the same amount of air as a list of names wants. Inherits `lineGap` when a
   *  vault's settings were written before it existed. */
  rowGap: number
  /** px — the note column's outer width, padding included. */
  readingWidth: number
  /** Whether setting a folder's icon writes it into the notes inside it that have
   *  none of their own. Display is always own-only: see `resolveNoteIcon`. */
  inheritIcons: boolean
  /** Spaces per indent level — what Tab inserts and what a nested list steps by. */
  indentWidth: number
  /** How much of one indent step is the gap between a list marker and its text,
   *  as a share of that step (0–0.5). **A share and not a pixel count**: the step
   *  is measured from the prose face, so a gap in pixels could be — and at the
   *  default 6px against a 2-space step of 7.16px was — the whole step, leaving
   *  the marker no box to sit in and pushing every list's text off the grid. */
  markerGap: number
  /** A single path segment under the vault root. */
  dailyFolder: string
  shortcuts: Record<ActionId, string>
  /**
   * Folders the graph leaves out, as vault-relative paths (`Entities/Currencies`).
   *
   * Measured on the vault this was added for: the two most linked notes were a
   * currency code and a credit card, because every expense line links both. Those
   * are columns, not knowledge, and a graph of them is a diagram of a schema. No
   * control in the panel: a list of folders is a thing to type into `settings.json`,
   * which has the Save for exactly this.
   */
  graphHides: string[]
  /**
   * Calendars the calendar's Sync reads: each a private iCal address — Google's
   * *Secret address in iCal format* — and **the name the owner gives it**, which is
   * what `source::` says on every line it writes. Google's own name for a primary
   * calendar is "Calendar", which says nothing; an empty name falls back to it.
   */
  calendarFeeds: CalendarFeed[]
  /** How many days ahead the calendar shows and Sync writes, today included. */
  calendarDays: number
  /** How often, in minutes, the calendar reads its feeds on its own. */
  calendarMinutes: number
  /** How often the vault's sync runs a round — commit what changed, pull, push. */
  syncSeconds: number
  /** How long, in minutes, an unlocked note may go unused before it locks again. */
  lockMinutes: number
}

export interface CalendarFeed {
  name: string
  url: string
}

export const MODES: readonly Mode[] = ['dark', 'light', 'system']
export const SCHEMES: readonly Scheme[] = ['slate', 'graphite', 'moss', 'ember', 'ink', 'midnight']
export const FACE_IDS: readonly FaceId[] = FACES.map((face) => face.id)

/** `--font-prose`'s value for a face. `FACES` is an ordered list because the menu
 *  needs the order, so the lookup is built once here rather than searched per
 *  call. An id off the list cannot reach this — `parseSettings` refuses it — but
 *  the default is the answer if one ever does. */
const STACKS = new Map<string, string>(FACES.map((face) => [face.id, face.stack]))

export function faceStack(id: FaceId): string {
  return STACKS.get(id) ?? STACKS.get(DEFAULT_SETTINGS.fontFamily)!
}

/**
 * Slider ends, and each one is a judgement rather than a limit of the CSS:
 *
 * - `proseSize` 12–24 px. `--fs-chrome` is 13 px and does not move, so under 12 the
 *   sidebar would shout over the note; the heading scale is in `em` off this, so at
 *   24 an h1 is 37 px, which is as much as `readingWidth`'s top end can hold.
 * - `lineHeight` 1.2–2.2. Under 1.2 descenders touch the line below at these sizes.
 * - `proseWeight` 300–600. Three hundred is the lightest weight the stacks carry
 *   at a reading size, and past 600 the body would be as heavy as a heading.
 * - `iconWeight` 0.06–0.13. A share of a glyph's own size: 0.088 is about 1.14px
 *   at a 13px reading size, under 0.06 a hairline disappears against the ground,
 *   and past 0.13 the dots in the graph and the gear run together.
 * - `lineGap` 0–12 px. Space between the note's lines rather than inside them, so
 *   it reads as a paragraph gap. Zero is the tightest it can be.
 * - `rowGap` 0–12 px. The same for the panes' rows, and its own number: one
 *   slider moved both for a while, on the reasoning that a row is one line of the
 *   note tall, but the amount of air a paragraph wants is not the amount a list of
 *   names wants. Past ~12 a list of rows stops reading as a list.
 * - `readingWidth` 480–1200 px. The column's own padding is 2 × 2.5rem, so 480
 *   leaves a 400 px measure — about 50 characters, the point below which prose
 *   starts breaking mid-phrase.
 *
 * These are the clamps for storage too, not only for the slider: a hand-edited
 * `proseSize: 900` has to come back as 24, not render.
 */
/**
 * The note column's inset, **both sides**, in px.
 *
 * `--reading-width` is the column's outer box, so the text measure is that less
 * this — which is why the number lives here and not in the sheet: `applySettings`
 * writes it out as `--column-pad` (a side) and `SettingsPanel` takes it off the
 * width for the character readout. It was `2.5rem` in four rules and `80` in one
 * function, with nothing holding them together.
 */
export const COLUMN_PADDING = 80

export const BOUNDS = {
  proseSize: { min: 12, max: 24, step: 0.5 },
  lineHeight: { min: 1.2, max: 2.2, step: 0.05 },
  proseWeight: { min: 300, max: 600, step: 25 },
  iconWeight: { min: 0.06, max: 0.13, step: 0.002 },
  lineGap: { min: 0, max: 12, step: 1 },
  rowGap: { min: 0, max: 12, step: 1 },
  readingWidth: { min: 480, max: 1200, step: 10 },
  indentWidth: { min: 2, max: 8, step: 1 },
  markerGap: { min: 0, max: 0.5, step: 0.05 },
  calendarDays: { min: 1, max: 60, step: 1 },
  calendarMinutes: { min: 1, max: 60, step: 1 },
  syncSeconds: { min: 15, max: 600, step: 15 },
  lockMinutes: { min: 1, max: 60, step: 1 },
} as const

export const DEFAULT_SETTINGS: Settings = {
  mode: 'dark',
  scheme: 'slate',
  fontFamily: 'system',
  // 0.90625rem at the browser's 16px root — nothing in the sheet sets a root
  // font-size, so this is the same pixel value, expressed in the unit the slider
  // works in.
  proseSize: 14.5,
  // `:root`'s `--line-height-prose`, which `.markdown-editor .cm-content` takes.
  // 1.85, and it sets the rhythm of *both* panes: a tree row is one line of the
  // note tall, so this slider moves the two together. See `.sidebar` in the sheet.
  lineHeight: 1.85,
  // Zero, both: the leading is already generous, and these are for anyone who
  // reads better with air between lines than inside them.
  // 400: what a face means by "regular", and what the sheet assumed before this
  // was a setting.
  proseWeight: 400,
  // 0.088: the weight the hand-drawn set converged on, measured at 1.14px on a
  // 13px reading size.
  iconWeight: 0.088,
  lineGap: 0,
  rowGap: 0,
  // 640, not 720: less 2 × 2.5rem of padding, that is a 560px measure — about 77
  // characters at the default size, where 720 gave 88. Past roughly 80 the eye
  // starts losing the line it is on, which reads as crowded however much leading
  // the lines have.
  readingWidth: 640,
  // Four. Two is the convention a markdown list *may* nest on, and at this font it
  // steps about 7px — half of what the tree steps, so a nested list read as barely
  // indented beside it. Four lands near the tree's 16px and is the other, older
  // convention. A note already indented by two keeps its two spaces; put the slider
  // back to see them as levels again.
  indentWidth: 4,
  markerGap: 0.25,
  inheritIcons: true,
  // `vault.ts`'s constant rather than a second `'Daily'`, so the default here and
  // `ensureDailyNote`'s fallback cannot drift apart.
  dailyFolder: DAILY_FOLDER,
  shortcuts: defaultShortcuts(),
  graphHides: [],
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

/** A stored number, clamped. A string, a `null`, a `NaN` or an `Infinity` is not a
 *  number and takes the default — `Number("large")` is `NaN`, so coercing first
 *  would turn a bad value into a rendered one. */
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
    // Registry order decides, so a stored map holding one combo twice loses the
    // later action to its default rather than both to nothing. Swapping the two
    // defaults is legal and survives: neither is taken when it is read.
    const chosen = combo && !taken.has(combo) ? combo : action.defaultCombo
    out[action.id] = chosen
    taken.add(chosen)
  }
  return out
}

/**
 * The three categories `fontFamily` held before the faces were named, each onto
 * the face it actually rendered as: `--font-sans` resolved to the system face,
 * and the other two tokens lead with New York and SF Mono. Without this, `pick`
 * sends all three to the default — which is a silent reset for anyone who chose
 * serif, and indistinguishable from the app forgetting.
 *
 * A `Map`, not an object literal: `LEGACY['constructor']` on an object is a
 * function rather than `undefined`, and a stored value is whatever is on disk.
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
 * Per field, never whole-object: one unreadable value must not reset the other
 * seven. Anything absent, of the wrong type, out of range or from an older shape
 * falls back on its own.
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
      // Malformed JSON is a missing setting, not an error to raise into a render.
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
    // **Inherits `lineGap`.** A vault written before the two were separate has one
    // number, and it was applied to both — so it answers for the row gap as well,
    // and that vault looks exactly as it did. The inheritance is the *fallback*,
    // not an alternative source: `rowGap: "roomy"` falls back to the line gap for
    // the same reason a bad `proseSize` falls back to the default.
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
    markerGap: pickNumber(stored.markerGap, BOUNDS.markerGap, DEFAULT_SETTINGS.markerGap),
    dailyFolder: daily.ok ? daily.value : DEFAULT_SETTINGS.dailyFolder,
    shortcuts: pickShortcuts(stored.shortcuts),
    // Trailing slashes off: a folder is named as the tree spells it.
    graphHides: pickStrings(stored.graphHides).map((one) => one.replace(/\/+$/, '')),
    calendarFeeds: pickFeeds(stored.calendarFeeds),
    calendarDays: pickNumber(stored.calendarDays, BOUNDS.calendarDays, DEFAULT_SETTINGS.calendarDays),
    calendarMinutes: pickNumber(stored.calendarMinutes, BOUNDS.calendarMinutes, DEFAULT_SETTINGS.calendarMinutes),
    syncSeconds: pickNumber(stored.syncSeconds, BOUNDS.syncSeconds, DEFAULT_SETTINGS.syncSeconds),
    lockMinutes: pickNumber(stored.lockMinutes, BOUNDS.lockMinutes, DEFAULT_SETTINGS.lockMinutes),
  }
}

/** A feed is `{ name, url }`; a bare string is an address with no name, which is
 *  how the first version wrote them. Anything without an address is not one. */
function pickFeeds(value: unknown): CalendarFeed[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((one): CalendarFeed[] => {
    const url = typeof one === 'string' ? one : typeof one?.url === 'string' ? one.url : ''
    if (url.trim() === '') return []
    const name = typeof one?.name === 'string' ? one.name.trim() : ''
    return [{ name, url: url.trim() }]
  })
}

/** The strings in a hand-written array, trimmed, blanks dropped; anything that is
 *  not an array of strings is none. */
function pickStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map((one) => one.trim())
    : []
}

export function loadSettings(): Settings {
  let raw: string | null = null
  try {
    raw = globalThis.localStorage?.getItem(SETTINGS_KEY) ?? null
  } catch {
    // Storage can be absent or refuse to answer; the defaults are still a whole
    // working app.
  }
  return parseSettings(raw)
}


/**
 * This vault's settings, or null when it has none yet — the caller writes them in
 * that case, which is how `.config` comes to exist.
 *
 * Null and "a file full of nonsense" are deliberately different answers: nonsense
 * parses to the defaults through `parseSettings`, and the file is left exactly as
 * it was found. Overwriting a file we could not read is how someone loses a config
 * they were part way through editing by hand.
 */
export async function loadVaultSettings(vaultPath: string): Promise<Settings | null> {
  const text = await readConfigFile(vaultPath, SETTINGS_FILE)
  return text === null ? null : parseSettings(text)
}

/** The bytes `.config/settings.json` holds. Pretty-printed and newline-terminated:
 *  this is a file someone may open — and now one the app itself shows in a pane, so
 *  one function writes it and that pane cannot drift from the file. */
export function settingsJson(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`
}

export function saveVaultSettings(vaultPath: string, settings: Settings): Promise<void> {
  return writeConfigFile(vaultPath, SETTINGS_FILE, settingsJson(settings))
}

/**
 * Settings less what is **the vault's own**: its calendars, and the folders its
 * graph hides. What is left is the person's, and that much is carried into a vault
 * with no settings yet and kept for the window before one opens. A calendar's
 * address is a secret whose events are written into notes: carried, it reached
 * another vault's remote and was synced into that vault's days.
 */
export function portable(settings: Settings): Settings {
  return { ...settings, calendarFeeds: [], graphHides: [] }
}

export function saveSettings(settings: Settings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(portable(settings)))
  } catch {
    // A settings change is not worth failing a render over.
  }
}

// ---------------------------------------------------------------------------
// The daily folder
// ---------------------------------------------------------------------------

type FolderCheck = { ok: true; value: string } | { ok: false; reason: string }

/**
 * The typed folder, cleaned, or why it cannot be used.
 *
 * Straight through `vault.ts`'s `safeNewName`, which is the app's one rule for a
 * name that goes to disk — including the refusal of a leading dot, since `walk`
 * skips dot-prefixed entries and the folder would exist but never appear. Calling
 * it rather than restating it is the point: a second copy is how the two come to
 * disagree.
 *
 * `value` can differ from the input (`safeName` folds `/ \ : * ? " < > |` to `-`),
 * so show it — "will be saved as …" — rather than assuming it round-trips. One
 * segment only: `ensureDailyNote` calls `mkdir` without `recursive`, so a nested
 * path would not be created even if the characters survived.
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
  // jsdom has no `matchMedia`, and neither does a plain Node import of this file.
  return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(DARK_QUERY) : null
}

/** Defaults to dark when the OS cannot be asked: the shipped app is dark, and a
 *  missing `matchMedia` should not turn it white. */
export function prefersDarkScheme(): boolean {
  return darkMedia()?.matches ?? true
}

/** Never the literal `'system'` — `data-theme` names a palette, and there is no
 *  palette called system. */
export function resolveMode(mode: Mode): 'dark' | 'light' {
  if (mode === 'system') return prefersDarkScheme() ? 'dark' : 'light'
  return mode
}

/**
 * Settings onto the document, once.
 *
 * Colour goes on as attributes because the palettes are CSS's business; type goes
 * on as **inline** custom properties because it is not. An inline property on the
 * root element outranks both `:root` and any `[data-scheme]` block, so a scheme
 * that ships its own type sizes still loses to what the user set — which is the
 * whole reason these five are written here instead of in a stylesheet.
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
  // The column's inset, a side: half of what the panel's character readout takes
  // off the width. The sheet used to name `2.5rem` in four places and the readout
  // named 80 in one, and nothing held the two together.
  el.style.setProperty('--column-pad', `${COLUMN_PADDING / 2}px`)
  el.style.setProperty('--font-prose', faceStack(settings.fontFamily))
  // One space and the step it makes: a list marker's box is a whole number of
  // steps less the spaces already on its line, so the sheet needs both.
  const space = spaceWidth(settings)
  const step = settings.indentWidth * space
  el.style.setProperty('--space-w', `${space}px`)
  el.style.setProperty('--indent-step', `${step}px`)
  el.style.setProperty('--marker-gap', `${settings.markerGap * step}px`)
}

/**
 * One space wide, in pixels, for the reading face at the reading size.
 *
 * **A measurement, and the one place in the app that needs one.** The indent in a
 * note is made of space *characters*, and the prose face is proportional, so a
 * step has no width CSS can name — the guide lines dodge this by marking the
 * spaces themselves (see `editorPreview`), but a list marker at the first level has
 * no spaces to sit on and has to be given a width.
 *
 * Measured here rather than anywhere else because this function already runs on
 * every change to the face and the size, which are the only two things the answer
 * depends on. Nothing has to remember to re-measure.
 *
 * Falls back to a reasonable half-em where there is no document to measure in
 * (tests, and any non-browser caller).
 */
function spaceWidth(settings: Settings): number {
  // Fifty of them, so the answer is not one rounding of one glyph.
  return faceWidth(settings, ' '.repeat(50)) ?? settings.proseSize * 0.5
}

/**
 * The average character, in pixels, for the reading face at the reading size —
 * which is what a **measure** is counted in.
 *
 * The settings panel had this as `EM_PER_CHARACTER = 0.516`, a constant taken from
 * one face and applied to all eighteen. At Helvetica Neue 13.5 it reported about
 * 100 characters where a measured line holds 105, and the error moves with the
 * face. The app already measures the face here for the indent step, on every change
 * to the only two things either answer depends on, so the constant had no reason to
 * exist.
 *
 * The sample is lowercase prose plus a space, weighted the way English is rather
 * than as an even run of the alphabet — `e` and `a` are not `m` and `w`.
 */
const SAMPLE = 'the quick brown fox jumps over a lazy dog and then writes it all down '

/**
 * The fallback is the constant this replaced — `0.516em`, taken from two pinned
 * pairings in the sheet — because it is a good estimate and the wrong thing to do
 * with no document is not to invent a rounder one.
 */
const EM_PER_CHARACTER = 0.516

export function characterWidth(settings: Settings): number {
  return faceWidth(settings, SAMPLE.repeat(3)) ?? settings.proseSize * EM_PER_CHARACTER
}

/** The average advance of `sample` in the reading face, or null with no document
 *  to measure in (tests, and any non-browser caller). */
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
 * Settings onto the document, and kept there while the OS theme changes.
 *
 * Returns the teardown, so the caller is one effect:
 *
 *     useEffect(() => applySettingsLive(settings), [settings])
 *
 * The listener exists only for `mode: 'system'`; resolving at load alone is what
 * leaves the app light at dusk until it is restarted.
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

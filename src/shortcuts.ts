import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdownKeymap } from '@codemirror/lang-markdown'
import { formatKeymap } from './editorCommands'

/**
 * Key combos: one text form, one matcher, one list of what is taken.
 *
 * The text form is what is stored and what a capture field returns: lower
 * case, joined by `+`, modifiers in a fixed order
 * (`mod+ctrl+alt+shift+key`). Only `formatCombo` draws symbols.
 *
 * `mod` is `metaKey` on every platform; the app ships for macOS only. For
 * another platform, `matchesCombo` and `formatCombo` are the places to change.
 */

// ---------------------------------------------------------------------------
// The action registry
// ---------------------------------------------------------------------------

export type ActionId = 'openToday' | 'insertTime'

interface Action {
  id: ActionId
  label: string
  defaultCombo: string
}

/**
 * A new action is an entry here plus its handler. Where the
 * handler is installed makes it the window's (`openToday` in
 * `App`) or the editor's (`insertTime` in `MarkdownEditor`).
 */
export const ACTIONS: readonly Action[] = [
  { id: 'openToday', label: "Open today's page", defaultCombo: 'mod+shift+o' },
  { id: 'insertTime', label: 'Insert current time', defaultCombo: 'mod+shift+t' },
]

export function defaultShortcuts(): Record<ActionId, string> {
  const out = {} as Record<ActionId, string>
  for (const action of ACTIONS) out[action.id] = action.defaultCombo
  return out
}

// ---------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------

interface Combo {
  /** ⌘. */
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** The key's name: one lower-case character, or one of `NAMED_KEYS`. */
  key: string
}

/** What `matchesCombo` needs. A `KeyboardEvent` has it. */
interface KeyChord {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const MOD_ALIASES: Record<string, keyof Omit<Combo, 'key'>> = {
  mod: 'mod',
  cmd: 'mod',
  command: 'mod',
  meta: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  shift: 'shift',
}

/**
 * Key names are `event.key` in lower case, so `Enter` is `enter`. The space bar is
 * the exception: its `event.key` is `' '`, which cannot sit in a `+`-joined string.
 */
const NAMED_KEYS = new Set([
  'enter',
  'backspace',
  'delete',
  'tab',
  'space',
  'escape',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'home',
  'end',
  'pageup',
  'pagedown',
])

const KEY_ALIASES: Record<string, string> = {
  return: 'enter',
  del: 'delete',
  esc: 'escape',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  spacebar: 'space',
}

const MODIFIER_KEY_NAMES = new Set(['shift', 'control', 'alt', 'meta', 'capslock', 'dead'])

const FUNCTION_KEY = /^f([1-9]|1[0-2])$/

/**
 * The name of a pressed key: `event.key` in lower case, so a remapped
 * layout follows the printed letter and a shifted `O` reads as `o`.
 */
function keyFromEvent(event: KeyChord): string {
  return event.key === ' ' ? 'space' : event.key.toLowerCase()
}

function comboToText(combo: Combo): string {
  const parts: string[] = []
  if (combo.mod) parts.push('mod')
  if (combo.ctrl) parts.push('ctrl')
  if (combo.alt) parts.push('alt')
  if (combo.shift) parts.push('shift')
  parts.push(combo.key)
  return parts.join('+')
}

/**
 * `null` for anything it cannot represent, never a throw: storage
 * and a capture field both feed it. `+` itself cannot be bound.
 */
export function parseCombo(text: unknown): Combo | null {
  if (typeof text !== 'string') return null
  const parts = text
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return null

  const combo: Combo = { mod: false, ctrl: false, alt: false, shift: false, key: '' }
  for (const part of parts) {
    const modifier = MOD_ALIASES[part]
    if (modifier) {
      combo[modifier] = true
      continue
    }
    if (combo.key) return null
    const key = KEY_ALIASES[part] ?? part
    if (MODIFIER_KEY_NAMES.has(key)) return null
    if (key.length !== 1 && !NAMED_KEYS.has(key) && !FUNCTION_KEY.test(key)) return null
    combo.key = key
  }
  return combo.key ? combo : null
}

/** The stored form, or `null` if the text is not a combo. */
export function normalizeCombo(text: unknown): string | null {
  const combo = parseCombo(text)
  return combo && comboToText(combo)
}

const KEY_SYMBOLS: Record<string, string> = {
  enter: '↩',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  space: 'Space',
  escape: '⎋',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  pageup: 'Page Up',
  pagedown: 'Page Down',
  home: 'Home',
  end: 'End',
}

/** macOS order, ⌃⌥⇧⌘ then the key, which differs from the text form's. */
export function formatCombo(combo: string | Combo): string {
  const parsed = typeof combo === 'string' ? parseCombo(combo) : combo
  if (!parsed) return ''
  return (
    (parsed.ctrl ? '⌃' : '') +
    (parsed.alt ? '⌥' : '') +
    (parsed.shift ? '⇧' : '') +
    (parsed.mod ? '⌘' : '') +
    (KEY_SYMBOLS[parsed.key] ?? parsed.key.toUpperCase())
  )
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Every modifier must match exactly, not just be present, so
 * ⌘⌥⇧O does not also fire ⇧⌘O.
 */
export function matchesCombo(event: KeyChord, combo: string | Combo): boolean {
  const parsed = typeof combo === 'string' ? parseCombo(combo) : combo
  if (!parsed) return false
  return (
    event.metaKey === parsed.mod &&
    event.ctrlKey === parsed.ctrl &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift &&
    keyFromEvent(event) === parsed.key
  )
}

/**
 * For a capture field: the combo just pressed, or `null` while only modifiers are down.
 */
export function comboFromEvent(event: KeyChord): string | null {
  const key = keyFromEvent(event)
  if (MODIFIER_KEY_NAMES.has(key)) return null
  return comboToText({
    mod: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    key,
  })
}

// ---------------------------------------------------------------------------
// What is already taken
// ---------------------------------------------------------------------------

interface Reservation {
  combo: string
  reason: string
}

/**
 * What the editor already binds, read from the keymaps it installs, including the
 * app's own ⌘B, ⌘I and ⌘E. A hand-copied list went stale when the editor changed.
 * Combos with no modifier are dropped, since `findConflict` refuses those first.
 */
export const EDITOR_COMBOS: ReadonlySet<string> = new Set(
  [...defaultKeymap, ...historyKeymap, ...markdownKeymap, indentWithTab, ...formatKeymap]
    .flatMap((binding) => [binding.key, 'mac' in binding ? binding.mac : undefined])
    .flatMap((key) => (typeof key === 'string' ? [normalizeCombo(key.replace(/-/g, '+'))] : []))
    .filter((combo): combo is string => !!combo && combo.includes('+'))
)

/** The way into Settings, which no one can rebind. */
export const SETTINGS_COMBO = 'mod+,'

/**
 * The rest, from outside the editor: what the webview and macOS take, and the way into
 * Settings. Kept short, since a wrong guess refuses a shortcut that would have worked.
 */
export const RESERVED_COMBOS: readonly Reservation[] = [
  // The way into Settings. If it could be rebound and then
  // forgotten, only the gear would lead back.
  { combo: SETTINGS_COMBO, reason: '⌘, opens Settings.' },
  // The webview, above the editor.
  { combo: 'mod+c', reason: '⌘C is copy.' },
  { combo: 'mod+x', reason: '⌘X is cut.' },
  { combo: 'mod+v', reason: '⌘V is paste.' },
  // macOS itself; the window never sees these.
  { combo: 'mod+q', reason: '⌘Q quits the app.' },
  { combo: 'mod+shift+q', reason: '⇧⌘Q is macOS log out.' },
  { combo: 'mod+w', reason: '⌘W closes the window.' },
  { combo: 'mod+m', reason: '⌘M minimises the window.' },
  { combo: 'mod+h', reason: '⌘H hides the app.' },
  { combo: 'mod+tab', reason: '⌘⇥ switches apps.' },
  { combo: 'mod+space', reason: '⌘Space opens Spotlight.' },
  { combo: 'mod+shift+3', reason: '⇧⌘3 takes a screenshot.' },
  { combo: 'mod+shift+4', reason: '⇧⌘4 takes a screenshot.' },
  { combo: 'mod+shift+5', reason: '⇧⌘5 opens the screen recorder.' },
]

/**
 * Why `combo` cannot be bound to `actionId`, or `null` if it can. `shortcuts` is
 * the whole current map, so a rebind is checked against the other actions too.
 */
export function findConflict(
  combo: unknown,
  actionId: ActionId,
  shortcuts: Partial<Record<ActionId, string>>
): string | null {
  const canonical = normalizeCombo(combo)
  const parsed = canonical && parseCombo(canonical)
  if (!canonical || !parsed) return 'That is not a shortcut Journeys can read.'

  // Shift alone does not count: ⇧O is typing.
  if (!parsed.mod && !parsed.ctrl && !parsed.alt) {
    return 'Hold ⌘, ⌥ or ⌃ — a plain key would fire while you type.'
  }

  if (EDITOR_COMBOS.has(canonical)) {
    return `The editor already uses ${formatCombo(canonical)}.`
  }

  const reserved = RESERVED_COMBOS.find((entry) => entry.combo === canonical)
  if (reserved) return reserved.reason

  for (const action of ACTIONS) {
    if (action.id === actionId) continue
    if (normalizeCombo(shortcuts[action.id]) === canonical) {
      return `${action.label} already uses ${formatCombo(canonical)}.`
    }
  }
  return null
}

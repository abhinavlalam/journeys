import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdownKeymap } from '@codemirror/lang-markdown'
import { formatKeymap } from './editorCommands'

/**
 * Key combos: one text form, one matcher, one list of what is already taken.
 *
 * The text form is what goes to storage and comes back from a capture field —
 * lowercase, `+`-joined, modifiers in a fixed order: `mod+ctrl+alt+shift+key`.
 * `formatCombo` is the only thing that renders symbols, so nothing else has to
 * know that ⌘ comes last on macOS while `mod` comes first in the text form.
 *
 * **`mod` is `metaKey`, on every platform.** `App.tsx` and `Editor.tsx` both
 * require `metaKey` outright rather than switching on the platform, and this app
 * bundles for macOS only; a platform switch here would silently give the matcher
 * behaviour the two existing listeners do not have. If Journeys ever ships for
 * Windows, `matchesCombo` and `formatCombo` are the two places to change.
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
 * Adding a third action is this list plus its handler — nothing else here.
 *
 * There was a `scope: 'window' | 'editor'` beside each one, and nothing read it:
 * *where* a shortcut is installed is what makes it the window's or the editor's —
 * `openToday` is a `window` listener in `App` and `insertTime` is a keymap inside
 * `MarkdownEditor` — and that is code. The field only restated it, and its comment
 * pointed at `Editor.tsx`, a file two rewrites gone.
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
  /** Canonical key name: a single lowercased character, or one of `NAMED_KEYS`. */
  key: string
}

/** The shape `matchesCombo` needs — a `KeyboardEvent` satisfies it. */
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
 * Canonical names are the lowercased `event.key`, so `Enter` is `enter` and no
 * table is needed to go from an event to a combo. The space bar is the one
 * exception — its `event.key` is `' '`, which cannot survive a `+`-joined string.
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

/** The canonical key name for a pressed key. `event.key`, lowercased — the rule
 *  the two existing listeners use, so a remapped layout follows the printed letter
 *  and a shifted `O` still reads as `o`. */
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

/** `null` for anything this module cannot represent — never a throw, since both
 *  storage and a capture field feed it. `+` itself cannot be bound. */
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

/** macOS order — ⌃⌥⇧⌘ then the key — which is not the text form's order. */
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
 * Every modifier is compared for equality, not merely required. That is what the
 * two existing listeners do — `metaKey && shiftKey && !altKey && !ctrlKey` — and
 * it is the half that stops ⌘⌥⇧O from also firing ⇧⌘O.
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

/** For a capture field: the combo just pressed, or `null` while only modifiers are
 *  down. */
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
 * What the editor already binds, **read out of the keymaps that are installed**.
 *
 * The list this replaces was a hand-copy of Milkdown's and ProseMirror's keymaps,
 * from when the note pane was Crepe. Those packages are gone, so it reserved two
 * dozen combos nothing binds any more (⌥⌘1 for a heading, ⇧⌘B for a quote) while
 * missing what CodeMirror actually takes. Its own comment admitted the flaw — "this
 * list is a copy of someone else's keymap, and copies drift" — so it is derived now
 * and cannot.
 *
 * `formatKeymap` is in here too: ⌘B, ⌘I and ⌘E are this app's own, and they are as
 * unavailable as CodeMirror's. Combos with no modifier are dropped, because
 * `findConflict` refuses those a step earlier anyway.
 */
export const EDITOR_COMBOS: ReadonlySet<string> = new Set(
  [...defaultKeymap, ...historyKeymap, ...markdownKeymap, indentWithTab, ...formatKeymap]
    .flatMap((binding) => [binding.key, 'mac' in binding ? binding.mac : undefined])
    .flatMap((key) => (typeof key === 'string' ? [normalizeCombo(key.replace(/-/g, '+'))] : []))
    .filter((combo): combo is string => !!combo && combo.includes('+'))
)

/**
 * The rest, which is not in anyone's source tree here: what the webview takes above
 * the editor, what macOS takes above the window, and the panel's own way in.
 *
 * Deliberately few. A guessed reservation refuses a shortcut that would have
 * worked, which is worse than letting one through.
 */
/** The panel's own way in, and not an action anyone can rebind. */
export const SETTINGS_COMBO = 'mod+,'

export const RESERVED_COMBOS: readonly Reservation[] = [
  // The panel's own way in. Bindable otherwise, and then the gear is the only
  // route back to Settings — which is fine until the binding is forgotten.
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
 * Why `combo` cannot be bound to `actionId`, or `null` if it can.
 *
 * `shortcuts` is the whole current map, so rebinding one action is also checked
 * against the others — which is the collision the reserved list cannot see.
 */
export function findConflict(
  combo: unknown,
  actionId: ActionId,
  shortcuts: Partial<Record<ActionId, string>>
): string | null {
  const canonical = normalizeCombo(combo)
  const parsed = canonical && parseCombo(canonical)
  if (!canonical || !parsed) return 'That is not a shortcut Journeys can read.'

  // Shift alone is not a modifier for this purpose: ⇧O is typing.
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

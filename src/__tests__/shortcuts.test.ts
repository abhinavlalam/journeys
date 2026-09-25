/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  comboFromEvent,
  defaultShortcuts,
  findConflict,
  formatCombo,
  matchesCombo,
  normalizeCombo,
  parseCombo,
  EDITOR_COMBOS,
  RESERVED_COMBOS,
} from '../shortcuts'

const press = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
  new KeyboardEvent('keydown', { key, ...mods })

/**
 * The condition `App.tsx` matches ⌘⇧O with, copied verbatim from lines 80–81.
 * `matchesCombo('mod+shift+o')` has to agree with it on every modifier
 * combination, or adopting the matcher changes what the app does.
 */
const appTsx = (event: KeyboardEvent) =>
  event.key.toLowerCase() === 'o' && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey

/** The same, from `Editor.tsx` lines 80–81. */
const editorTsx = (event: KeyboardEvent) =>
  event.key.toLowerCase() === 't' && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey

describe('matching the combos the app already binds', () => {
  it('agrees with App.tsx and Editor.tsx on every modifier combination', () => {
    for (const key of ['o', 'O', 't', 'T', 'p']) {
      for (let bits = 0; bits < 16; bits++) {
        const event = press(key, {
          metaKey: (bits & 1) !== 0,
          shiftKey: (bits & 2) !== 0,
          altKey: (bits & 4) !== 0,
          ctrlKey: (bits & 8) !== 0,
        })
        const where = `${key} bits=${bits}`
        expect([where, matchesCombo(event, 'mod+shift+o')]).toEqual([where, appTsx(event)])
        expect([where, matchesCombo(event, 'mod+shift+t')]).toEqual([where, editorTsx(event)])
      }
    }
  })

  it("matches the shifted 'O' the keyboard actually reports", () => {
    expect(matchesCombo(press('O', { metaKey: true, shiftKey: true }), 'mod+shift+o')).toBe(true)
  })

  it('does not fire when an extra modifier is held', () => {
    const withAlt = press('O', { metaKey: true, shiftKey: true, altKey: true })
    expect(matchesCombo(withAlt, 'mod+shift+o')).toBe(false)
    const withCtrl = press('O', { metaKey: true, shiftKey: true, ctrlKey: true })
    expect(matchesCombo(withCtrl, 'mod+shift+o')).toBe(false)
  })

  it('treats ⌃⇧O as a different combo from ⌘⇧O', () => {
    const ctrl = press('O', { ctrlKey: true, shiftKey: true })
    expect(matchesCombo(ctrl, 'mod+shift+o')).toBe(false)
    expect(matchesCombo(ctrl, 'ctrl+shift+o')).toBe(true)
  })

  it('never matches an unreadable combo', () => {
    expect(matchesCombo(press('o', { metaKey: true }), 'mod+')).toBe(false)
  })
})

describe('the text form', () => {
  it('canonicalises aliases and modifier order', () => {
    expect(normalizeCombo('Shift+Cmd+O')).toBe('mod+shift+o')
    expect(normalizeCombo(' meta + SHIFT + t ')).toBe('mod+shift+t')
    expect(normalizeCombo('option+ctrl+return')).toBe('ctrl+alt+enter')
  })

  it('rejects what it cannot represent', () => {
    for (const bad of ['', 'mod', 'mod+shift', 'mod+a+b', 'mod+nonsense', null, 7, undefined]) {
      expect(normalizeCombo(bad)).toBe(null)
    }
  })

  it('keeps named keys and function keys', () => {
    expect(parseCombo('mod+space')?.key).toBe('space')
    expect(parseCombo('mod+f5')?.key).toBe('f5')
    expect(parseCombo('mod+f13')).toBe(null)
  })

  it('renders in macOS order', () => {
    // Apple's order is ⌃⌥⇧⌘ — a macOS menu shows ⇧⌘N, not ⌘⇧N.
    expect(formatCombo('mod+shift+o')).toBe('⇧⌘O')
    expect(formatCombo('mod+ctrl+alt+shift+enter')).toBe('⌃⌥⇧⌘↩')
    expect(formatCombo('not a combo')).toBe('')
  })
})

describe('capturing a keystroke', () => {
  it('reads the combo off the event', () => {
    expect(comboFromEvent(press('T', { metaKey: true, shiftKey: true }))).toBe('mod+shift+t')
    expect(comboFromEvent(press(' ', { metaKey: true }))).toBe('mod+space')
  })

  it('waits while only modifiers are down', () => {
    expect(comboFromEvent(press('Meta', { metaKey: true }))).toBe(null)
    expect(comboFromEvent(press('Shift', { shiftKey: true, metaKey: true }))).toBe(null)
  })
})

describe('conflicts', () => {
  const current = defaultShortcuts()

  it('lets the two defaults stand', () => {
    expect(findConflict('mod+shift+o', 'openToday', current)).toBe(null)
    expect(findConflict('mod+shift+t', 'insertTime', current)).toBe(null)
  })

  /**
   * The combos here are the *installed* keymaps': CodeMirror's undo and select-all,
   * `lang-markdown`'s list indent, and this app's own bold. The list that answers
   * this used to be a hand-copy of Milkdown's, which is why ⇧⌘B for a block quote
   * and ⌥⌘X for strikethrough were once in it — Crepe bound those, and nothing
   * does now.
   */
  it('refuses a combo the editor binds', () => {
    for (const combo of ['mod+z', 'mod+a', 'mod+]', 'mod+b']) {
      expect(findConflict(combo, 'openToday', current)).toMatch(/editor already uses/i)
    }
    // And not one that only the retired editor bound.
    expect(findConflict('mod+alt+x', 'openToday', current)).toBe(null)
  })

  it('refuses a combo macOS takes first', () => {
    expect(findConflict('mod+q', 'openToday', current)).toMatch(/quits/i)
    expect(findConflict('mod+shift+q', 'openToday', current)).toMatch(/log out/i)
  })

  it('refuses the other action’s combo', () => {
    expect(findConflict('mod+shift+t', 'openToday', current)).toMatch(/Insert current time/)
    expect(findConflict('mod+shift+o', 'insertTime', current)).toMatch(/Open today/)
  })

  it('allows a swap once the map has moved', () => {
    const swapped = { openToday: 'mod+shift+t', insertTime: 'mod+shift+o' }
    expect(findConflict('mod+shift+t', 'openToday', swapped)).toBe(null)
  })

  it('refuses a bare key, shift included — it would fire while typing', () => {
    expect(findConflict('k', 'openToday', current)).toMatch(/⌘/)
    expect(findConflict('shift+k', 'openToday', current)).toMatch(/⌘/)
    expect(findConflict('alt+k', 'openToday', current)).toBe(null)
  })

  it('refuses something it cannot read at all', () => {
    expect(findConflict(null, 'openToday', current)).toMatch(/cannot|not a shortcut/i)
  })
})

describe('the registry', () => {
  it('is the list the panel and the defaults both read', () => {
    expect(ACTIONS.map((action) => action.id)).toEqual(['openToday', 'insertTime'])
    // The registry and the stored map cannot come apart: one is built from the other.
    expect(Object.keys(defaultShortcuts())).toEqual(ACTIONS.map((action) => action.id))
  })

  it('has no default that is already reserved', () => {
    const reserved = new Set(RESERVED_COMBOS.map((r) => r.combo))
    for (const action of ACTIONS) {
      expect(reserved.has(action.defaultCombo)).toBe(false)
      expect(EDITOR_COMBOS.has(action.defaultCombo)).toBe(false)
    }
  })

  it('stores every reservation in canonical form', () => {
    for (const entry of RESERVED_COMBOS) expect(normalizeCombo(entry.combo)).toBe(entry.combo)
    // The derived set goes through `normalizeCombo` on the way in, so this is a
    // check on the conversion from CodeMirror's `Mod-Shift-z` spelling.
    for (const combo of EDITOR_COMBOS) expect(normalizeCombo(combo)).toBe(combo)
  })

  // ⌘, is the panel's own way in. Binding an action over it leaves the sidebar
  // button as the only route back to Settings, which is fine right up until the
  // binding is forgotten.
  it('refuses the combo that opens Settings', () => {
    expect(findConflict('mod+,', 'openToday', {})).toBe('⌘, opens Settings.')
    // A combo no keymap in the stack claims — CodeMirror took ⇧⌘K, which is what
    // this example used to be.
    expect(findConflict('mod+shift+j', 'openToday', {})).toBeNull()
  })
})

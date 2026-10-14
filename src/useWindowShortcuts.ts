import { useWindowEvent } from './useWindowEvent'
import { matchesCombo, SETTINGS_COMBO, type ActionId } from './shortcuts'

/**
 * The window's shortcuts: each action given on its combo (today's note, the terminal),
 * and Settings on ⌘,.
 *
 * ⌘, is the macOS habit and not in `ACTIONS`, so no one can rebind it and
 * lose the way in. `RESERVED_COMBOS` refuses it. The bound actions are still
 * checked first, so a combo saved before the reservation keeps working.
 *
 * Registered once, and read through a ref: the vault path (null on the
 * render that reopens the last folder) and a rebound combo arrive
 * later. A dependency would re-register the listener every render.
 *
 * `disabled` while the panel is open, decided here rather than relying on
 * the dialog's `stopPropagation`, which would stop working if this listener
 * moved to the capture phase. Otherwise ⌘⇧O would open today's note behind
 * the dialog, and capturing a rebind would fire the action being rebound.
 */
export function useWindowShortcuts(current: {
  /** What each window action does. One left out (the terminal, on the phone) is not bound. */
  actions: Partial<Record<ActionId, () => unknown>>
  shortcuts: Readonly<Record<ActionId, string>>
  disabled: boolean
  openSettings: () => void
}) {
  useWindowEvent('keydown', (event) => {
    const { actions, shortcuts, disabled, openSettings } = current
    if (disabled) return
    for (const [id, run] of Object.entries(actions) as [ActionId, () => unknown][]) {
      if (!matchesCombo(event, shortcuts[id])) continue
      event.preventDefault()
      void run()
      return
    }
    if (matchesCombo(event, SETTINGS_COMBO)) {
      event.preventDefault()
      openSettings()
    }
  })
}

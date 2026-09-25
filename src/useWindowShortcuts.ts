import { useWindowEvent } from './useWindowEvent'
import { matchesCombo, SETTINGS_COMBO } from './shortcuts'

/**
 * ⌘, opens the panel — the macOS convention, and deliberately **not** in `ACTIONS`:
 * a rebindable "open settings" is a shortcut you can lock yourself out of.
 *
 * `RESERVED_COMBOS` refuses it, so an action cannot be bound over the panel's own
 * way in. The listener still checks the bound action first, which is the belt to
 * that braces: a combo already stored from before the reservation keeps working
 * rather than becoming a key that does nothing.
 */

/**
 * The window's two shortcuts: today's note on the bound combo, the panel on ⌘,.
 *
 * Registered once, and read through a ref: a listener closes over one render, and
 * everything it needs — the vault path above all, which is null on the render that
 * reopens the last folder — arrives later. A rebound combo is the same problem, so
 * it comes the same way; a dependency here would re-register the listener per
 * render, which starves it.
 *
 * **`disabled` while the panel is up**, and decided here rather than left to the
 * dialog's own `stopPropagation`. That does work today — React attaches at the app
 * root, so the native event has passed the root by the time the panel's handler
 * stops it, and this bubble-phase listener on `window` never sees it — but only
 * for as long as nobody moves this listener to the capture phase, where `window`
 * is the *first* node to see the event. Two things would otherwise happen: ⌘⇧O
 * would reopen today's note behind the dialog, and *capturing* a rebind would fire
 * the very action being rebound.
 */
export function useWindowShortcuts(current: {
  openToday: () => Promise<unknown>
  combo: string
  disabled: boolean
  openSettings: () => void
}) {
  useWindowEvent('keydown', (event) => {
    const { openToday, combo, disabled, openSettings } = current
    if (disabled) return
    if (matchesCombo(event, combo)) {
      event.preventDefault()
      void openToday()
      return
    }
    if (matchesCombo(event, SETTINGS_COMBO)) {
      event.preventDefault()
      openSettings()
    }
  })
}

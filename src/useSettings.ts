import { useEffect, useMemo, useRef, useState } from 'react'
import {
  applySettingsLive,
  loadSettings,
  loadVaultSettings,
  portable,
  saveSettings,
  saveVaultSettings,
  type Settings,
} from './settings'
import { SETTINGS_FILE } from './vaultModel'
import { CONFIG_DIR } from './vault'

/** How long a change waits before it reaches the vault's `.config`. A slider is
 *  dragged, not set, and each tick would otherwise be a file write. */
const CONFIG_SAVE_MS = 400

/**
 * The settings, and the two places they live.
 *
 * **The vault is the authority.** `.config/settings.json` is read when a vault
 * opens, so a vault dresses the window it is opened in, and written when it has
 * none — which is how a vault this app has not seen before comes to have a
 * `.config` at all. What is written then is whatever is on screen: the last
 * applied set, out of `localStorage`, so a first open carries the user's own
 * settings into the new vault rather than resetting them to the defaults — less
 * what was the last vault's own (`portable`).
 *
 * `localStorage` keeps that last applied set for the window *before* a vault is
 * open — the only moment there is no file to read.
 *
 * Here rather than in `App` for the reason `useVault` and `useNoteBuffer` are:
 * four effects, two storage layers and a debounce is a subject, and it is not the
 * subject of the component that lays out the panes.
 */
export function useSettings(vaultPath: string | null, setError: (message: string) => void) {
  /**
   * The settings, and the vault they were read from. **Until this vault's file has
   * been read, what is held is another's** — the last vault's, or the window's — so
   * its calendars and hidden folders are not handed out. Worked out in the render,
   * because the render that switches vault is the one whose calendar sync would
   * otherwise write the old vault's events into the new one.
   */
  const [held, setHeld] = useState(() => ({ settings: loadSettings(), vault: null as string | null }))
  const settings = useMemo(
    () => (held.vault === vaultPath ? held.settings : portable(held.settings)),
    [held, vaultPath]
  )

  /**
   * Settings onto the document, and the teardown returned — not swallowed.
   * `mode: 'system'` installs a `matchMedia` listener, so a re-apply that dropped
   * the teardown would stack one per change and leave the old ones live.
   */
  useEffect(() => applySettingsLive(settings), [settings])

  /** What the vault gets written on a first open: whatever is on screen now. A
   *  ref, so the effect below does not re-run on every change. */
  const current = useRef(settings)
  current.current = settings

  /**
   * Said out loud, not swallowed.
   *
   * This is the second half of a bug worth keeping a note of: `.config` starts
   * with a dot, and `tauri-plugin-fs` defaults `requireLiteralLeadingDot` to true
   * on Unix, so the `**` in the capability did not match the folder and every
   * write was refused. A `.catch(() => {})` turned that into a vault that opened
   * fine and quietly never remembered anything.
   */
  const reportFailure = (err: unknown) =>
    setError(`Could not write ${CONFIG_DIR}/${SETTINGS_FILE}: ${String(err)}`)

  useEffect(() => {
    if (!vaultPath) return
    let live = true
    void (async () => {
      const found = await loadVaultSettings(vaultPath).catch(() => null)
      if (!live) return
      if (!found) {
        const fresh = portable(current.current)
        setHeld({ settings: fresh, vault: vaultPath })
        void saveVaultSettings(vaultPath, fresh).catch(reportFailure)
        return
      }
      setHeld({ settings: found, vault: vaultPath })
      // Keeps the next launch's first paint matching the vault it will reopen.
      saveSettings(found)
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath])

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * A whole new set of settings, from the panel.
   *
   * `localStorage` takes every change as it comes — it is not IO. The vault's file
   * is held back, so a dragged slider is one write and not fifty.
   *
   * Written here rather than in an effect on `settings`: an effect would store a
   * copy of the defaults at first launch, and then a later change to
   * `DEFAULT_SETTINGS` would never reach anyone who had never opened the panel.
   */
  function changeSettings(next: Settings) {
    setHeld({ settings: next, vault: vaultPath })
    saveSettings(next)
    if (!vaultPath) return
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      void saveVaultSettings(vaultPath, next).catch(reportFailure)
    }, CONFIG_SAVE_MS)
  }

  return { settings, changeSettings }
}

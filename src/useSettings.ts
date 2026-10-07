import { useEffect, useMemo, useRef, useState } from 'react'
import {
  applySettingsLive,
  loadSettings,
  loadVaultSettings,
  portable,
  saveSettings,
  saveVaultSettings,
  settingsJson,
  type Settings,
} from './settings'
import { SETTINGS_FILE } from './vaultModel'
import { CONFIG_DIR } from './vault'

/**
 * How long a change waits before it is written to `.config`. A
 * slider drags, and each step would be a file write.
 */
const CONFIG_SAVE_MS = 400

/**
 * The settings, and the two places they live.
 *
 * The vault's `.config/settings.json` is the source. It is read when a vault
 * opens and written when missing, from what is on screen (the last applied
 * settings in `localStorage`, minus the last vault's own, `portable`), so a
 * new vault starts with the owner's settings, not the defaults.
 *
 * `localStorage` keeps the last applied settings for the window
 * before a vault opens, when there is no file to read.
 */
export function useSettings(vaultPath: string | null, setError: (message: string) => void) {
  /**
   * The settings, and the vault they came from. Until this vault's file is read,
   * what is held is another's, so its calendars and hidden folders are not
   * handed out. Worked out in the render, because the render that switches
   * vaults would otherwise sync the old vault's calendar into the new one.
   */
  const [held, setHeld] = useState(() => ({ settings: loadSettings(), vault: null as string | null }))
  const settings = useMemo(
    () => (held.vault === vaultPath ? held.settings : portable(held.settings)),
    [held, vaultPath]
  )

  /**
   * Settings onto the document, returning the teardown. `mode: 'system'` adds a
   * `matchMedia` listener, and dropping the teardown would pile one up per change.
   */
  useEffect(() => applySettingsLive(settings), [settings])

  /**
   * What a first open writes to the vault: what is on screen now.
   * A ref, so the effect below does not re-run on every change.
   */
  const current = useRef(settings)
  current.current = settings
  /** What is held, and from which vault: a return to the window reads against it. */
  const heldNow = useRef(held)
  heldNow.current = held
  /** A read failure said already, so a file left broken is said once, not on every return. */
  const said = useRef<string | null>(null)

  /**
   * Said, not swallowed. `.config` starts with a dot, and the fs
   * plugin's `**` scope did not match it, so every write was refused; a
   * `.catch(() => {})` made that a vault that never remembered anything.
   */
  const reportFailure = (err: unknown) =>
    setError(`Could not write ${CONFIG_DIR}/${SETTINGS_FILE}: ${String(err)}`)

  useEffect(() => {
    if (!vaultPath) return
    let live = true
    void (async () => {
      let found: Settings | null
      try {
        found = await loadVaultSettings(vaultPath)
      } catch (err) {
        // There but unreadable is not missing: say so and write nothing over
        // it. The vault's settings stay unread, so none are handed out.
        if (live) setError(`Could not read ${CONFIG_DIR}/${SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      if (!live) return
      if (!found) {
        const fresh = portable(current.current)
        setHeld({ settings: fresh, vault: vaultPath })
        void saveVaultSettings(vaultPath, fresh).catch(reportFailure)
        return
      }
      setHeld({ settings: found, vault: vaultPath })
      // So the next launch paints like the vault it reopens.
      saveSettings(found)
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath])

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Read again on every return to the window: the vault's agent edits this file too,
   * and the app went on with what it read when the vault opened. Not before that read
   * has landed, and not over a change still waiting to be written, which it would undo.
   */
  useEffect(() => {
    if (!vaultPath) return
    let live = true
    const again = () => {
      if (pending.current || heldNow.current.vault !== vaultPath) return
      loadVaultSettings(vaultPath).then(
        (found) => {
          said.current = null
          if (!live || !found || settingsJson(found) === settingsJson(heldNow.current.settings)) return
          setHeld({ settings: found, vault: vaultPath })
          saveSettings(found)
        },
        (err: unknown) => {
          const message = `Could not read ${CONFIG_DIR}/${SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`
          if (live && said.current !== message) setError((said.current = message))
        }
      )
    }
    window.addEventListener('focus', again)
    return () => {
      live = false
      window.removeEventListener('focus', again)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath])

  /**
   * A whole new set of settings, from the panel. `localStorage` takes every
   * change; the vault's file waits, so a dragged slider is one write.
   *
   * Stored here, not in an effect on `settings`: an effect would store the defaults at
   * first launch, and later changes to `DEFAULT_SETTINGS` would never reach anyone.
   *
   * Until the vault's file is read, a change stays in the window and is not written.
   */
  function changeSettings(next: Settings) {
    setHeld({ settings: next, vault: held.vault })
    saveSettings(next)
    if (!vaultPath || held.vault !== vaultPath) return
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      void saveVaultSettings(vaultPath, next).catch(reportFailure)
    }, CONFIG_SAVE_MS)
  }

  return { settings, changeSettings }
}

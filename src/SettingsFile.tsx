import { useEffect, useReducer, useRef, useState } from 'react'
import { keymap } from '@codemirror/view'
import { JsonEditor } from './JsonEditor'
import { ViewerHeader } from './ViewerHeader'
import { parseSettings, settingsJson, type Settings } from './settings'
import { SETTINGS_FILE } from './vaultModel'
import { readConfigFile } from './vault'

interface SettingsFileProps {
  vaultPath: string
  /** What is in force, and the fallback when the file is missing. */
  settings: Settings
  onChange: (next: Settings) => void
}

/**
 * `.config/settings.json` in the pane, and the one file with a Save.
 * Every other file saves as you type. This one reconfigures the app,
 * and a half-typed value (`"proseSize": 1` on the way to `13`) should
 * not repaint the window. Save, or ⌘S, parses before it writes.
 *
 * The file is read from disk, not rebuilt from state; they
 * differ only after a hand edit, which is when this is opened.
 *
 * Saving goes through `parseSettings`, as launch does: a value it
 * cannot read falls back to its default. The result is shown back,
 * so the screen matches the disk, including anything an edit lost.
 */
export function SettingsFile({ vaultPath, settings, onChange }: SettingsFileProps) {
  /**
   * The bytes on disk as far as this knows: the first read, then
   * each save. `dirty` is measured against this.
   */
  const [stored, setStored] = useState<string | null>(null)
  /**
   * Why a file that is there could not be read. Opened over the
   * settings in force instead, its Save writes over the file.
   */
  const [unreadable, setUnreadable] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  /**
   * The host's key. A save that normalises must put its bytes in the editor,
   * and `stored` cannot tell when they equal what was there before the edit.
   */
  const [version, replaceDocument] = useReducer((n: number) => n + 1, 0)

  // `settings` is left out of the dependencies: a save changes
  // it, and reading again would race the write.
  useEffect(() => {
    let live = true
    void readConfigFile(vaultPath, SETTINGS_FILE).then(
      (found) => {
        if (!live) return
        const text = found ?? settingsJson(settings)
        setStored(text)
        setDraft(text)
        replaceDocument()
      },
      (err: unknown) => {
        if (live) setUnreadable(String(err))
      }
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath])

  // Through a ref: the ⌘S binding is installed once, at mount.
  const saveRef = useRef(() => {})
  saveRef.current = () => {
    try {
      JSON.parse(draft)
    } catch (err) {
      // The parser's own message, which names the position.
      setMessage(String(err))
      setSaved(false)
      return
    }
    const next = parseSettings(draft)
    onChange(next)
    // The normalised bytes, as written to disk. Shown back, so a
    // key the app does not keep visibly goes.
    const canonical = settingsJson(next)
    setStored(canonical)
    setDraft(canonical)
    setMessage(null)
    setSaved(true)
    replaceDocument()
  }

  const extensions = useRef([
    keymap.of([{ key: 'Mod-s', run: () => (saveRef.current(), true) }]),
  ]).current

  if (unreadable) {
    return (
      <p className="viewer-empty">
        {SETTINGS_FILE} could not be read, so it has not been opened for editing. Nothing has been
        written to it. ({unreadable})
      </p>
    )
  }
  if (stored === null) return <p className="viewer-empty">Reading {SETTINGS_FILE}…</p>

  const dirty = draft !== stored
  return (
    <>
      <ViewerHeader name={SETTINGS_FILE} status={dirty ? 'Unsaved' : saved ? 'Saved' : ''}>
        <button className="header-action" onClick={() => saveRef.current()} disabled={!dirty}>
          Save
        </button>
      </ViewerHeader>
      {message && (
        <p className="json-message" role="alert">
          {message}
        </p>
      )}
      {/* The same editor as every `.json` file, with ⌘S bound in. */}
      <JsonEditor
        key={version}
        name={SETTINGS_FILE}
        initialText={stored}
        onChange={setDraft}
        extensions={extensions}
      />
    </>
  )
}

import { useEffect, useReducer, useRef, useState } from 'react'
import { keymap } from '@codemirror/view'
import { JsonEditor } from './JsonEditor'
import { ViewerHeader } from './ViewerHeader'
import { parseSettings, settingsJson, type Settings } from './settings'
import { SETTINGS_FILE } from './vaultModel'
import { readConfigFile } from './vault'

interface SettingsFileProps {
  vaultPath: string
  /** What is in force, and the fallback when the file is somehow not there. */
  settings: Settings
  onChange: (next: Settings) => void
}

/**
 * `.config/settings.json`, in the pane, editable — and **the one file with a
 * Save**.
 *
 * Every other file the app opens is written as you type, which is the whole
 * bargain of the thing: a note, and a JSON file of your own, are yours and are
 * kept. This one is different because saving it *reconfigures the app*, and a
 * half-typed reconfiguration is not one to apply — a `"proseSize": 1` on its way
 * to `13` should not repaint the window at 1px on the way past.
 *
 * So: an explicit Save, and it parses before it writes. ⌘S does the same thing.
 *
 * **The file is read from disk, not serialised from state.** The two are normally
 * the same, and when they are not it is because someone edited the file by hand —
 * which is exactly when you would open this.
 *
 * Saving goes through `parseSettings`, the same function that reads the file on
 * launch: every value it does not understand falls back to that setting's default
 * rather than to nothing. What comes back is then shown here, so the text on
 * screen is the text on disk — including the parts an edit lost.
 */
export function SettingsFile({ vaultPath, settings, onChange }: SettingsFileProps) {
  /** The bytes on disk, as far as this knows: the read at first, then whatever a
   *  save stored. `dirty` is measured against this. */
  const [stored, setStored] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  /** The host's key. A save that normalises has to put its own bytes in the
   *  editor, and `stored` alone cannot say so when those bytes are what was there
   *  before the edit. */
  const [version, replaceDocument] = useReducer((n: number) => n + 1, 0)

  // `settings` is deliberately not a dependency: a save changes it, and re-reading
  // the file on that would race the write it just queued.
  useEffect(() => {
    let live = true
    void readConfigFile(vaultPath, SETTINGS_FILE)
      .catch(() => null)
      .then((found) => {
        if (!live) return
        const text = found ?? settingsJson(settings)
        setStored(text)
        setDraft(text)
        replaceDocument()
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath])

  // Through a ref: the ⌘S binding is installed once, at mount, and would otherwise
  // close over the draft as of that render.
  const saveRef = useRef(() => {})
  saveRef.current = () => {
    try {
      JSON.parse(draft)
    } catch (err) {
      // The parser's own message: it names the position, which is the only useful
      // thing anyone can say about broken JSON.
      setMessage(String(err))
      setSaved(false)
      return
    }
    const next = parseSettings(draft)
    onChange(next)
    // The canonical bytes, which are what the write puts on disk. Shown back, so a
    // key the app does not keep is visibly not kept.
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
      {/* The same editor every `.json` file in the vault opens in — this one with
          a key bound into it. What a JSON file looks like is `JsonEditor`'s to say,
          and it said it twice while this mounted its own host. */}
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

import type { Extension } from '@codemirror/state'
import { EditorHost } from './EditorHost'
import { jsonPreview } from './jsonPreview'

interface JsonEditorProps {
  /** The file's name, for the accessible name of the editor. */
  name: string
  /** Read at mount only — see `EditorHost`. The caller keys this on the file. */
  initialText: string
  /** Called synchronously on every change, exactly as the markdown editor's is:
   *  the file's autosave is the caller's. */
  onChange: (text: string) => void
  indentWidth?: number
  /** `.config/settings.json`'s ⌘S, and nothing else so far. A caller's extensions
   *  go ahead of the host's, so a key here outranks the editor's own. */
  extensions?: Extension[]
}

/**
 * A JSON file in the vault, in the reading pane.
 *
 * **Typing saves it**, like a note, because it *is* like a note: a file of yours
 * that the app shows and keeps and does not otherwise read. Nothing here parses it
 * before writing, and nothing refuses to write what you typed — half a JSON file
 * of your own is your business, exactly as half a sentence is.
 *
 * `.config/settings.json` is the one file that does not work this way, and
 * `SettingsFile` is where that lives: it has a Save, because saving it reconfigures
 * the app, and a half-typed reconfiguration is not one to apply.
 *
 * Everything else is `EditorHost` — the note's column, face, size, leading, line
 * numbers and folding — plus `jsonPreview` for the colour.
 */
export function JsonEditor({
  name,
  initialText,
  onChange,
  indentWidth,
  extensions,
}: JsonEditorProps) {
  return (
    <EditorHost
      initialText={initialText}
      onChange={onChange}
      extensions={extensions ? [...extensions, ...JSON_EXTENSIONS] : JSON_EXTENSIONS}
      ariaLabel={`${name} source`}
      className="json-editor"
      indentWidth={indentWidth}
    />
  )
}

/** One array, built once, for the callers that add nothing: the language is the
 *  same for every JSON file, and `EditorHost` reads its extensions at mount. */
const JSON_EXTENSIONS = [jsonPreview]

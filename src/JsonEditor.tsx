import type { Extension } from '@codemirror/state'
import { EditorHost } from './EditorHost'
import { jsonPreview } from './jsonPreview'

interface JsonEditorProps {
  /** The file's name, for the editor's accessible name. */
  name: string
  /** Read at mount only; see `EditorHost`. The caller keys this on the file. */
  initialText: string
  /** Called on every change; the caller saves. */
  onChange: (text: string) => void
  indentWidth?: number
  /**
   * Extra keys, like `.config/settings.json`'s ⌘S. They come
   * before the host's, so they outrank the editor's own.
   */
  extensions?: Extension[]
  shown?: boolean
}

/**
 * A JSON file in the reading pane. Typing saves it, as with a note: nothing
 * parses it first, and half a JSON file is the owner's business.
 * `.config/settings.json` is the exception, with a Save (`SettingsFile`).
 * Everything else is `EditorHost`, plus `jsonPreview` for colour.
 */
export function JsonEditor({
  name,
  initialText,
  onChange,
  indentWidth,
  extensions,
  shown,
}: JsonEditorProps) {
  return (
    <EditorHost
      shown={shown}
      initialText={initialText}
      onChange={onChange}
      extensions={extensions ? [...extensions, ...JSON_EXTENSIONS] : JSON_EXTENSIONS}
      ariaLabel={`${name} source`}
      className="json-editor"
      indentWidth={indentWidth}
    />
  )
}

/**
 * One array, built once, for callers that add nothing:
 * `EditorHost` reads its extensions at mount.
 */
const JSON_EXTENSIONS = [jsonPreview]

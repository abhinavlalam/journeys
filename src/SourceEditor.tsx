import type { ComponentProps } from 'react'
import type { Extension } from '@codemirror/state'
import { EditorHost } from './EditorHost'
import { csvPreview } from './csvPreview'
import { jsonPreview } from './jsonPreview'

/**
 * Each kind's colour, a scan rather than a grammar. A text file that is not markdown
 * (a `.conf`, a `.yaml`, a `.txt`) has none: these once opened as markdown, and every
 * `# comment` in the app's own tmux config became a hidden-`#` heading.
 */
const COLOURS: Record<'json' | 'csv' | 'text', Extension[]> = { json: [jsonPreview], csv: [csvPreview], text: [] }

/**
 * A file that is not a note, as its own text. Typing saves it, as with a note: nothing
 * parses it first, and half a JSON file is the owner's business. The colour is all the
 * app adds. `.config/settings.json` is the exception, with a Save (`SettingsFile`), whose
 * ⌘S comes in `extensions`, before the host's, so it outranks the editor's own keys.
 */
export function SourceEditor({
  kind,
  name,
  extensions = [],
  ...host
}: {
  kind: keyof typeof COLOURS
  /** The file's name, for the editor's accessible name. */
  name: string
  extensions?: Extension[]
} & Pick<ComponentProps<typeof EditorHost>, 'initialText' | 'incoming' | 'onChange' | 'indentWidth' | 'shown'>) {
  return <EditorHost {...host} extensions={[...extensions, ...COLOURS[kind]]} ariaLabel={`${name} source`} className={`${kind}-editor`} />
}

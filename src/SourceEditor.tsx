import { useRef, type ComponentProps } from 'react'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { EditorHost } from './EditorHost'
import { csvPreview } from './csvPreview'
import { followLink } from './editorPreview'
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
  onOpenLink,
  ...host
}: {
  kind: keyof typeof COLOURS
  /** The file's name, for the editor's accessible name. */
  name: string
  extensions?: Extension[]
  /** A table's `[[link]]` pressed: it opens, as a note's does. */
  onOpenLink?: (target: string, wiki: boolean) => void
} & Pick<ComponentProps<typeof EditorHost>, 'initialText' | 'incoming' | 'onChange' | 'indentWidth' | 'shown'>) {
  // The editor takes its extensions once, at mount; the handler is read when pressed.
  const open = useRef(onOpenLink)
  open.current = onOpenLink
  const links = EditorView.domEventHandlers({
    // ⌘ too: the link opens in a new tab.
    mousedown: (event, view) => event.button === 0 && !event.ctrlKey && !event.altKey && followLink(event, view, (target, wiki) => open.current?.(target, wiki)),
  })
  return (
    <EditorHost
      {...host}
      extensions={[...extensions, ...COLOURS[kind], ...(kind === 'csv' ? [links] : [])]}
      ariaLabel={`${name} source`}
      className={`${kind}-editor`}
    />
  )
}

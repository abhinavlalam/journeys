import { EditorHost } from './EditorHost'
import { csvPreview } from './csvPreview'

/**
 * A delimited file in the reading pane: its own text, with a colour per column.
 *
 * `JsonEditor`'s twin, and the same bargain — **typing saves it**, nothing parses
 * it before writing, and what is on disk is what you typed. The colour is the
 * whole of what the app adds, which is what was asked for: Rainbow CSV's reading
 * of a file, in the app's own palette.
 */
export function CsvEditor({
  name,
  initialText,
  onChange,
  indentWidth,
}: {
  name: string
  initialText: string
  onChange: (text: string) => void
  indentWidth?: number
}) {
  return (
    <EditorHost
      initialText={initialText}
      onChange={onChange}
      extensions={CSV_EXTENSIONS}
      ariaLabel={`${name} source`}
      className="csv-editor"
      indentWidth={indentWidth}
    />
  )
}

const CSV_EXTENSIONS = [csvPreview]

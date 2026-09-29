import { EditorHost } from './EditorHost'
import { csvPreview } from './csvPreview'

/**
 * A delimited file in the reading pane: its own text, with a
 * colour per column. Like `JsonEditor`: typing saves it and
 * nothing parses it first. The colour is all the app adds.
 */
export function CsvEditor({
  name,
  initialText,
  onChange,
  indentWidth,
  shown,
}: {
  name: string
  initialText: string
  onChange: (text: string) => void
  indentWidth?: number
  shown?: boolean
}) {
  return (
    <EditorHost
      shown={shown}
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

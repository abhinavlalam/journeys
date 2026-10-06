import type { ComponentProps } from 'react'
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
  incoming,
  onChange,
  indentWidth,
  shown,
}: {
  name: string
  initialText: string
  /** The file as now on disk, applied in place (see `EditorHost`). */
  incoming?: ComponentProps<typeof EditorHost>['incoming']
  onChange: (text: string) => void
  indentWidth?: number
  shown?: boolean
}) {
  return (
    <EditorHost
      shown={shown}
      initialText={initialText}
      incoming={incoming}
      onChange={onChange}
      extensions={CSV_EXTENSIONS}
      ariaLabel={`${name} source`}
      className="csv-editor"
      indentWidth={indentWidth}
    />
  )
}

const CSV_EXTENSIONS = [csvPreview]

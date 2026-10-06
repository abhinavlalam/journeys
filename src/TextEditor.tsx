import type { ComponentProps } from 'react'
import { EditorHost } from './EditorHost'

/**
 * A text file that is not markdown (a `.conf`, a `.yaml`, a `.txt`) as
 * plain text. Typing saves it. These once opened as markdown, and every
 * `# comment` in the app's own tmux config became a hidden-`#` heading.
 */
export function TextEditor({
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
      ariaLabel={`${name} source`}
      className="text-editor"
      indentWidth={indentWidth}
    />
  )
}

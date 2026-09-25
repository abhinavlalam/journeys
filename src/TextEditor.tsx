import { EditorHost } from './EditorHost'

/**
 * A text file that is not markdown — a `.conf`, a `.yaml`, a `.txt` — in the
 * reading pane, as its own text and nothing more.
 *
 * `CsvEditor`'s twin, less the colour: **typing saves it**, and nothing reads it as
 * anything. These went to the markdown editor once, and every `# comment` in the
 * tmux config the app itself writes came out a heading with its `#` hidden.
 */
export function TextEditor({
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
      ariaLabel={`${name} source`}
      className="text-editor"
      indentWidth={indentWidth}
    />
  )
}

import { useRef, useState, type MutableRefObject } from 'react'
import { EditorView } from '@codemirror/view'
import { LEADING_CLOCK, localTimeStamp } from './clock'
import type { Entries } from './configEntries'
import { MarkdownEditor } from './MarkdownEditor'
import type { VaultFile } from './vaultModel'

/**
 * The phone's capture line, under today's note, typed as a note's line is and filed
 * by `withNewEntry` on Enter or Add. Now starts the line with the time, and a tag's
 * chip adds the tag at the caret; each keeps the keyboard, since a press on a button
 * would otherwise take the focus. The draft is the caller's, so it outlives the page.
 */
export function Composer({
  notes,
  propertyTypes,
  tagStructures,
  draft,
  onAdd,
  onOpenLink,
  onOpenTag,
}: {
  notes: VaultFile[]
  propertyTypes: Entries
  tagStructures: Entries
  draft: MutableRefObject<string>
  onAdd: (text: string) => void
  onOpenLink: (target: string, wiki: boolean) => void
  onOpenTag: (tag: string) => void
}) {
  // A new line each time one is filed: the editor reads its text at mount only.
  const [round, setRound] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const view = () => {
    const dom = box.current?.querySelector<HTMLElement>('.cm-editor')
    return dom ? EditorView.findFromDOM(dom) : null
  }
  const file = (text: string) => {
    draft.current = ''
    if (text.trim()) onAdd(text.trim())
    setRound((was) => was + 1)
  }
  /**
   * Writes into the line and gives it the keyboard back. The caret ends after what
   * was written, or with `kept`, where it was: the time goes in at the start and
   * the typing goes on where it left off.
   */
  const write = (change: (line: string, caret: number) => { from: number; to?: number; insert: string }, kept = false) => {
    const editor = view()
    if (!editor) return
    const { from, to = from, insert } = change(editor.state.doc.toString(), editor.state.selection.main.head)
    const changes = editor.state.changes({ from, to, insert })
    const selection = kept ? editor.state.selection.map(changes, 1) : { anchor: from + insert.length }
    editor.dispatch({ changes, selection, userEvent: 'input' })
    editor.focus()
  }
  const now = () =>
    write((line) => {
      const clock = LEADING_CLOCK.exec(line)?.[0] ?? ''
      return { from: 0, to: clock.length + (line[clock.length] === ' ' ? 1 : 0), insert: `${localTimeStamp()} ` }
    }, true)
  const tag = (name: string) =>
    write((line, caret) => ({ from: caret, insert: `${caret > 0 && !/\s/.test(line[caret - 1]) ? ' ' : ''}#${name} ` }))
  const keep = (event: { preventDefault: () => void }) => event.preventDefault()

  return (
    <div className="composer" ref={box}>
      <div className="composer-chips">
        <button onMouseDown={keep} onClick={now}>
          Now
        </button>
        {Object.keys(tagStructures)
          .sort()
          .map((name) => (
            <button key={name} onMouseDown={keep} onClick={() => tag(name)}>
              #{name}
            </button>
          ))}
      </div>
      <div className="composer-line">
        <MarkdownEditor
          key={round}
          initialMarkdown={draft.current}
          caretAtEnd
          notes={notes}
          propertyTypes={propertyTypes}
          tagStructures={tagStructures}
          onOpenLink={onOpenLink}
          onOpenTag={onOpenTag}
          onChange={(text) => (draft.current = text)}
          line={{ onEnter: file, onEscape: () => {} }}
        />
        <button className="composer-add" onMouseDown={keep} onClick={() => file(view()?.state.doc.toString() ?? '')}>
          Add
        </button>
      </div>
    </div>
  )
}

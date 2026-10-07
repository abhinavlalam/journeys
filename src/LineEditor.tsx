import { useRef, useState } from 'react'
import type { Entries } from './configEntries'
import type { Alias } from './links'
import type { Opens } from './Live'
import { MarkdownEditor } from './MarkdownEditor'
import { onAndroid } from './platform'
import type { VaultFile } from './vaultModel'

/**
 * What every editor of the vault's text types with, a note's, a page's line and the
 * phone's: the `[[` popup's notes and their other names, the property popup's
 * structures and types, and the time key.
 */
export interface Typing {
  notes: VaultFile[]
  aliases: readonly Alias[]
  propertyTypes: Entries
  tagStructures: Entries
  insertTimeCombo: string | null
}

type LineEditorProps = {
  text: string
  /** The box's classes, for the page's own layout; `line-edit` sets the editor in the row's type. */
  className?: string
  typing: Typing
  autoFocus?: boolean
  /** The tag the line is filed under without carrying it, for its properties' popup. */
  tag?: string
  placeholder?: string
  onEnter: (text: string) => void
  onEscape: () => void
  onLeave?: (text: string) => void
} & Opens

/**
 * A line already written, edited in place: written on Enter or on leaving when it
 * changed, dropped on Escape. Emptied is not deleted: what is nested under it would
 * lose its parent, and a line's removal is the note's to make.
 */
export function EditLine({
  text,
  onSave,
  onDone,
  ...line
}: Omit<LineEditorProps, 'onEnter' | 'onLeave' | 'onEscape'> & { onSave: (text: string) => void; onDone: () => void }) {
  const done = (typed: string) => {
    onDone()
    if (typed.trim() !== '' && typed.trim() !== text) onSave(typed)
  }
  return <LineEditor {...line} text={text} onEnter={done} onLeave={done} onEscape={onDone} />
}

/**
 * The line a new one is typed in: Enter files what is typed and starts the next,
 * Escape clears it, and leaving keeps the draft. Not focused on a phone, where the
 * page is opened to read and the keyboard would cover it.
 */
export function NewLine({ onAdd, ...line }: Omit<LineEditorProps, 'text' | 'onEnter' | 'onEscape' | 'autoFocus'> & { onAdd: (text: string) => void }) {
  // A new line each time: the editor reads its text at mount only.
  const [round, setRound] = useState(0)
  const next = () => setRound((was) => was + 1)
  return (
    <LineEditor
      key={round}
      {...line}
      text=""
      autoFocus={!onAndroid}
      onEnter={(text) => {
        if (text.trim() !== '') onAdd(text.trim())
        next()
      }}
      onEscape={next}
    />
  )
}

/**
 * One line in the note's own editor (its syntax, popups, Tab), ended once,
 * by whichever of Enter, Escape or leaving comes first. The press that ends
 * it can also blur it, and a second write would find its line changed.
 */
export function LineEditor({
  text,
  typing,
  onEnter,
  onEscape,
  onLeave,
  autoFocus,
  tag,
  placeholder,
  className = 'line-edit',
  onOpenLink,
  onOpenTag,
}: LineEditorProps) {
  const finished = useRef(false)
  const once = (then: () => void) => {
    if (finished.current) return
    finished.current = true
    then()
  }
  return (
    <span className={className}>
      <MarkdownEditor
        initialMarkdown={text}
        caretAtEnd
        autoFocus={autoFocus}
        placeholder={placeholder}
        {...typing}
        onOpenLink={onOpenLink}
        onOpenTag={onOpenTag}
        onChange={() => {}}
        line={{
          onEnter: (line) => once(() => onEnter(line)),
          onEscape: () => once(onEscape),
          onLeave: onLeave && ((line) => once(() => onLeave(line))),
          tag,
        }}
      />
    </span>
  )
}

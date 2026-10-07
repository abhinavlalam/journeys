import { useRef } from 'react'
import type { Entries } from './configEntries'
import { MarkdownEditor } from './MarkdownEditor'
import type { VaultFile } from './vaultModel'

/**
 * What a line's editor types with, as a note's does: the `[[` popup's
 * notes, the property popup's structures and types, and the time key.
 */
export interface Typing {
  notes: VaultFile[]
  propertyTypes: Entries
  tagStructures: Entries
  insertTimeCombo: string | null
}

interface Opens {
  onOpenLink: (target: string, wiki: boolean) => void
  onOpenTag: (tag: string) => void
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
}: {
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
} & Opens) {
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
        notes={typing.notes}
        propertyTypes={typing.propertyTypes}
        tagStructures={typing.tagStructures}
        insertTimeCombo={typing.insertTimeCombo}
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

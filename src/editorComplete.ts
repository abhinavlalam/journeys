// What `[[`, `/` and a tag's line offer, and how their popup looks.
// CodeMirror's autocomplete draws the popup and handles its keys; a
// source says what to offer, and `completionAppearance` how it looks.

import { EditorView } from '@codemirror/view'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { localDateStamp, localTimeStamp } from './clock'
import { matchNotes, type Alias } from './links'
import { knownPath, noteName } from './vaultModel'
import type { VaultFile } from './vaultModel'

/** The block commands `/` offers, and the markdown each writes. */
const BLOCKS: readonly Completion[] = [
  { label: 'Heading 1', detail: '#', apply: '# ' },
  { label: 'Heading 2', detail: '##', apply: '## ' },
  { label: 'Heading 3', detail: '###', apply: '### ' },
  { label: 'Bullet list', detail: '-', apply: '- ' },
  { label: 'Numbered list', detail: '1.', apply: '1. ' },
  { label: 'Task', detail: '- [ ]', apply: '- [ ] ' },
  { label: 'Quote', detail: '>', apply: '> ' },
  { label: 'Code block', detail: '```', apply: '```\n\n```' },
  { label: 'Divider', detail: '---', apply: '---\n' },
]

/**
 * What `/` offers in the middle of a sentence, where a block cannot start. First, a
 * link to today's page. It carries the folder (`[[Daily/2026-09-16]]`), so
 * following it makes the note in the daily folder; it still reads as the date.
 */
function inlineOptions(dailyFolder: string): Completion[] {
  const today = localDateStamp()
  return [
    {
      label: 'Today',
      detail: today,
      apply: `[[${dailyFolder ? `${dailyFolder}/` : ''}${today}]]`,
    },
    {
      label: 'Now',
      detail: localTimeStamp(),
      // The trailing space is part of the stamp, as in `insertTimeKeymap`: without
      // it the next key turns `09:41` into `09:41w`. Same text as ⌘⇧T writes.
      apply: `${localTimeStamp()} `,
    },
  ]
}

/**
 * The `/` menu, in the same popup as `[[`.
 *
 * It opens where a `/` starts a word, as a tag's `#` does: at a line's start or
 * after a space, so `http://` and `Areas/Northwind` open nothing. Block commands (`#
 * `, `- `) are offered only where a block can begin; the inline ones everywhere.
 */
export function slashSource(getDailyFolder: () => string) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\/[a-zA-Z]*/)
    if (!before) return null
    const line = context.state.doc.lineAt(before.from)
    const ahead = line.text.slice(0, before.from - line.from)
    // A `/` must start a word, or every URL and path opens the menu.
    if (ahead !== '' && !/\s$/.test(ahead)) return null

    const query = before.text.slice(1).toLowerCase()
    const offered = [...(ahead.trim() === '' ? BLOCKS : []), ...inlineOptions(getDailyFolder())]
    const options = offered.filter((one) => one.label.toLowerCase().includes(query))
    return options.length ? { from: before.from, filter: false, options } : null
  }
}

/**
 * The `[[` popup. `matchNotes` has ranked the notes, hence
 * `filter: false`. It writes `[[Name]]`, which `links.ts` reads.
 *
 * `to` reaches over a `]]` already there: typing `[[` closes its
 * own pair, and replacing only `[[query` would write `[[Name]]]]`.
 *
 * The last option is a note that does not exist yet, whenever the
 * typed text is not a note's name, so a link can be written before
 * its note. Following it makes the note (`openLinkTarget`). A name a
 * note carries (`aliases::`) is offered as itself, with the note's path.
 */
export function wikiLinkSource(getNotes: () => VaultFile[], getAliases: () => readonly Alias[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^\]\n]*/)
    if (!before) return null
    const query = before.text.slice(2)
    // The limit is `matchNotes`'s own.
    const matches = matchNotes(query, getNotes(), getAliases())
    const options = matches.map((match) => ({
      label: match.alias ?? match.note.name,
      // The path the tree shows, not the file's: a nested note's file is
      // `Areas/Northwind/Northwind.md`. No `.md`; a link never carries one.
      detail: knownPath(match.note.path),
      apply: `[[${match.alias ?? match.note.name}]]`,
    }))
    // Not offered when a note already has that name, or that
    // path for a name with a `/`.
    const typed = query.trim()
    const lower = typed.toLowerCase()
    const known = matches.some(
      (match) =>
        (match.alias ?? match.note.name).toLowerCase() === lower ||
        knownPath(match.note.path).toLowerCase() === lower ||
        noteName(match.note.path).toLowerCase() === lower
    )
    if (typed && !known) {
      options.push({ label: typed, detail: 'new page', apply: `[[${typed}]]` })
    }
    const closed = context.state.sliceDoc(context.pos, context.pos + 2) === ']]'
    return {
      from: before.from,
      to: closed ? context.pos + 2 : context.pos,
      filter: false,
      options,
    }
  }
}

/**
 * The popup's look, as a CodeMirror theme rather than `index.css`: CodeMirror adds its
 * base theme after the sheet, and equal rules in the sheet lost twice. The values
 * still come from the sheet's tokens and gaps; `stylesheet.test.ts` reads this block.
 */
export const completionAppearance = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: 'var(--bg-raised)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--fs-chrome)',
    padding: '0.25rem',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    maxHeight: 'var(--picker-height)',
    overflowY: 'auto',
    margin: '0',
    padding: '0',
    fontFamily: 'inherit',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.75rem',
    padding: '0.4rem 0.5rem',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text)',
    lineHeight: '1.4',
    minWidth: '0',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--bg-active)',
    color: 'var(--text)',
  },
  '.cm-completionLabel': { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // Weight, not colour: the accent on a selected row measured 4.09:1.
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: 'var(--fw-strong)' },
  '.cm-completionDetail': {
    flex: 'none',
    color: 'var(--text-dim)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.92em',
    fontStyle: 'normal',
    maxWidth: '55%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // No icon column; the detail says the type.
  '.cm-completionIcon': { display: 'none' },
})


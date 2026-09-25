// The three things `[[`, `/` and `--` open, and how the popup they share looks.
//
// CodeMirror's own autocomplete draws both: it places the tooltip, moves the
// selection on the arrows, takes Enter and dismisses on Escape. So there is no
// popup component in this app and no keyboard handling — a source answers what to
// offer, and `completionAppearance` says what it looks like.

import { EditorView } from '@codemirror/view'
import { snippetCompletion } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { declarationSnippet, DECLARED_KEYWORD, KEYWORD_PREFIX } from './actions'
import { localDateStamp, localTimeStamp } from './clock'
import { matchNotes } from './links'
import { knownPath, noteName } from './vaultModel'
import type { VaultFile } from './vaultModel'

/**
 * The block commands `/` offers, and the markdown each one writes.
 *
 * A flat list on purpose: these are the blocks a note is actually made of, and a
 * menu short enough to read needs no grouping.
 */
const BLOCKS: readonly { label: string; detail: string; insert: string }[] = [
  { label: 'Heading 1', detail: '#', insert: '# ' },
  { label: 'Heading 2', detail: '##', insert: '## ' },
  { label: 'Heading 3', detail: '###', insert: '### ' },
  { label: 'Bullet list', detail: '-', insert: '- ' },
  { label: 'Numbered list', detail: '1.', insert: '1. ' },
  { label: 'Task', detail: '- [ ]', insert: '- [ ] ' },
  { label: 'Quote', detail: '>', insert: '> ' },
  { label: 'Code block', detail: '```', insert: '```\n\n```' },
  { label: 'Divider', detail: '---', insert: '---\n' },
]

/**
 * What `/` offers **in the middle of a sentence**, where a block command cannot go.
 *
 * `# ` halfway through a line is not a heading, it is a hash — so the block list is
 * offered only where a block can start, and this list is offered everywhere. A link
 * to today's page is the first of them: it is the one thing a journal refers to
 * constantly and the only way to write it was to know today's date and type it.
 *
 * The link carries the **folder** — `[[Daily/2026-09-16]]` — so that following it
 * makes the note in the daily folder rather than at the root. It still *reads* as
 * the date, because a link reads as its name.
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
      // **The trailing space is part of the stamp**, and for the reason
      // `insertTimeKeymap` gives: `LEADING_CLOCK` wants whitespace or the line end
      // after the time, so a caret left tight against it turns `09:41` into `09:41w`
      // on the next keystroke and the mark goes out. Same string as ⌘⇧T writes —
      // one act, one spelling.
      apply: `${localTimeStamp()} `,
    },
  ]
}

/**
 * The `/` menu, on the same completion machinery as the `[[` picker — so CodeMirror
 * draws both, and there is one popup in this app rather than two.
 *
 * **It opens wherever a `/` opens a word**, which is the rule `--` already uses: at
 * the start of a line, or after a space. That guard is what keeps `http://` and
 * `Areas/Northwind` from opening a menu — the old rule was "first thing on the
 * line", which kept them out by keeping the menu out of a sentence altogether.
 *
 * What it offers depends on where it is. A block command writes `# ` or `- `, which
 * is only a block at the start of a line; mid-sentence those are punctuation. So the
 * blocks are offered where a block can begin and the inline ones everywhere.
 */
export function slashSource(getDailyFolder: () => string) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\/[a-zA-Z]*/)
    if (!before) return null
    const line = context.state.doc.lineAt(before.from)
    const ahead = line.text.slice(0, before.from - line.from)
    // A `/` has to open a word, or every URL and every path is a menu.
    if (ahead !== '' && !/\s$/.test(ahead)) return null

    const query = before.text.slice(1).toLowerCase()
    const offered: Completion[] = [
      ...(ahead.trim() === ''
        ? BLOCKS.map((block) => ({
            label: block.label,
            detail: block.detail,
            apply: block.insert,
          }))
        : []),
      ...inlineOptions(getDailyFolder()),
    ]
    const options = offered.filter((one) => one.label.toLowerCase().includes(query))
    return options.length ? { from: before.from, filter: false, options } : null
  }
}

/**
 * The `[[` note picker, as a CodeMirror completion source.
 *
 * CodeMirror's own autocomplete draws the popup, moves the selection on the arrows,
 * takes Enter and dismisses on Escape — so there is no popup component here, and no
 * keyboard handling. `matchNotes` has already ranked the notes, hence `filter: false`.
 *
 * It inserts `[[Name]]`, which is what Obsidian writes and what `links.ts` reads.
 * There is no serialiser to escape it any more, so the plainest thing is also the
 * correct one.
 *
 * Two things beyond ranking the notes.
 *
 * `to` reaches over a `]]` that is already there. Typing `[[` closes its own pair,
 * so the usual way into this popup leaves the caret between four brackets — and a
 * completion that replaced only `[[query` would write `[[Name]]]]`.
 *
 * And the last option is the **note that does not exist**: a link is written before
 * the thing it points at, which is the whole of how a vault grows. Offered whenever
 * what has been typed is not already a note's name, so `[[Landmark Plaza]]` can be
 * made from the popup rather than by escaping out of it and closing the brackets by
 * hand. Following it is what creates the note — see `openLinkTarget`.
 */
export function wikiLinkSource(getNotes: () => VaultFile[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^\]\n]*/)
    if (!before) return null
    const query = before.text.slice(2)
    // The cap is `matchNotes`'s own — a second copy of it here was the same number
    // written twice, and a popup's length is that function's business.
    const matches = matchNotes(query, getNotes())
    const options = matches.map((match) => ({
      label: match.note.name,
      // The path the tree calls it, not the file's own: a nested note's file sits
      // at `Areas/Northwind/Northwind.md`, and offering *that* as where the page
      // is names a row nobody can see. No `.md` either — a link never carries one.
      detail: knownPath(match.note.path),
      apply: `[[${match.note.name}]]`,
    }))
    // Not offered for a note that is already there under that spelling — by name or
    // by the path a name with a `/` in it is asking for.
    const typed = query.trim()
    const lower = typed.toLowerCase()
    const known = matches.some(
      (match) =>
        match.note.name.toLowerCase() === lower ||
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

/** A collection the popup can offer: its name, and the line it declares if it has
 *  declared one. */
export interface CollectionOption {
  name: string
  declaration: string | null
}

/**
 * The `--` collection picker.
 *
 * **A declared collection completes the whole line.** Its file holds one line
 * saying how its lines are written — `--expense <<amount>> on [[<<merchant>>]] using
 * <<method>>` — and this inserts it as a snippet, so the caret lands in `amount` and
 * Tab moves to `merchant`. That is the point of declaring one: the structure is
 * filled in rather than remembered.
 *
 * A collection with no declaration still completes its own name, because the popup
 * is also how you find out which collections a vault has.
 *
 * `(^|\s)` in front, as `OPENER` has it: the dashes have to open a word, or every
 * `stroke--width` in prose would open a menu. `matchBefore` cannot look behind its
 * own match, so the character before is checked here.
 */
export function collectionSource(getCollections: () => CollectionOption[]) {
  return (context: CompletionContext): CompletionResult | null => {
    // The same rule `OPENER` opens with, em dash included — see `KEYWORD_PREFIX`.
    const before = context.matchBefore(KEYWORD_PREFIX)
    if (!before) return null
    const ahead = before.from === 0 ? '' : context.state.sliceDoc(before.from - 1, before.from)
    if (ahead !== '' && !/\s/.test(ahead)) return null

    const options: Completion[] = getCollections().map((one) =>
      one.declaration
        ? snippetCompletion(declarationSnippet(one.declaration), {
            label: `--${one.name}`,
            // The structure itself, so the popup shows what will be written.
            // Trimmed here rather than in the rule: the popup wants it tidy and
            // `templateFields` needs the whitespace exactly as written.
            detail: one.declaration.replace(DECLARED_KEYWORD, '').trimStart(),
          })
        : { label: `--${one.name}`, apply: `--${one.name} ` }
    )
    // CodeMirror filters these against what has been typed — the labels carry the
    // `--`, and `from` is at it, so `--exp` narrows to `--expense` on its own.
    return options.length ? { from: before.from, options } : null
  }
}

/**
 * The completion popup, as a CodeMirror theme rather than rules in `index.css`.
 *
 * Twice these were written as ordinary CSS and twice they lost: CodeMirror injects
 * its own base theme at runtime, so equal-specificity rules in this project's sheet
 * are overridden by whatever it inserts later. A theme is scoped by CodeMirror onto
 * its own elements, so it wins by construction. **The values still come from the
 * sheet** — its tokens and its one set of gaps — because moving the cascade is not
 * a licence to invent sizes: these had a `4px` radius where the sheet has one, a
 * `0.85em` step-down where the sheet has one at `0.92em`, and two paddings in
 * numbers nothing else uses. `stylesheet.test.ts` reads this block for that now.
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
  // Weight, not colour: `--accent-soft` on a selected row measures 4.09:1.
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
  // No completion sets a `type`, so the icon column is empty.
  '.cm-completionIcon': { display: 'none' },

})


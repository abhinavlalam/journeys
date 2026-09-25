// Live Preview: what the document *looks* like, without changing what it says.
//
// Every rendered thing here is a decoration over the file's own bytes — a class on
// a range, a marker hidden, a bullet drawn in place of `- `. Nothing rewrites the
// text, and every piece of syntax keeps a caret position, which is the property the
// whole editor exists for (`MarkdownEditor.tsx`).

import { Facet, type EditorState, type Range as CmRange } from '@codemirror/state'
import { Decoration, WidgetType, type DecorationSet } from '@codemirror/view'
import { getIndentUnit, syntaxTree } from '@codemirror/language'
import { decorated } from './EditorHost'
import type { SyntaxNodeRef } from '@lezer/common'
import { PROPERTY_KEY } from './frontmatter'
import { LEADING_CLOCK } from './clock'
import { collectionSyntax, keywordAt } from './actions'
import { checkMarkup } from './icons'
import { TAG, tagAt } from './tags'
import { linkLabelSpan } from './vaultModel'
import type { CollectionOption } from './editorComplete'

/**
 * The frontmatter block, if the note opens with one.
 *
 * Markdown reads `---` as a rule and the line under it as a setext heading, so
 * without a rule of its own this block renders as prose that happens to have
 * dashes around it — which is exactly how it read: three lines nobody could
 * identify as properties. Marked whole and set in mono, it reads as metadata.
 *
 * The same shape `vault.ts` and `frontmatter.ts` use, so one answer to "is there a
 * block here" rather than three.
 */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/

/** `[[Target]]` and `[[Target|Alias]]`, which CommonMark parses as plain text. */
const WIKILINK = /\[\[([^\]\n]+)\]\]/g
/** `[label](target)`, for reading a target back off a clicked line. */
const MDLINK = /\[[^\]\n]*\]\(([^)\n]+)\)/g
/** A link written as itself: `<url>`, a bare URL, or a bare email. The same three
 *  GFM parses, so a click on one goes where the colour says it does. */
const BARE = /<?((?:https?:\/\/|www\.|mailto:)[^\s<>()]+|[\w.+-]+@[\w-]+\.[\w.-]+)>?/g

/**
 * Whether a click landed on a link's own glyphs.
 *
 * **The DOM does this hit test, not `posAtCoords`.** A click in the empty space
 * past the end of a line has no position of its own, so `posAtCoords` hands back
 * the nearest one — the end of the line — which is *inside* the link whenever the
 * link is the last thing on that line. Clicking out there to put the caret at the
 * end of the text followed the link instead. Asking the event where it landed
 * answers that, and answers for a link broken across a wrap as well, which a
 * comparison against one rectangle would not.
 *
 * `cm-md-link` is the class the two decorations below put on both kinds, which is
 * why this is here and not in the editor component.
 */
export function isLinkClick(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.cm-md-link') !== null
}

/**
 * Was the press on a collection's keyword? `.cm-md-collection` is on it whether or
 * not the line is being edited, so the answer does not depend on where the caret
 * happens to be — the same property that makes `.cm-md-link` usable.
 */
export function isCollectionClick(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.cm-md-collection') !== null
}

/** The collection named at `pos`, or null. `linkTargetAt`'s shape, and read the
 *  same way: off the line's own text, which is where the keyword is defined. */
export function collectionAt(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos)
  const keyword = keywordAt(line.text)
  if (!keyword) return null
  const offset = pos - line.from
  return offset >= keyword.from && offset <= keyword.to ? keyword.name : null
}

/**
 * The link target under `pos`, or null. Read off the line's text rather than the
 * syntax tree: the wikilink half is not a node, so one scan answers for both kinds.
 */
export function linkTargetAt(state: EditorState, pos: number): { target: string; wiki: boolean } | null {
  const line = state.doc.lineAt(pos)
  const offset = pos - line.from
  for (const [pattern, wiki] of [
    [WIKILINK, true],
    [MDLINK, false],
    [BARE, false],
  ] as const) {
    for (const hit of line.text.matchAll(pattern)) {
      const at = hit.index ?? 0
      if (offset >= at && offset <= at + hit[0].length) {
        // `[[Target|Alias]]` — the target is the left of the pipe.
        return { target: hit[1].split('|')[0].trim(), wiki }
      }
    }
  }
  return null
}

/** Whether a press landed on a tag. `isLinkClick`'s shape. */
export function isTagClick(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.cm-md-tag')
}

/** The tag at `pos`, read off the line's own text — `collectionAt`'s shape. */
export function tagNameAt(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos)
  return tagAt(line.text, pos - line.from)
}

/** Inline nodes that render, and the class that renders them. */
const INLINE: Record<string, string> = {
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-em',
  InlineCode: 'cm-md-code',
  Strikethrough: 'cm-md-strike',
}

/** The child nodes that are syntax rather than content. */
const MARKERS = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'HeaderMark', 'QuoteMark'])

/** Block nodes that render, and the class that renders them. */
const BLOCK: Record<string, string> = { Blockquote: 'cm-md-quote' }

/**
 * A real bullet in place of the `-`.
 *
 * Hiding the marker outright is what headings do, but a list cannot: with `- ` gone
 * the item loses its bullet *and* its indent, and reads as a bare paragraph. So the
 * marker is replaced rather than removed, and the glyph carries the width.
 *
 * Only ever for a bullet list. An ordered list's marker is `1.`, which is content —
 * a reader needs the number — so it is left exactly as typed.
 */
/**
 * A task line: the list marker, then `[c]`, then a space or the line's end.
 *
 * **Obsidian's rule and not GFM's.** GFM parses exactly `[ ]` and `[x]` and gives
 * them a `TaskMarker` node; a vault written in Obsidian is full of `[-]`, `[>]` and
 * `[/]` besides, which that grammar reads as ordinary text. So this is a scan of the
 * line, the same answer `[[wikilinks]]` get and for the same reason: the parser does
 * not have them. **Any single character is a state**, and one the app draws no glyph
 * for is drawn as itself rather than guessed at or dropped.
 *
 * The trailing `(?=\s|$)` is what keeps two other things from being tasks:
 * `- [[Note]]` opens a wikilink, and `- [x](url)` is a markdown link labelled `x`.
 */
const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\](?=\s|$)/

/** What the app draws for a state: a box, a ticked box, or the character itself. */
function taskState(mark: string): 'open' | 'done' | 'other' {
  if (mark === ' ') return 'open'
  return /^[xX]$/.test(mark) ? 'done' : 'other'
}

/**
 * The task on the line `pos` is in, or null — read off the line's own text, the
 * shape `linkTargetAt` and `collectionAt` already have.
 *
 * `from` is the `[`, so the state character is the one byte at `from + 1`. That is
 * the whole of what a press rewrites: **one character**, which is what keeps this
 * honest to "the document is the file's own text".
 */
export function taskAt(
  state: EditorState,
  pos: number
): { from: number; mark: string } | null {
  const line = state.doc.lineAt(pos)
  const hit = TASK_LINE.exec(line.text)
  return hit ? { from: line.from + hit[1].length, mark: hit[2] } : null
}

/** A press checks an open task and clears any other state. */
export function toggledTask(mark: string): string {
  return mark === ' ' ? 'x' : ' '
}

/** Whether a press landed on a checkbox. `isLinkClick`'s shape. */
export function isTaskClick(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.cm-md-task')
}

/**
 * The checkbox drawn in place of `- [ ] `.
 *
 * **One marker per item**: it replaces the bullet rather than sitting beside it,
 * because a checkbox already says the line is a list item and two markers is the
 * same doubling `numberMark` avoids. On an *ordered* item the number is content and
 * stays, so there the box has no grid width of its own and the checkbox follows the
 * number as a word would.
 */
class CheckboxWidget extends WidgetType {
  mark: string
  box: string | null
  constructor(mark: string, box: string | null) {
    super()
    this.mark = mark
    this.box = box
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-md-task'
    span.dataset.state = taskState(this.mark)
    // The grid box, as the bullet takes it — see `markerBox`.
    if (this.box) span.style.minWidth = this.box
    const box = document.createElement('span')
    box.className = 'cm-md-task-box'
    if (span.dataset.state === 'done') box.innerHTML = checkMarkup()
    if (span.dataset.state === 'other') box.textContent = this.mark
    span.append(box)
    return span
  }

  eq(other: CheckboxWidget) {
    return other.mark === this.mark && other.box === this.box
  }

  /** The editor's own `mousedown` handles the press, as it does for a link, so the
   *  event has to reach it rather than being swallowed here. */
  ignoreEvent() {
    return false
  }
}

class BulletWidget extends WidgetType {
  box: string
  constructor(box: string) {
    super()
    this.box = box
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-md-bullet'
    // The box is per item — see `markerBox` — because the document's own nesting
    // and the app's step are different numbers.
    span.style.minWidth = this.box
    // No glyph and no handler: the dot is drawn by CSS, and the thing that collapses
    // a list is the line above it, not the bullet.
    return span
  }
  eq(other: BulletWidget) {
    return other.box === this.box
  }
}

/**
 * The marker's box: **whatever is left of the item's own step after its leading
 * spaces**, so the text lands on the grid however the document is indented.
 *
 * A list's depth in the file is markdown's — a child's marker sits at its parent's
 * content column, two or three characters in — and the grid's step is the indent
 * setting, six spaces in the vault this was found in. Those are not the same
 * number, so a box of one whole step put a nested item's text 1.33 steps in and a
 * level could not be read off the page. Given the level, the box makes up the
 * difference: `level + 1` steps, less the spaces already on the line.
 *
 * `max(0px, …)` because a document may indent further than the grid does — three
 * spaces where a step is two — and a negative box would pull the text left of the
 * margin.
 */
function markerBox(level: number, spaces: number): string {
  return `max(0px, calc(${level + 1} * var(--indent-step) - ${spaces} * var(--space-w)))`
}

/** How many lists this item is inside. The tree knows, and counting spaces does
 *  not: markdown nests by content column and the grid steps by the setting. */
function listLevel(node: SyntaxNodeRef): number {
  let level = 0
  for (let at = node.node.parent; at; at = at.parent) if (at.name === 'ListItem') level++
  return level
}

/**
 * `---` on its own line, drawn as the line it stands for.
 *
 * An inline widget at full width rather than a block one: a block widget would
 * replace the line, and the three characters have to stay in a line the caret can
 * reach — which is the same bargain every marker in this editor makes.
 */
class RuleWidget extends WidgetType {
  private readonly className: string
  constructor(className: string) {
    super()
    this.className = className
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = this.className
    return span
  }
  eq(other: RuleWidget) {
    return other.className === this.className
  }
}

const ruleDeco = Decoration.replace({ widget: new RuleWidget('cm-md-rule') })

/**
 * The frontmatter's `---`, which is a **fence** and not a divider. It drew as the
 * accent rule like any other row of dashes, so `icon: calendar` sat between the two
 * heaviest strokes on the page — rendered at a real vault's settings, the property
 * block was the first and loudest thing under every title. A fence bounds a block
 * of data; a hairline says so without competing with the prose it introduces.
 */
const fenceDeco = Decoration.replace({ widget: new RuleWidget('cm-md-fence') })

const HEADING = /^ATXHeading([1-6])$/

/** The characters a divider takes, which is CommonMark's own count for a thematic
 *  break. A setext underline has no minimum, which is why this is needed. */
const MIN_RULE = 3

/**
 * True when the line holds nothing but the run at `[from, to)`.
 *
 * A row of dashes is a divider only when it is the whole line: `--- see below` is a
 * sentence that opens with dashes and `- ---` is a list item. CommonMark already
 * agrees for a `HorizontalRule`, but the setext case has to be asked directly, and
 * saying it once here is what keeps the two answers the same.
 */
function fillsItsLine(state: EditorState, from: number, to: number): boolean {
  const line = state.doc.lineAt(from)
  if (line.from > from || line.to < to) return false
  return line.text.trim() === state.doc.sliceString(from, to).trim()
}

/**
 * Space above a heading — on the **line**, not on the heading.
 *
 * A heading's class is a mark over its text, and margin on an inline box does
 * nothing. In a source editor every line is one line box, so without this a heading
 * sits exactly one leading below the paragraph it interrupts, which is what made a
 * page of notes read as a wall.
 */
const headingLine = Decoration.line({ class: 'cm-md-heading-line' })

/**
 * A line that **opens with a clock** starts a journal entry, so it gets air above
 * it the way a heading does.
 *
 * Reported from the running app: a page of more than ten lines reads "weirdly full
 * and empty at the same time". Measured on a real daily note — nineteen lines, no
 * headings, every one the same size, weight and 4px apart. Dense, and with nothing
 * to rest on. A journal has structure the app can already see and was not drawing:
 * `12:00` starts a thing, the lines under it are its detail. Air above the clock
 * turns nineteen identical rows into the eight entries they are.
 */

/**
 * Every collection's declaration, for the renderer.
 *
 * The editor already holds these for the `--` popup; this hands them to the
 * decorations, which are a pure function of the state and had no other way to
 * see them. A *getter*, because the extension list is built once and the vault's
 * declarations arrive later and change — the decorations call it each time they
 * compute. With none provided (a test's bare state) it answers an empty list, and
 * a collection line renders as it did before there was a declaration to read.
 */
export const collectionDeclarations = Facet.define<
  () => CollectionOption[],
  () => CollectionOption[]
>({ combine: (values) => values[0] ?? (() => []) })

function declarationFor(state: EditorState, name: string): string | null {
  const lower = name.toLowerCase()
  return (
    state
      .facet(collectionDeclarations)()
      .find((one) => one.name.toLowerCase() === lower)?.declaration ?? null
  )
}

/** `--expense` itself, in the app's one label format. */
const collectionMark = Decoration.mark({ class: 'cm-md-collection' })

/** Gone from the layout entirely — not `visibility`, which would leave its width. */
const hidden = Decoration.replace({})

/**
 * One step of a line's indentation, marked so the tree can be drawn down its left.
 *
 * **On the spaces themselves**, which is the whole trick: the prose font is
 * proportional, so an indent step has no width this code could compute — but a mark
 * over the spaces starts exactly where they do, whatever the font does. The
 * alternative was measuring a space and drawing a background at multiples of it,
 * which is a measurement to keep in step with a font the user can change.
 *
 * Four of them, because a step is one of four things: a trunk carrying on down, a
 * trunk ending at this line, and each of those with the **elbow** that turns into
 * the text. The first drawing had only the trunk, so a lone indented line under its
 * parent was a bare vertical stroke beside it, connected to nothing.
 */
const GUIDE = {
  through: Decoration.mark({ class: 'cm-md-guide' }),
  ending: Decoration.mark({ class: 'cm-md-guide cm-md-guide-end' }),
  elbow: Decoration.mark({ class: 'cm-md-guide cm-md-elbow' }),
  elbowEnding: Decoration.mark({ class: 'cm-md-guide cm-md-guide-end cm-md-elbow' }),
}

/**
 * The indent of the next line with anything on it, or -1 past the end.
 *
 * Blank lines are looked through, for the reason `indentRange` looks through them:
 * one gap inside a list does not end the list, and a trunk that stopped at it
 * would say otherwise.
 */
function indentBelow(state: EditorState, line: number): number {
  for (let n = line + 1; n <= state.doc.lines; n++) {
    const at = state.doc.line(n).text.search(/\S/)
    if (at >= 0) return at
  }
  return -1
}
const markerMark = Decoration.mark({ class: 'cm-md-marker' })

/** An ordered item's `1.`, boxed like a bullet so its text lands on the grid. The
 *  characters stay characters — see the `ListItem` case — and the box is the
 *  item's own, for the reason `markerBox` gives. */
const numberMark = (box: string) =>
  Decoration.mark({ class: 'cm-md-number', attributes: { style: `min-width:${box}` } })

/** A checked task's words. One decoration, because every done item takes it. */
const taskDone = Decoration.mark({ class: 'cm-md-task-done' })

/**
 * A line whose wrapped rows hang under its text, told **how far** as a length.
 *
 * It was a number of *steps*, and only list lines were given one — so an indented
 * line of prose wrapped back to the margin: reported as the second and third rows
 * of a wrapped line starting at the edge of the reading pane while the first row
 * sat correctly indented. A journal's detail lines are indented prose, not list
 * items, so nothing was hanging them.
 *
 * A **length** rather than a count, because the two cases measure differently: a
 * list's depth is `(level + 1)` of the indent *step* — markdown's nesting, which is
 * not the number of spaces on the line — while an indented prose line hangs by
 * exactly the spaces it carries, `n * --space-w`. One decoration, one rule, both
 * expressed as the distance the text is in.
 *
 * Cached per value: the same three or four distances come up on every line.
 */
const hangingLine = (hang: string) =>
  (HANGING[hang] ??= Decoration.line({
    class: 'cm-md-hang',
    attributes: { style: `--hang: ${hang}` },
  }))

const HANGING: Record<string, Decoration> = {}

/** The hang a list item's own depth asks for. */
const stepHang = (steps: number) => `calc(${steps} * var(--indent-step))`

/** The hang an indented prose line asks for: the width of its own leading spaces. */
const spaceHang = (spaces: number) => `calc(${spaces} * var(--space-w))`

/** A property's name, in the colour the timestamp carries. */
const propertyKey = Decoration.mark({ class: 'cm-md-property' })

/**
 * True when the selection reaches into `[from, to]`, boundaries included.
 *
 * Inclusive on purpose: a caret sitting immediately before the `**` of a bold run
 * is a caret about to edit it, and a run whose markers appear only once the caret
 * is *past* them is a run you cannot get into.
 */
function touched(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from)
}

/** How far into a note the property block is looked for. It opens the note, so the
 *  search stops well past any real block rather than scanning a long note on every
 *  redraw. */
const FRONTMATTER_REACH = 2000

/**
 * The decorations for one span of the document: a class over each node that
 * renders, and its syntax markers either hidden or dimmed.
 *
 * **Pure, and takes the span explicitly.** The view plugin below passes its
 * viewport; a test passes the whole document. That is deliberate — jsdom has no
 * layout, so a `ViewPlugin`'s viewport there is fiction, and a decoration test that
 * went through a mounted view would be testing the shim.
 *
 * One span rather than a list of them: `Tree.iterate` over overlapping spans would
 * enter the same node twice and emit the same `Decoration.replace` twice.
 */
export function livePreviewDecorations(
  state: EditorState,
  from: number,
  to: number
): DecorationSet {
  const found: CmRange<Decoration>[] = []
  /** Lines the syntax walk gave a hang to, so the sweep below does not double it. */
  const hung = new Set<number>()

  // The property block at the top of the note, when the span reaches it. Its end is
  // kept as the bound on the scan for property names below — the block's own `---`
  // delimiters draw as lines like any other, which is the `HorizontalRule` and
  // `SetextHeading2` cases further down.
  let frontmatterEnd = 0
  if (from === 0) {
    const block = FRONTMATTER.exec(state.doc.sliceString(0, Math.min(to, FRONTMATTER_REACH)))
    if (block) {
      frontmatterEnd = block[0].length
      found.push(Decoration.mark({ class: 'cm-md-frontmatter' }).range(0, block[0].trimEnd().length))
      // Each property's *name*, in the accent a timestamp gets — so a property
      // reads as a label with its value beside it rather than as one dim run. The
      // block's own mark already carries the mono face and the size; the name adds
      // the colour and the weight, which is the whole of what makes it a label.
      for (let at = 0; at < frontmatterEnd; ) {
        const line = state.doc.lineAt(at)
        const key = PROPERTY_KEY.exec(line.text)
        if (key) found.push(propertyKey.range(line.from, line.from + key[1].length))
        at = line.to + 1
      }
    }
  }

  // The leading clock on each line in the span. Not a node either — it is ordinary
  // text — and anchored per line rather than scanned over the whole span, which is
  // what keeps a time inside a sentence from being marked.
  const firstLine = state.doc.lineAt(from).number
  const lastLine = state.doc.lineAt(to).number
  const step = getIndentUnit(state)
  for (let n = firstLine; n <= lastLine; n++) {
    const line = state.doc.line(n)
    const stamp = LEADING_CLOCK.exec(line.text)
    if (stamp) {
      found.push(
        Decoration.mark({ class: 'cm-md-stamp' }).range(line.from, line.from + stamp[1].length)
      )
    }

    /**
     * **A collection line's labels are syntax, so they hide.**
     *
     * `09:42 --expense spent currency:: EUR amount:: 480` reads as
     * `09:42 --expense spent EUR 480`: the `key::` that tells the app which value
     * is which has done its job by the time the line is read, and the words around
     * it — `spent`, `at`, `using` — are the sentence and stay.
     *
     * The same bargain `**bold**` makes: put the caret on the line and every label
     * is back, because a line you cannot see the structure of is a line you cannot
     * correct. Per *line* and not per label — the labels are scattered through one
     * sentence, and revealing one of them mid-edit would be worse than either.
     *
     * `::` and not `:`, which is the convention a vault already writes and the only
     * one that is unambiguous: `Note: this` is prose, and a line's opening clock is
     * full of single colons.
     */
    // **An empty field hides with its lead-in**, and only while the caret is
    // elsewhere: with the caret on the line every character is back, the
    // connective prose included, because the declaration's readings are for
    // reading and the line is being edited. So the declaration is handed over only
    // for the untouched case.
    const keyword = keywordAt(line.text)
    const editing = touched(state, line.from, line.to)
    const declaration = keyword && !editing ? declarationFor(state, keyword.name) : null
    for (const part of collectionSyntax(line.text, declaration)) {
      const from = line.from + part.from
      const to = line.from + part.to
      // **The keyword takes the app's label format**, the one a property's name,
      // the clock and a JSON key take: it is a piece of the line the app itself
      // reads, which is what that format means. It does not hide with the rest —
      // `--expense` is what the line *is*, and a sentence that stops saying so
      // reads as prose that happens to be collected.
      if (part.kind === 'keyword') found.push(collectionMark.range(from, to))
      // Revealed, it is `.cm-md-marker` like every other piece of syntax the caret
      // brings back — a `**`, a `#`, a fence. It was coming back as plain prose,
      // which read as the labels being part of the sentence rather than the frame
      // around it.
      else if (editing) found.push(markerMark.range(from, to))
      else found.push(hidden.range(from, to))
    }
    // The tree down the left of an indented line: a trunk for each step it is in,
    // and an elbow on the innermost one, which is the step this line hangs off.
    //
    // Whole steps only — a line indented by three spaces where the step is four is
    // not at a level, and half a guide would say it was — and a trunk carries on
    // below only if the next line is still inside it, so the last line of a block
    // ends every trunk it closes.
    const indent = line.text.search(/\S/)
    const levels = Math.floor(Math.max(indent, 0) / step)
    const below = levels > 0 ? indentBelow(state, n) : 0
    for (let level = 0; level < levels; level++) {
      const carries = below >= (level + 1) * step
      const innermost = level === levels - 1
      const guide = innermost
        ? carries
          ? GUIDE.elbow
          : GUIDE.elbowEnding
        : carries
          ? GUIDE.through
          : GUIDE.ending
      found.push(guide.range(line.from + level * step, line.from + (level + 1) * step))
    }
  }

  // Wikilinks first. They are not a node — CommonMark reads `[[x]]` as text — so a
  // scan of the span is the whole of it.
  //
  // **A link reads as its name.** `[[Note|the alias]]` shows *the alias*, and
  // `[[Note]]` shows `Note`: the brackets and everything left of the pipe are
  // syntax, hidden while the caret is elsewhere and back the moment it lands, which
  // is the bargain every other mark in this file makes. It is also how a link gets
  // a name at all — the alias is Obsidian's spelling and this reads it.
  const text = state.doc.sliceString(from, to)
  for (const hit of text.matchAll(WIKILINK)) {
    const at = from + (hit.index ?? 0)
    const end = at + hit[0].length
    found.push(Decoration.mark({ class: 'cm-md-link' }).range(at, end))
    if (touched(state, at, end)) continue
    // **And a path is not a name.** With no alias this hid the brackets and left the
    // whole target showing, so `[[Entities/Locations/Mira Vance - Harbour View
    // Residences]]` put forty-five underlined characters of folders inside a sentence —
    // longer than most lines in the journal it was written in. The folders are how
    // the app finds the note, not what the note is called: `noteName` already says
    // so, and `knownPath` already refuses to show a nested note's doubled form for
    // the same reason. An alias still wins, a `|!2` asks for the last two names
    // back, and the whole target is there the moment the caret lands.
    const shown = linkLabelSpan(hit[1])
    // Everything either side of the shown span, the brackets included.
    found.push(hidden.range(at, at + 2 + shown.from))
    found.push(hidden.range(at + 2 + shown.to, end))
  }

  /**
   * **`#tag` is marked, and always** — the property `.cm-md-collection` has and for
   * the same reason: the mark is what makes the span pressable, and a tag goes
   * somewhere. Nothing hides, because `#` *is* the tag: unlike a link's brackets or
   * a slot's, the mark is the first character of the word and removing it would
   * leave a different word behind.
   *
   * Not a node in any grammar the editor has, so it is a scan of the span — the
   * answer the wikilinks above get, for the same reason.
   */
  for (const hit of text.matchAll(TAG)) {
    const at = from + (hit.index ?? 0) + hit[1].length
    found.push(Decoration.mark({ class: 'cm-md-tag' }).range(at, at + hit[2].length + 1))
  }

  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      // A list item's marker is the one piece of syntax that must be *replaced*
      // rather than hidden — see `BulletWidget`.
      if (node.name === 'ListItem') {
        const mark = node.node.firstChild
        if (!mark || mark.name !== 'ListMark') return
        let end = mark.to
        while (end < node.to && state.doc.sliceString(end, end + 1) === ' ') end++

        /**
         * The line hangs by however many steps its text is in.
         *
         * The first row starts where the characters put it — the leading spaces
         * and the marker's box — and every wrapped row after it starts under that
         * text, which is what `padding-left` with a matching negative
         * `text-indent` does. The number is set per line because the depth is.
         */
        const line = state.doc.lineAt(mark.from)
        const spaces = Math.max(line.text.search(/\S/), 0)
        const level = listLevel(node)
        const box = markerBox(level, spaces)
        hung.add(line.number)
        found.push(hangingLine(stepHang(level + 1)).range(line.from))

        /**
         * **The marker sits in the gap; the text sits on the grid.**
         *
         * Both markers get a box one indent step wide, less the gap, with what is
         * in it right-aligned — so an item's text starts exactly where a line
         * indented one step starts, and `9.` and `10.` put their text in the same
         * column. The line's own hanging indent, below, keeps a wrapped item's
         * second row under the first row's text.
         */
        /**
         * **A task's box is always drawn, and never revealed.** A checkbox has to
         * be pressable whether or not the caret is in the line — the property that
         * makes `.cm-md-collection` usable, for the same reason — and a `[x]` that
         * turned back into three characters the moment you clicked into the item
         * would be un-pressable exactly while it was being written.
         */
        const task = TASK_LINE.exec(line.text)
        const taskFrom = task ? line.from + task[1].length : -1
        let taskTo = taskFrom + 3
        if (task) {
          while (taskTo < line.to && state.doc.sliceString(taskTo, taskTo + 1) === ' ') taskTo++
        }
        // A done item's words step back to `--text-dim`. **Not a strikethrough**:
        // `~~text~~` is its own syntax here, and drawing a checked task the same way
        // would be two different facts wearing one mark.
        if (task && taskState(task[2]) === 'done' && taskTo < line.to) {
          found.push(taskDone.range(taskTo, line.to))
        }

        if (/\d/.test(state.doc.sliceString(mark.from, mark.to))) {
          // `1.` is content, not syntax: a reader needs the number, so this is a
          // *mark* over the characters and not a widget in their place. The caret
          // can still get inside it and renumber the item.
          found.push(numberMark(box).range(mark.from, end))
          // The number already took the grid box, so the checkbox takes none.
          if (task) {
            found.push(
              Decoration.replace({ widget: new CheckboxWidget(task[2], null) }).range(taskFrom, taskTo)
            )
          }
          return
        }
        if (task) {
          // The marker and the `[x]` go together, so the box lands on the grid.
          found.push(
            Decoration.replace({ widget: new CheckboxWidget(task[2], box) }).range(mark.from, taskTo)
          )
          return
        }
        // **Always** the bullet, unlike `**` or `_`, which reveal when the caret is
        // in them. A list marker is not something you edit in place — you delete the
        // item or outdent it — and revealing it meant that typing `- ` showed a
        // hyphen for as long as the caret stayed on that line, which is every
        // moment you are writing the item.
        found.push(Decoration.replace({ widget: new BulletWidget(box) }).range(mark.from, end))
        return
      }

      // `---`, drawn as a line when the caret is elsewhere and shown as the three
      // characters when it is on them.
      //
      // **Including the property block's own pair.** Those were skipped once, on the
      // reasoning that a note should not open with a line where its first delimiter
      // should be; drawn, the properties sit between two lines and read as the panel
      // they are. The parser sees the two differently — the opening `---` is this
      // node and the closing one is a setext heading's underline, handled below —
      // which is why rendering them took two branches and not one flag.
      if (node.name === 'HorizontalRule') {
        if (!fillsItsLine(state, node.from, node.to)) return
        found.push(
          touched(state, node.from, node.to)
            ? markerMark.range(node.from, node.to)
            : (node.from < frontmatterEnd ? fenceDeco : ruleDeco).range(node.from, node.to)
        )
        return
      }

      // `---` typed straight under a line of text is a **setext heading** in
      // CommonMark: the line above becomes an H2 and the dashes are its underline,
      // so the `HorizontalRule` case above never sees them. Measured before this,
      // the note showed *neither* — no line and no heading — because nothing here
      // claimed either node, which is what "typing --- does nothing" was. A line
      // that is nothing but dashes is a divider in the note being written, so it
      // draws as one and the text above stays the paragraph it looks like.
      //
      // `___` needs none of this: underscores cannot underline a setext heading, so
      // a line of them is a `HorizontalRule` wherever it sits.
      if (node.name === 'SetextHeading2') {
        const mark = node.node.getChild('HeaderMark')
        if (!mark || !fillsItsLine(state, mark.from, mark.to)) return
        // **Three at least.** A setext underline is *one or more* dashes in
        // CommonMark, so without this a lone `-` under a line of text drew a rule
        // — and a lone `-` is how a list item starts. A thematic break needs three
        // of them, which is the rule a writer is using when they type a row of
        // dashes, so it is the rule here.
        if (mark.to - mark.from < MIN_RULE) return
        found.push(
          touched(state, mark.from, mark.to)
            ? markerMark.range(mark.from, mark.to)
            : (mark.from < frontmatterEnd ? fenceDeco : ruleDeco).range(mark.from, mark.to)
        )
        return
      }

      /**
       * Every kind of link, and each one **reads as its name**.
       *
       * - `[the label](url)` — a `Link` with a `URL` child. The label is the name;
       *   the brackets, the parentheses and the URL are syntax.
       * - `<url>` — an `Autolink`. The angle brackets are syntax.
       * - a bare `https://…`, and a bare email — GFM parses either as a top-level
       *   `URL` node, and nothing marked it before: a line of pasted links was
       *   plain text you could not click.
       *
       * The `URL` child of a `Link` or an `Autolink` is skipped here, because its
       * parent has already dressed it — `iterate` visits both.
       */
      if (node.name === 'Link' || node.name === 'Autolink') {
        // CommonMark also reads the inner `[x]` of a `[[wikilink]]` as a
        // shortcut-reference `Link`; marking that put two overlapping marks on
        // every wikilink, so a `URL` child is what makes this a link of its own.
        if (node.name === 'Link' && !node.node.getChild('URL')) return
        // **A URL inside a slot is the slot's value, not an autolink.** Markdown
        // reads `<<https://…>>` as `<`, an Autolink `<https://…>`, `>` — so the
        // slot's inner brackets were the link's, the second-last `>` was coloured
        // as part of the URL and the wrong pair was hidden. Reported in those
        // words. The slot's brackets are the app's own syntax and win: the link is
        // what lies between them, and `collectionSyntax` deals with the brackets.
        if (
          node.name === 'Autolink' &&
          state.sliceDoc(node.from - 1, node.from) === '<' &&
          state.sliceDoc(node.to, node.to + 1) === '>'
        ) {
          found.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from + 1, node.to - 1))
          return
        }
        found.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to))
        if (touched(state, node.from, node.to)) return
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          // The label is what is left: a `LinkMark` is a bracket and the `URL` is
          // where it goes. An `Autolink` has no label, so its URL stays.
          const syntax = child.name === 'LinkMark' || (child.name === 'URL' && node.name === 'Link')
          if (syntax) found.push(hidden.range(child.from, child.to))
        }
        return
      }

      if (node.name === 'URL') {
        const parent = node.node.parent
        if (parent && (parent.name === 'Link' || parent.name === 'Autolink')) return
        found.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to))
        return
      }

      const heading = HEADING.exec(node.name)
      const rendered = heading ? `cm-md-h${heading[1]}` : (INLINE[node.name] ?? BLOCK[node.name])
      if (!rendered) return
      // The first line of the heading, which is the only line it has: the space
      // goes on the line box, and a mark cannot carry it.
      if (heading) found.push(headingLine.range(state.doc.lineAt(node.from).from))
      found.push(Decoration.mark({ class: rendered }).range(node.from, node.to))
      const reveal = touched(state, node.from, node.to)
      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        if (!MARKERS.has(child.name)) continue
        // `# ` — the space belongs to the marker. Hiding the hashes alone left
        // every heading indented by one space, which is worse than showing them.
        let end = child.to
        while (end < node.to && state.doc.sliceString(end, end + 1) === ' ') end++
        found.push(reveal ? markerMark.range(child.from, end) : hidden.range(child.from, end))
      }
    },
  })
  /**
   * **Every other indented line hangs too**, which is the half that was missing.
   * A list item's hang comes off the syntax tree above, because its depth is
   * markdown's; anything else hangs by the spaces it actually carries, so a
   * journal's detail lines and a wrapped indented paragraph keep their column.
   *
   * After the tree walk, and skipping the lines that walk already claimed, so one
   * line never gets two `--hang` values.
   */
  for (let n = firstLine; n <= lastLine; n++) {
    if (hung.has(n)) continue
    const line = state.doc.line(n)
    const spaces = line.text.search(/\S/)
    if (spaces <= 0) continue
    found.push(hangingLine(spaceHang(spaces)).range(line.from))
  }

  // Sorted here rather than built in order: a nested run (`**_x_**`) is entered
  // outermost-first, so its marks and its child's do not come out in position order.
  return Decoration.set(found, true)
}

/**
 * The decorations, redrawn when `decorated` says so — which includes **the
 * selection**, the half that is easy to leave out and is the whole feature here:
 * without it the markers never come back and the note is
 * unreadable-but-rendered, the exact complaint Crepe drew.
 */
export const livePreview = decorated(livePreviewDecorations)


// Live Preview: how the note looks, without changing what it says. Everything here is
// a decoration over the file's own text: a class on a range, or a marker hidden.
// Nothing rewrites the text, and every piece of syntax keeps a caret position.

import { Facet, type EditorState, type Range as CmRange } from '@codemirror/state'
import { Decoration, WidgetType, type DecorationSet } from '@codemirror/view'
import { getIndentUnit, syntaxTree } from '@codemirror/language'
import { decorated } from './EditorHost'
import type { SyntaxNode } from '@lezer/common'
import { blockProperties, PROPERTY_KEY, splitPageProperties, typeOf } from './properties'
import type { Entries } from './configEntries'
import { LEADING_CLOCK } from './clock'
import { checkMarkup } from './icons'
import { TAG, tagAt } from './tags'
import { linkLabelSpan } from './vaultModel'

/** `[[Target]]` and `[[Target|Alias]]`, which CommonMark parses as plain text. */
const WIKILINK = /\[\[([^\]\n]+)\]\]/g
/** `[label](target)`, for reading a target back off a clicked line. */
const MDLINK = /\[[^\]\n]*\]\(([^)\n]+)\)/g
/**
 * A link written as itself: `<url>`, a bare URL, or a bare
 * email, the same three GFM parses.
 */
const BARE = /<?((?:https?:\/\/|www\.|mailto:)[^\s<>()]+|[\w.+-]+@[\w-]+\.[\w.-]+)>?/g

/**
 * Whether a click landed on a link's own text. Asks the DOM, not
 * `posAtCoords`: a click past the end of a line maps to the line's end,
 * which is inside a link that ends the line, so clicking there to place
 * the caret followed the link. The DOM also handles a link that wraps.
 */
export function isLinkClick(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.cm-md-link') !== null
}

/**
 * The link target at `pos`, or null. Read from the line's text,
 * not the syntax tree, since a wikilink isn't a node.
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
        // `[[Target|Alias]]`: the target is left of the pipe.
        return { target: hit[1].split('|')[0].trim(), wiki }
      }
    }
  }
  return null
}

/** Whether a press landed on a tag. */
export function isTagClick(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.cm-md-tag')
}

/** The tag at `pos`, read from the line's text. */
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
 * A task line: a list marker, then `[c]`, then a space or the end of the line.
 *
 * Obsidian's rule, not GFM's: GFM only knows `[ ]` and `[x]`, and
 * Obsidian vaults also use `[-]`, `[>]` and `[/]`. So any single
 * character is a state, and one with no glyph is shown as itself. The
 * `(?=\s|$)` keeps `- [[Note]]` and `- [x](url)` from being tasks.
 */
const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\](?=\s|$)/

/** What the app draws for a state: a box, a ticked box, or the character itself. */
function taskState(mark: string): 'open' | 'done' | 'other' {
  if (mark === ' ') return 'open'
  return /^[xX]$/.test(mark) ? 'done' : 'other'
}

/**
 * The task on the line at `pos`, or null, read from the line's text.
 * `from` is the `[`; a press rewrites only the character after it.
 */
export function taskAt(
  state: EditorState,
  pos: number
): { from: number; mark: string } | null {
  const line = state.doc.lineAt(pos)
  const hit = TASK_LINE.exec(line.text)
  return hit ? { from: line.from + hit[1].length, mark: hit[2] } : null
}

/** Whether `pos` is in a fenced code block, where `[ ]` is only text. */
function inFence(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'FencedCode') return true
  }
  return false
}

/** A press checks an open task and clears any other state. */
export function toggledTask(mark: string): string {
  return mark === ' ' ? 'x' : ' '
}

/** Whether a press landed on a checkbox. */
export function isTaskClick(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.cm-md-task')
}

/** The checkbox drawn in place of a task's `[ ]`. */
class CheckboxWidget extends WidgetType {
  mark: string
  constructor(mark: string) {
    super()
    this.mark = mark
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-md-task'
    span.dataset.state = taskState(this.mark)
    const box = document.createElement('span')
    box.className = 'cm-md-task-box'
    if (span.dataset.state === 'done') box.innerHTML = checkMarkup()
    if (span.dataset.state === 'other') box.textContent = this.mark
    span.append(box)
    return span
  }

  eq(other: CheckboxWidget) {
    return other.mark === this.mark
  }

  /** The editor's own `mousedown` handles the press, so the event must reach it. */
  ignoreEvent() {
    return false
  }
}

/**
 * `---` on its own line, drawn as a rule. An inline widget at full width, not
 * a block widget, so the three characters stay in a line the caret can reach.
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
 * A YAML block's `---` is a fence, not a divider, so it is drawn
 * as a hairline rather than the accent rule.
 */
const fenceDeco = Decoration.replace({ widget: new RuleWidget('cm-md-fence') })

const HEADING = /^ATXHeading([1-6])$/

/**
 * The fewest dashes that make a divider: CommonMark's count for a
 * thematic break. A setext underline has no minimum, so this is needed.
 */
const MIN_RULE = 3

/**
 * True when the line holds nothing but the run at `[from, to)`.
 * A row of dashes is a divider only when it is the whole line:
 * `--- see below` is a sentence and `- ---` is a list item.
 */
function fillsItsLine(state: EditorState, from: number, to: number): boolean {
  const line = state.doc.lineAt(from)
  if (line.from > from || line.to < to) return false
  return line.text.trim() === state.doc.sliceString(from, to).trim()
}

/**
 * Space above a heading, on the line: a margin on the heading's
 * inline mark does nothing.
 */
const headingLine = Decoration.line({ class: 'cm-md-heading-line' })


/**
 * Each property's type, for where a block property's value ends and
 * whether it is valid. A getter, because the extension list is built once
 * and `properties.json` arrives later. With none, every property is text.
 */
export const propertyTypes = Facet.define<() => Entries, () => Entries>({
  combine: (values) => values[0] ?? (() => ({})),
})

/** A block property whose value isn't of its type: its name, in the alert colour. */
const invalidProperty = Decoration.mark({ class: 'cm-md-property-invalid' })

/** Removed from the layout entirely; `visibility` would leave its width. */
const hidden = Decoration.replace({})

/**
 * One step of a line's indent, marked so the tree guides can be
 * drawn down the left. The mark is on the spaces themselves, so
 * it lines up in a proportional font without measuring anything.
 *
 * Four kinds: a trunk continuing, a trunk ending, and each with
 * the elbow that turns into the text.
 */
const GUIDE = {
  through: Decoration.mark({ class: 'cm-md-guide' }),
  ending: Decoration.mark({ class: 'cm-md-guide cm-md-guide-end' }),
  elbow: Decoration.mark({ class: 'cm-md-guide cm-md-elbow' }),
  elbowEnding: Decoration.mark({ class: 'cm-md-guide cm-md-guide-end cm-md-elbow' }),
}

/**
 * The indent of the next line with anything on it, or -1 past the
 * end. Blank lines are skipped: a gap in a list doesn't end it.
 */
function indentBelow(state: EditorState, line: number): number {
  for (let n = line + 1; n <= state.doc.lines; n++) {
    const at = state.doc.line(n).text.search(/\S/)
    if (at >= 0) return at
  }
  return -1
}
const markerMark = Decoration.mark({ class: 'cm-md-marker' })

/** A done task's words. */
const taskDone = Decoration.mark({ class: 'cm-md-task-done' })

/**
 * A line whose wrapped rows hang under its text, by a length: the width of its
 * leading spaces. Cached per value, since the same few come up on every line.
 */
const hangingLine = (hang: string) =>
  (HANGING[hang] ??= Decoration.line({
    class: 'cm-md-hang',
    attributes: { style: `--hang: ${hang}` },
  }))

const HANGING: Record<string, Decoration> = {}

/** The hang for an indented line: the width of its leading spaces. */
const spaceHang = (spaces: number) => `calc(${spaces} * var(--space-w))`

/** A property's name, in the timestamp's colour. */
const propertyKey = Decoration.mark({ class: 'cm-md-property' })

/**
 * True when the selection reaches `[from, to]`, ends included,
 * so a caret just before a `**` shows the marker.
 */
function touched(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from)
}

/** Whether `pos` is in code: a fence, an indented block, or a backtick span. */
function inCode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') return true
  }
  return false
}

/**
 * How far into a note to look for the property block. It is at
 * the top, so the search stops well past any real block.
 */
const PROPERTIES_REACH = 2000

/**
 * The decorations for one span of the document. Pure, and takes the span
 * explicitly: the view plugin passes its viewport, and a test passes the
 * whole document, since jsdom has no real viewport. One span, because
 * iterating overlapping spans would decorate a node twice.
 */
export function livePreviewDecorations(
  state: EditorState,
  from: number,
  to: number
): DecorationSet {
  const found: CmRange<Decoration>[] = []

  // The page properties at the top of the note, in either form, marked
  // as a block in mono so they read as metadata. Their end also bounds
  // a YAML block's own `---`, which is drawn as a fence below.
  let propertiesEnd = 0
  if (from === 0) {
    const { prefix } = splitPageProperties(state.doc.sliceString(0, Math.min(to, PROPERTIES_REACH)))
    if (prefix) {
      propertiesEnd = prefix.length
      found.push(Decoration.mark({ class: 'cm-md-frontmatter' }).range(0, prefix.trimEnd().length))
      // Each property's name in the accent colour, so it reads
      // as a label beside its value.
      for (let at = 0; at < propertiesEnd; ) {
        const line = state.doc.lineAt(at)
        const key = PROPERTY_KEY.exec(line.text)
        if (key) found.push(propertyKey.range(line.from, line.from + key[1].length))
        at = line.to + 1
      }
    }
  }

  // The clock at the start of each line. Matched per line, so a
  // time inside a sentence isn't marked.
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

    const editing = touched(state, line.from, line.to)
    // A block property's name is syntax: `amount:: 480` reads `480`, and a
    // quoted value reads without its quotes. The name comes back when the caret
    // is on the line. A value that isn't of its type keeps its name, in the
    // alert colour, so it doesn't look read. Not in the page block or in code.
    if (line.from >= propertiesEnd) {
      const types = state.facet(propertyTypes)()
      for (const one of blockProperties(line.text, (name) => typeOf(types, name))) {
        if (inCode(state, line.from + one.from)) continue
        const label = { from: line.from + one.from, to: line.from + one.valueFrom }
        if (!one.valid) {
          found.push(invalidProperty.range(label.from, label.to))
          continue
        }
        const syntax = editing ? markerMark : hidden
        found.push(syntax.range(label.from, label.to))
        if (one.to > one.valueTo) found.push(syntax.range(line.from + one.valueTo, line.from + one.to))
      }
    }
    // The tree down the left of an indented line: a trunk for each
    // step, and an elbow on the innermost. Whole steps only, and a
    // trunk continues only if the next line is still inside it.
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

  // Wikilinks. CommonMark reads `[[x]]` as text, so they are found by
  // scanning. A link shows its name: `[[Note|alias]]` shows the alias and
  // `[[Note]]` shows `Note`; the rest is hidden until the caret is on it.
  const text = state.doc.sliceString(from, to)
  for (const hit of text.matchAll(WIKILINK)) {
    const at = from + (hit.index ?? 0)
    const end = at + hit[0].length
    found.push(Decoration.mark({ class: 'cm-md-link' }).range(at, end))
    if (touched(state, at, end)) continue
    // A path is not a name: with no alias, only the last segment shows (`noteName`).
    // `|!2` shows the last two, and the whole target shows with the caret on it.
    const shown = linkLabelSpan(hit[1])
    // Everything either side of the shown part, brackets included.
    found.push(hidden.range(at, at + 2 + shown.from))
    found.push(hidden.range(at + 2 + shown.to, end))
  }

  /**
   * `#tag` is always marked, so it can be pressed, and nothing is hidden:
   * the `#` is part of the tag. Found by scanning, like wikilinks.
   */
  for (const hit of text.matchAll(TAG)) {
    const at = from + (hit.index ?? 0) + hit[1].length
    found.push(Decoration.mark({ class: 'cm-md-tag' }).range(at, at + hit[2].length + 1))
  }

  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      // `---` is drawn as a rule when the caret is elsewhere, and shown as
      // text when it is on it. The page block's own pair is drawn too; the
      // parser sees the closing one as a setext underline, handled below.
      if (node.name === 'HorizontalRule') {
        if (!fillsItsLine(state, node.from, node.to)) return
        found.push(
          touched(state, node.from, node.to)
            ? markerMark.range(node.from, node.to)
            : (node.from < propertiesEnd ? fenceDeco : ruleDeco).range(node.from, node.to)
        )
        return
      }

      // `---` right under a line of text is a setext heading in CommonMark, so the
      // case above never sees it. Draw it as a divider and leave the text above as
      // it is. `___` can't underline a heading, so it is always a `HorizontalRule`.
      if (node.name === 'SetextHeading2') {
        const mark = node.node.getChild('HeaderMark')
        if (!mark || !fillsItsLine(state, mark.from, mark.to)) return
        // At least three dashes: a setext underline can be one,
        // and a lone `-` starts a list item.
        if (mark.to - mark.from < MIN_RULE) return
        found.push(
          touched(state, mark.from, mark.to)
            ? markerMark.range(mark.from, mark.to)
            : (mark.from < propertiesEnd ? fenceDeco : ruleDeco).range(mark.from, mark.to)
        )
        return
      }

      /**
       * Every kind of link shows its name:
       *
       * - `[label](url)`: a `Link` with a `URL` child. The label
       *   shows; the rest is syntax.
       * - `<url>`: an `Autolink`. The angle brackets are syntax.
       * - A bare URL or email: GFM parses it as a top-level `URL` node.
       *
       * A `URL` inside a `Link` or `Autolink` is skipped here,
       * because its parent has already handled it.
       */
      if (node.name === 'Link' || node.name === 'Autolink') {
        // CommonMark also reads the inner `[x]` of a `[[wikilink]]` as a
        // `Link`; requiring a `URL` child keeps it from being marked twice.
        if (node.name === 'Link' && !node.node.getChild('URL')) return
        found.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to))
        if (touched(state, node.from, node.to)) return
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          // The label is what is left after the brackets and the
          // `URL`. An `Autolink` has no label, so its URL stays.
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
      // The heading's line gets the space; a mark can't carry it.
      if (heading) found.push(headingLine.range(state.doc.lineAt(node.from).from))
      found.push(Decoration.mark({ class: rendered }).range(node.from, node.to))
      const reveal = touched(state, node.from, node.to)
      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        if (!MARKERS.has(child.name)) continue
        // `# ` with its space: hiding only the hashes left every
        // heading indented by a space.
        let end = child.to
        while (end < node.to && state.doc.sliceString(end, end + 1) === ' ') end++
        found.push(reveal ? markerMark.range(child.from, end) : hidden.range(child.from, end))
      }
    },
  })
  // Line by line: an indented line's wrapped rows hang under its text, and a task's
  // `[ ]` is drawn as a checkbox. The checkbox is always drawn, so it can be pressed
  // while the line is being written.
  for (let n = firstLine; n <= lastLine; n++) {
    const line = state.doc.line(n)
    const spaces = line.text.search(/\S/)
    if (spaces > 0) found.push(hangingLine(spaceHang(spaces)).range(line.from))
    const task = TASK_LINE.exec(line.text)
    if (!task || inFence(state, line.from)) continue
    const boxFrom = line.from + task[1].length
    let boxTo = boxFrom + 3
    while (boxTo < line.to && state.doc.sliceString(boxTo, boxTo + 1) === ' ') boxTo++
    found.push(Decoration.replace({ widget: new CheckboxWidget(task[2]) }).range(boxFrom, boxTo))
    // A done task's words are dimmed, not struck through: `~~` is its own syntax.
    if (taskState(task[2]) === 'done' && boxTo < line.to) found.push(taskDone.range(boxTo, line.to))
  }

  // Sorted here: a nested run like `**_x_**` is entered
  // outermost first, so its marks don't come out in order.
  return Decoration.set(found, true)
}

/**
 * The decorations, redrawn when `decorated` says so, including on
 * selection changes, so markers come back when the caret moves onto them.
 */
export const livePreview = decorated(livePreviewDecorations)


/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

/**
 * The markdown editor: CodeMirror over the file's own bytes.
 *
 * Two levels, deliberately split.
 *
 * The commands and the Live Preview decorations are tested as **pure functions over
 * an `EditorState`**. jsdom implements no layout, so a mounted CodeMirror's viewport
 * there is fiction — `visibleRanges` is measured off element rects that do not
 * exist — and a decoration test that went through a view would be asserting the
 * shim. `livePreviewDecorations` takes its span as an argument for exactly this
 * reason: a test hands it the whole document.
 *
 * What genuinely needs a mount is the wiring: that the editor comes up, that its
 * change handler does *not* fire on open, and that it fires synchronously with the
 * whole document when it does.
 *
 * **What is not tested here, and cannot be:** anything geometric. Where the caret
 * lands, whether a hidden marker actually takes no width, how a 1.55em heading
 * reflows a wrapped line — all of that needs a real webview.
 */

/**
 * Two shims, both before the imports, and both about the same absence: jsdom is a
 * DOM with no browser under it.
 *
 * `navigator.platform` is `''` there, and `@codemirror/view` reads it *at module
 * load* to decide whether `Mod-` means ⌘ or Ctrl. Left alone, the keymap under test
 * would be the Windows one, and a passing ⌘B case would be asserting a chord this
 * app — which bundles for macOS only, as `shortcuts.ts` says — never sends.
 *
 * `matchMedia` does not exist at all, and CodeMirror's `DOMObserver` calls
 * `matchMedia('print').addListener(…)` in its constructor, so `new EditorView`
 * throws before the editor exists. `addListener` is the deprecated spelling and the
 * one CodeMirror uses.
 */
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, 'platform', {
    configurable: true,
    value: 'MacIntel',
  })
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      matches: false,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { EditorView, type Command, type Decoration, type DecorationSet } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { codeFolding, foldEffect, indentUnit } from '@codemirror/language'
import { MarkdownEditor, caretOnOpen } from '../MarkdownEditor'
import {
  continueIndent,
  indentListItem,
  outdentListItem,
  toggleMarker,
  deleteWikiLinkPair,
  wrapInSlot,
  wrapInWikiLink,
  wrapWith,
} from '../editorCommands'
import { localDateStamp, localTimeStamp } from '../clock'
import { collectionSource, slashSource, wikiLinkSource } from '../editorComplete'
import { foldMarkerFor, indentRange } from '../editorFold'
import {
  isLinkClick,
  linkTargetAt,
  livePreviewDecorations,
  taskAt,
  toggledTask,
} from '../editorPreview'

afterEach(cleanup)

/** A state with the markdown parser in it, and a selection to run a command over.
    `EditorState.create` parses a document this size to completion, so
    `syntaxTree` is the whole tree and not the first screen of one. */
function stateOf(doc: string, anchor: number, head = anchor, indentWidth = 2) {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage }), indentUnit.of(' '.repeat(indentWidth))],
  })
}

/** The inline style a decoration carries — the marker's box and a line's hang are
 *  per item, so the value is the assertion. */
function styleAt(state: EditorState, at: number): string {
  const iter = livePreviewDecorations(state, 0, state.doc.length).iter()
  while (iter.value) {
    if (iter.from === at) {
      const spec = iter.value.spec as { attributes?: Record<string, string> }
      const widget = iter.value.spec.widget as { box?: string } | undefined
      if (widget?.box) return `min-width:${widget.box}`
      if (spec.attributes?.style) return spec.attributes.style
    }
    iter.next()
  }
  return ''
}

/** Runs a command over a state and returns the document and selection it produced.
    The command's own `dispatch` is handed a `Transaction`, so its resulting state
    is read straight off it — no view, and nothing to lay out. */
function run(command: Command, state: EditorState) {
  let next = state
  const handled = command({
    state,
    dispatch: (transaction) => {
      next = (transaction as Transaction).state
    },
  } as Parameters<Command>[0])
  const { from, to } = next.selection.main
  return { handled, doc: next.doc.toString(), from, to }
}

// ---------------------------------------------------------------------------
// The formatting commands
// ---------------------------------------------------------------------------

describe('a formatting command', () => {
  it('wraps an unwrapped selection and leaves the selection over the word', () => {
    // `plan` in `the plan here`.
    const result = run(toggleMarker('**'), stateOf('the plan here', 4, 8))
    expect(result.doc).toBe('the **plan** here')
    expect([result.from, result.to]).toEqual([6, 10])
  })

  it('unwraps when the markers sit outside the selection', () => {
    // Exactly where ⌘B leaves the caret, so ⌘B twice is a no-op.
    const result = run(toggleMarker('**'), stateOf('the **plan** here', 6, 10))
    expect(result.doc).toBe('the plan here')
    expect([result.from, result.to]).toEqual([4, 8])
  })

  it('unwraps when the markers sit inside the selection', () => {
    // What dragging across `**plan**` by hand gives you.
    const result = run(toggleMarker('**'), stateOf('the **plan** here', 4, 12))
    expect(result.doc).toBe('the plan here')
    expect([result.from, result.to]).toEqual([4, 8])
  })

  it('gives an empty cursor a pair of markers with the caret between them', () => {
    const result = run(toggleMarker('**'), stateOf('the  here', 4))
    expect(result.doc).toBe('the **** here')
    expect([result.from, result.to]).toEqual([6, 6])
  })

  it('inserts italic and inline code syntax, not a style', () => {
    expect(run(toggleMarker('_'), stateOf('the plan here', 4, 8)).doc).toBe('the _plan_ here')
    expect(run(toggleMarker('`'), stateOf('the plan here', 4, 8)).doc).toBe('the `plan` here')
  })

  it('does not mistake a one-marker neighbour for a wrapped selection', () => {
    // `_plan_` with ⌘B: `_` is not `**`, so this wraps rather than stripping.
    expect(run(toggleMarker('**'), stateOf('the _plan_ here', 5, 9)).doc).toBe(
      'the _**plan**_ here'
    )
  })
})

// ---------------------------------------------------------------------------
// Live Preview
// ---------------------------------------------------------------------------

/**
 * Every decoration in the set as `class@from-to`.
 *
 * A hidden marker is a `Decoration.replace({})`, whose spec carries no class — the
 * absence is the discriminator. A replacing decoration that carries a *widget* is
 * named by the class that widget draws, less this editor's prefix: `bullet`,
 * `rule`. Ranges and classes only: nothing here is geometry.
 *
 * Sorted outermost-first at each position rather than left in `RangeSet` order,
 * which puts a replacing decoration ahead of a mark starting at the same offset.
 * That ordering is CodeMirror's business, not this editor's, and a test that
 * asserted it would break on a library detail while saying nothing about the
 * feature.
 */
function label(deco: Decoration): string {
  if (deco.spec.class) return deco.spec.class as string
  const widget = deco.spec.widget as { toDOM: () => HTMLElement } | undefined
  return widget ? widget.toDOM().className.replace('cm-md-', '') : 'hidden'
}

function spans(set: DecorationSet): string[] {
  const found: { from: number; to: number; label: string }[] = []
  const iter = set.iter()
  while (iter.value) {
    found.push({
      from: iter.from,
      to: iter.to,
      label: `${label(iter.value)}@${iter.from}-${iter.to}`,
    })
    iter.next()
  }
  found.sort((a, b) => a.from - b.from || b.to - a.to || a.label.localeCompare(b.label))
  return found.map((entry) => entry.label)
}

const all = (state: EditorState) => spans(livePreviewDecorations(state, 0, state.doc.length))

describe('Live Preview', () => {
  it('renders a bold run and hides its asterisks when the caret is elsewhere', () => {
    // `the **plan** here`, caret at 0 — outside the run.
    expect(all(stateOf('the **plan** here', 0))).toEqual([
      'cm-md-strong@4-12',
      'hidden@4-6',
      'hidden@10-12',
    ])
  })

  it('brings the asterisks back, dimmed, when the caret is inside the run', () => {
    // Caret between `pl` and `an`: the syntax must be there to be edited.
    expect(all(stateOf('the **plan** here', 8))).toEqual([
      'cm-md-strong@4-12',
      'cm-md-marker@4-6',
      'cm-md-marker@10-12',
    ])
  })

  it('counts the run’s own edges as inside, so the markers can be reached', () => {
    // Caret immediately before the opening `**`. A run whose syntax appears only
    // once the caret is past it is a run you cannot get into.
    expect(all(stateOf('the **plan** here', 4))).toContain('cm-md-marker@4-6')
  })

  it('reveals only the run the caret is in', () => {
    const state = stateOf('**one** and **two**', 3)
    expect(all(state)).toEqual([
      'cm-md-strong@0-7',
      'cm-md-marker@0-2',
      'cm-md-marker@5-7',
      'cm-md-strong@12-19',
      'hidden@12-14',
      'hidden@17-19',
    ])
  })

  /**
   * The third decoration is on the *line*, not the heading: it is what puts space
   * above one. A heading's own class is a mark over its text, and margin on an
   * inline box does nothing — so without a line decoration a heading sits exactly
   * one leading below the paragraph it interrupts.
   */
  it('hides a heading’s hash *and* the space after it', () => {
    // `# Head` — hiding `#` alone left every heading indented by one space.
    expect(all(stateOf('# Head\n\nbody', 9))).toEqual([
      'cm-md-h1@0-6',
      'hidden@0-2',
      'cm-md-heading-line@0-0',
    ])
  })

  it('scales a heading by its level', () => {
    expect(all(stateOf('### Third\n\nbody', 12))).toEqual([
      'cm-md-h3@0-9',
      'hidden@0-4',
      'cm-md-heading-line@0-0',
    ])
  })

  it('puts the space on the heading’s own line, wherever it is', () => {
    // Line three, so the decoration is at its start and not the document's.
    expect(all(stateOf('body\n\n## Later\n', 0))).toEqual([
      'cm-md-h2@6-14',
      'hidden@6-9',
      'cm-md-heading-line@6-6',
    ])
  })

  it('renders italic, inline code and strikethrough with their own markers', () => {
    expect(all(stateOf('_a_ `b` ~~c~~', 13))).toEqual([
      'cm-md-em@0-3',
      'hidden@0-1',
      'hidden@2-3',
      'cm-md-code@4-7',
      'hidden@4-5',
      'hidden@6-7',
      'cm-md-strike@8-13',
      'cm-md-marker@8-10',
      'cm-md-marker@11-13',
    ])
  })

  /**
   * Reveal is **per node**, not per line, and the nested case is where that shows.
   * A caret at the very start of `**_both_**` is inside the bold run and *not*
   * inside the italic one, so the asterisks come back while the underscores stay
   * hidden — the underscores appear as the caret moves into the italic. The
   * alternative, revealing every marker on the line, turns editing one word of a
   * dense line into a line that jumps.
   */
  it('nests, and reveals only the run the caret is actually in', () => {
    expect(all(stateOf('**_both_**', 0))).toEqual([
      'cm-md-strong@0-10',
      'cm-md-marker@0-2',
      'cm-md-em@2-8',
      'hidden@2-3',
      'hidden@7-8',
      'cm-md-marker@8-10',
    ])
    // Caret at 4, inside `both`: both pairs are reachable.
    expect(all(stateOf('**_both_**', 4))).toEqual([
      'cm-md-strong@0-10',
      'cm-md-marker@0-2',
      'cm-md-em@2-8',
      'cm-md-marker@2-3',
      'cm-md-marker@7-8',
      'cm-md-marker@8-10',
    ])
  })

  it('decorates nothing in a note with no syntax in it', () => {
    expect(all(stateOf('plain words, nothing to render\n', 0))).toEqual([])
  })

  /**
   * A list marker is the one piece of syntax that is *replaced* rather than hidden.
   * Hiding `- ` outright costs the item its bullet **and** its indent, so it reads
   * as a bare paragraph — which is what shipped first, and what the user saw.
   */
  /**
   * A bullet is *always* a bullet — unlike `**` or `_`, which reveal when the caret
   * is inside them. A list marker is not edited in place; you delete the item or
   * outdent it. Revealing it meant typing `- ` showed a hyphen for as long as the
   * caret stayed on that line, which is every moment you are writing the item.
   */
  it('stands a bullet in for the marker, caret on the line or not', () => {
    expect(all(stateOf('- see [[Pingbird]]\n', 0))).toEqual([
      'bullet@0-2',
      'cm-md-hang@0-0',
      'cm-md-link@6-18',
      'hidden@6-8',
      'hidden@16-18',
    ])
    // The caret at the end of the line is *on* the link, so its brackets are back
    // — but the bullet is still a bullet, which is the point of this one.
    expect(all(stateOf('- see [[Pingbird]]\n', 18))).toEqual([
      'bullet@0-2',
      'cm-md-hang@0-0',
      'cm-md-link@6-18',
    ])
  })

  /**
   * A number stays characters, and is *boxed* rather than replaced: a reader needs
   * it, and the caret has to be able to get inside to renumber the item. The box is
   * what puts its text on the same column a bullet's does.
   */
  it("boxes an ordered list's number without taking it away", () => {
    expect(all(stateOf('1. first\n', 8))).toEqual(['cm-md-number@0-3', 'cm-md-hang@0-0'])
  })

  /**
   * **A `#tag` is marked, and always.** `.cm-md-collection`'s property and for its
   * reason: the mark is what makes the span pressable, and a tag goes somewhere.
   * Nothing hides, because `#` *is* the tag — unlike a link's brackets, removing it
   * would leave a different word on the line.
   */
  it('marks a tag, with the caret in the line or out of it', () => {
    expect(all(stateOf('see #travel now\n', 0))).toEqual(['cm-md-tag@4-11'])
    // The caret on it changes nothing: there is no syntax to bring back.
    expect(all(stateOf('see #travel now\n', 6))).toEqual(['cm-md-tag@4-11'])
  })

  /** The guards, at the decoration level: a heading is not a tag, and neither is
   *  an anchor. `tags.test.ts` has the rest. */
  it('does not mark a heading or an anchor as a tag', () => {
    const tagged = (doc: string) => all(stateOf(doc, 0)).filter((one) => one.startsWith('cm-md-tag@'))
    expect(tagged('## Section\n')).toEqual([])
    expect(tagged('see https://example.invalid/a#b\n')).toEqual([])
    expect(tagged('see [[Areas/Plans#Roadmap]]\n')).toEqual([])
  })

  /**
   * **A task is Obsidian's parse, not GFM's.** GFM knows `[ ]` and `[x]` and gives
   * them a node; a vault written in Obsidian is full of `[-]`, `[>]` and `[/]`,
   * which that grammar reads as ordinary text. So the line is scanned, any single
   * character is a state, and one the app draws no glyph for is drawn as itself.
   */
  it('draws a checkbox in place of the bullet, and dims a done item', () => {
    // One marker per item: the box replaces `- [ ] ` whole, so the words still
    // land on the grid stop a plain bullet's would.
    expect(all(stateOf('- [ ] milk\n', 0))).toEqual(['task@0-6', 'cm-md-hang@0-0'])
    expect(all(stateOf('- [x] milk\n', 0))).toEqual([
      'task@0-6',
      'cm-md-hang@0-0',
      'cm-md-task-done@6-10',
    ])
    // A state with no glyph is still a task, and is not dimmed.
    expect(all(stateOf('- [>] milk\n', 0))).toEqual(['task@0-6', 'cm-md-hang@0-0'])
  })

  /**
   * **Never revealed.** A checkbox has to be pressable whether or not the caret is
   * in the line — `.cm-md-collection`'s property, for the same reason — and a box
   * that turned back into three characters when you clicked into the item would be
   * un-pressable exactly while it was being written.
   */
  it('keeps the box drawn with the caret in the line', () => {
    expect(all(stateOf('- [ ] milk\n', 8))).toEqual(['task@0-6', 'cm-md-hang@0-0'])
    expect(all(stateOf('- [ ] milk\n', 3))).toEqual(['task@0-6', 'cm-md-hang@0-0'])
  })

  /** An ordered item's number is content and stays, so the box takes no grid width
   *  of its own and the checkbox follows the number as a word would. */
  it('leaves an ordered item its number and boxes the task after it', () => {
    expect(all(stateOf('1. [ ] first\n', 0))).toEqual([
      'cm-md-number@0-3',
      'cm-md-hang@0-0',
      'task@3-7',
    ])
  })

  /** The lookahead for a space is what keeps these two from being tasks: one opens
   *  a wikilink, the other is a markdown link whose label is `x`. */
  it('is not a task when the brackets are a link', () => {
    const tasks = (doc: string) => all(stateOf(doc, 0)).filter((one) => one.startsWith('task@'))
    expect(tasks('- [[Note]]\n')).toEqual([])
    expect(tasks('- [x](url)\n')).toEqual([])
  })

  /** A press writes **one character**, the state between the brackets, and clears
   *  any state that is not open rather than cycling through them. */
  it('reads the state off the line and toggles it', () => {
    const at = (doc: string) => taskAt(stateOf(doc, 0), 0)
    expect(at('- [ ] milk\n')).toEqual({ from: 2, mark: ' ' })
    expect(at('- [x] milk\n')).toEqual({ from: 2, mark: 'x' })
    expect(at('  - [>] milk\n')).toEqual({ from: 4, mark: '>' })
    expect(at('- milk\n')).toBeNull()
    expect(toggledTask(' ')).toBe('x')
    expect(toggledTask('x')).toBe(' ')
    expect(toggledTask('>')).toBe(' ')
  })

  /**
   * **An item's level is the tree's answer, not a count of its spaces.**
   *
   * Markdown nests by content column — a child's marker sits two or three
   * characters past its parent's — and the grid steps by the indent setting, which
   * in the vault this was found in is six spaces. Counting spaces into steps
   * therefore drew a child at its parent's level (`floor(2 / 6) + 1`), and its text
   * landed 1.33 steps in. Measured in Chrome at those settings, before and after:
   * 1.00, 1.33, 1.67 steps against 1.00, 2.00, 3.00.
   *
   * The box makes up the difference, so the text lands on the step whatever the
   * document indents by.
   */
  /**
   * **Every indented line hangs, not only a list item.** Reported three times, and
   * the first two readings of it were wrong: it is about a line's *wrapped rows*,
   * not about separate lines. An indented line put its first row correctly in and
   * its second and third rows back at the edge of the reading pane, because the
   * hang was pushed only from the syntax walk's `ListItem` branch — and a journal's
   * detail lines are indented **prose**, which that branch never sees.
   *
   * Measured in Chrome at a 520px column, a six-space prose line long enough to
   * wrap: rows at 40.00 and 40.00 before, 40.00 and 62.08 after, where 62.08 is
   * 40 + 6 spaces. The wrapped row lands under the text.
   */
  it('hangs an indented prose line by the width of its own spaces', () => {
    const doc = '10:00 the entry\n      the detail under it\n'
    const at = doc.indexOf('      the detail')
    expect(styleAt(stateOf(doc, 0), at)).toBe('--hang: calc(6 * var(--space-w))')
    // The head of the block is not indented, so it has no hang at all.
    expect(styleAt(stateOf(doc, 0), 0)).toBe('')
  })

  /** A blank line and an unindented line are left alone: there is nothing to hang
   *  under, and a decoration per line is not free. */
  it('gives no hang to a line with no indent', () => {
    expect(styleAt(stateOf('plain line here\n', 0), 0)).toBe('')
    expect(styleAt(stateOf('\n\n', 0), 0)).toBe('')
  })

  /** One line, one `--hang`: a list item takes its depth from the tree and the
   *  sweep skips it, or the two would fight over the same line. */
  it('does not give a list line two hangs', () => {
    const doc = '  - two spaces in\n'
    expect(styleAt(stateOf(doc, 0), 0)).toBe('--hang: calc(1 * var(--indent-step))')
  })

  it('reads a nested item’s level off the tree, not off its spaces', () => {
    const doc = '- one\n  - two\n    - three\n'
    const wide = stateOf(doc, 0, 0, 6)
    // `--hang` is a **length**, because two kinds of line hang and they measure
    // differently: a list item by its markdown depth in steps, an indented prose
    // line by the width of the spaces it carries.
    expect(styleAt(wide, doc.indexOf('- one'))).toBe('--hang: calc(1 * var(--indent-step))')
    expect(styleAt(wide, doc.indexOf('  - two') + 2)).toBe(
      'min-width:max(0px, calc(2 * var(--indent-step) - 2 * var(--space-w)))'
    )
    // The line's hang is the level too, so a wrapped row starts under the text.
    expect(styleAt(wide, doc.indexOf('  - two'))).toBe('--hang: calc(2 * var(--indent-step))')
    expect(styleAt(wide, doc.indexOf('    - three'))).toBe(
      '--hang: calc(3 * var(--indent-step))'
    )

    // And the indent setting does not change any of it: the same document, a step
    // of two, and the same three levels.
    const tight = stateOf(doc, 0, 0, 2)
    expect(styleAt(tight, doc.indexOf('    - three'))).toBe(
      '--hang: calc(3 * var(--indent-step))'
    )
    expect(styleAt(tight, doc.indexOf('    - three') + 4)).toBe(
      'min-width:max(0px, calc(3 * var(--indent-step) - 4 * var(--space-w)))'
    )
  })

  /**
   * **A link reads as its name.**
   *
   * CommonMark reads `[[x]]` as plain text, so there is no node and no markers to
   * reveal — the scan does both. The brackets go while the caret is elsewhere and
   * are back the moment it lands, which is the bargain every other mark here makes,
   * and an alias is how a link gets a name: `[[Areas/Pingbird|Bird]]` shows `Bird`.
   */
  it('shows a wikilink’s name and hides its syntax', () => {
    // `[[` and `]]` hidden; `Pingbird` is the name.
    expect(all(stateOf('see [[Pingbird]]\n', 0))).toEqual([
      'cm-md-link@4-16',
      'hidden@4-6',
      'hidden@14-16',
    ])
    // With an alias, everything left of the pipe goes with the brackets.
    expect(all(stateOf('see [[Areas/Pingbird|Bird]]\n', 0))).toEqual([
      'cm-md-link@4-27',
      'hidden@4-21',
      'hidden@25-27',
    ])
    // The caret on it shows what it is made of, so it can be edited.
    expect(all(stateOf('see [[Areas/Pingbird|Bird]]\n', 10))).toEqual(['cm-md-link@4-27'])
  })

  /**
   * **A name is sometimes a fragment**, and `|!n` asks for the pages above it.
   *
   * `[[Entities/Cafes/Bean Street/Lakeside Arrival]]` reads as `Lakeside Arrival`, which does
   * not say whose; here the folder above it is a *page* and not a directory, so
   * what `!2` adds is the one page this one is under. The marker sits in the alias
   * slot and hides with the brackets, exactly as an alias does.
   */
  it('shows the last n names of a wikilink written |!n', () => {
    // `!2` hides `[[a/b/` at the front and `|!2]]` at the back: `c/d` shows.
    expect(all(stateOf('see [[a/b/c/d|!2]]\n', 0))).toEqual([
      'cm-md-link@4-18',
      'hidden@4-10',
      'hidden@13-18',
    ])
    // `!` with no number shows every name, which is the pre-alias reading, asked for.
    expect(all(stateOf('see [[a/b/c/d|!]]\n', 0))).toEqual([
      'cm-md-link@4-17',
      'hidden@4-6',
      'hidden@13-17',
    ])
    // A count past what the path holds clamps to the path rather than failing.
    expect(all(stateOf('see [[a/b|!9]]\n', 0))).toEqual([
      'cm-md-link@4-14',
      'hidden@4-6',
      'hidden@9-14',
    ])
    // The caret on it brings the marker back, like every other piece of syntax.
    expect(all(stateOf('see [[a/b/c/d|!2]]\n', 10))).toEqual(['cm-md-link@4-18'])
  })

  it('shows a markdown link’s label and hides the brackets and the URL', () => {
    expect(all(stateOf('see [Roadmap](Roadmap.md)\n', 0))).toEqual([
      'cm-md-link@4-25',
      'hidden@4-5',
      'hidden@12-13',
      'hidden@13-14',
      'hidden@14-24',
      'hidden@24-25',
    ])
    expect(all(stateOf('see [Roadmap](Roadmap.md)\n', 6))).toEqual(['cm-md-link@4-25'])
  })

  /**
   * **A bare URL is a link.** GFM parses one as a top-level `URL` node — an email
   * address too — and nothing marked it, so a pasted line of links was plain text
   * you could not click. Reported from the running app, in a journal full of them.
   */
  it('marks a bare URL, an autolink and an email', () => {
    expect(all(stateOf('see https://example.invalid/a here\n', 0))).toEqual(['cm-md-link@4-29'])
    // `<url>`: the angle brackets are syntax, the URL is the name.
    expect(all(stateOf('see <https://example.invalid/a> here\n', 0))).toEqual([
      'cm-md-link@4-31',
      'hidden@4-5',
      'hidden@30-31',
    ])
    expect(all(stateOf('mail name@example.invalid now\n', 0))).toEqual(['cm-md-link@5-25'])
  })

  /** Beyond the four inline nodes this change set out to render — tested here
      rather than left to ship unverified. */
  it('renders a blockquote and hides its `>` when the caret is out of it', () => {
    expect(all(stateOf('> quoted\n\nbody', 12))).toEqual(['cm-md-quote@0-8', 'hidden@0-2'])
    expect(all(stateOf('> quoted\n\nbody', 3))).toEqual(['cm-md-quote@0-8', 'cm-md-marker@0-2'])
  })

  it('decorates only the span it is given', () => {
    const state = stateOf('**one**\n\n**two**\n', 0)
    expect(spans(livePreviewDecorations(state, 9, 16))).toEqual([
      'cm-md-strong@9-16',
      'hidden@9-11',
      'hidden@14-16',
    ])
  })
})

// ---------------------------------------------------------------------------
// The mount, and the one thing it must never do
// ---------------------------------------------------------------------------

/** The live view behind a rendered `MarkdownEditor`. `findFromDOM` is CodeMirror's
    own way in, so the test reaches the editor the way the app's DOM does. */
function viewOf(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)
  expect(view).toBeTruthy()
  return view!
}

/**
 * **Tab nests a list item by markdown's rule, not by the indent setting.**
 *
 * Reported from the running app: "pressing enter from a bullet line moves the
 * cursor at a random indent level". The vault's `indentWidth` is 6, and the
 * general Tab inserts one indent width — so a child's marker landed six spaces
 * past a parent whose content column was two. CommonMark allows at most three:
 * past that the line is an indented code block *inside* the item, so it lost its
 * bullet, and Enter from it continued no list and copied the whitespace instead.
 *
 * A child goes at the previous item's content column, which is the one depth that
 * stays a list — and is the same answer at every indent width.
 */
/**
 * **Enter keeps the indent of the line you are on**, which markdown's own Enter
 * does not: it answers for the block the line is *in*.
 *
 * Reported from the running app, and read out of the note's bytes: line 17 six
 * spaces, line 18 three. An ordered list ran above, so the parser had that line
 * inside item `7.`, whose content column is three — so an indent the user typed
 * as six came back as three, and the caret landed at a level nobody chose.
 */
describe('Enter on an indented line', () => {
  /** The note that reported this, in the shape that produced it: a list, a lazy
   *  continuation of its last item, and an indented line under that. */
  const note = '7. https://example.invalid/profile\n12:30 to 14:00 Working on it\n      Identifying a list'

  it('keeps the line’s own spaces, not the enclosing item’s column', () => {
    const after = run(continueIndent, stateOf(note, note.length, note.length, 6))
    expect(after.handled).toBe(true)
    expect(after.doc.split('\n').pop()).toBe('      ')
    // Through the mounted editor, where markdown's Enter is what it has to beat.
    const { container } = render(
      <MarkdownEditor initialMarkdown={note} onChange={() => {}} indentWidth={6} />
    )
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    view.dispatch({ selection: { anchor: note.length } })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(view.state.doc.toString().split('\n').pop()).toBe('      ')
  })

  it('splits a line mid-text and carries the indent down', () => {
    const doc = '- one\n      note text'
    const at = doc.indexOf('text')
    const after = run(continueIndent, stateOf(doc, at, at, 6))
    expect(after.doc).toBe('- one\n      note \n      text')
  })

  it('leaves a list item’s own line to markdown, which continues the marker', () => {
    expect(run(continueIndent, stateOf('- one', 5, 5, 6)).handled).toBe(false)
    expect(run(continueIndent, stateOf('  - one', 7, 7, 6)).handled).toBe(false)
    expect(run(continueIndent, stateOf('  1. one', 8, 8, 6)).handled).toBe(false)
    // And an empty item, which markdown ends rather than continues.
    expect(run(continueIndent, stateOf('- ', 2, 2, 6)).handled).toBe(false)
  })

  it('declines with nothing in front of the line, so a quote still continues', () => {
    expect(run(continueIndent, stateOf('> quoted', 8, 8, 6)).handled).toBe(false)
    expect(run(continueIndent, stateOf('plain', 5, 5, 6)).handled).toBe(false)
  })

  it('keeps a blank indented line’s indent, rather than dropping to the margin', () => {
    const after = run(continueIndent, stateOf('      ', 6, 6, 6))
    expect(after.doc).toBe('      \n      ')
  })
})

describe('Tab inside a list', () => {
  const nested = (doc: string, at: number, width: number) =>
    run(indentListItem, stateOf(doc, at, at, width))

  /**
   * **Tab moves the whole block, not the line the caret is on.** Reported as only
   * the first line of a block indenting. Both ways of asking for more than one line
   * were broken, because the commands read `selection.main.head` and nothing else.
   */
  describe('over more than one line', () => {
    it('moves every line of a selection, keeping the shape inside it', () => {
      const doc = '- one\n- two\n- three\n'
      const from = doc.indexOf('- two')
      const to = doc.indexOf('- three') + '- three'.length
      const after = run(indentListItem, stateOf(doc, from, to, 2))
      expect(after.handled).toBe(true)
      // Measured before the fix: only `- three` moved, because the head was on it.
      expect(after.doc).toBe('- one\n  - two\n  - three\n')
    })

    /** A delta and not a column, so the nesting *inside* the block survives. */
    it('carries a nested child along with the item it belongs to', () => {
      const doc = '- one\n- parent\n  - child\n'
      const at = doc.indexOf('- parent') + 3
      expect(nested(doc, at, 2).doc).toBe('- one\n  - parent\n    - child\n')
    })

    /** The run is `collectLines`' rule: deeper than the first, and a blank line in
     *  the middle does not end it. */
    it('does not let a blank line inside the block end it', () => {
      const doc = '- one\n- parent\n  - a\n\n  - b\n- after\n'
      const at = doc.indexOf('- parent') + 3
      expect(nested(doc, at, 2).doc).toBe('- one\n  - parent\n    - a\n\n    - b\n- after\n')
    })

    /** Shift-Tab clamps each line at zero, so outdenting a block whose first line
     *  has room but whose child does not cannot push text off the front. */
    it('outdents a block without pushing a child past the margin', () => {
      const doc = '- one\n  - parent\n    - child\n'
      const at = doc.indexOf('- parent') + 3
      const after = run(outdentListItem, stateOf(doc, at, at, 2))
      expect(after.doc).toBe('- one\n- parent\n  - child\n')
    })
  })

  it('nests at the item above’s content column, whatever the indent width is', () => {
    const doc = '- one\n- two\n'
    for (const width of [2, 4, 6, 8]) {
      const after = nested(doc, doc.indexOf('- two') + 5, width)
      expect(after.handled).toBe(true)
      expect(after.doc).toBe('- one\n  - two\n')
    }
  })

  it('nests an ordered item by its own marker’s width', () => {
    const doc = '1. one\n2. two\n'
    const after = nested(doc, doc.length - 1, 6)
    expect(after.doc).toBe('1. one\n   2. two\n')
  })

  it('goes one level at a time, since a list cannot skip one', () => {
    const doc = '- one\n  - two\n'
    // `two` is already the child of `one`; there is nothing deeper to be.
    expect(nested(doc, doc.length - 1, 6).handled).toBe(false)
  })

  it('declines on a line that is not an item, so Tab still indents', () => {
    expect(nested('plain prose\n', 5, 6).handled).toBe(false)
    // The first item of a list has nothing above it to nest under.
    expect(nested('- one\n', 5, 6).handled).toBe(false)
  })

  /** The whole gesture, through the editor the app mounts: nest an item, type it,
   *  and press Enter. The bullet has to still be a bullet on the next line. */
  it('keeps a nested item a list item, so Enter continues it', () => {
    const doc = '- one\n- two'
    const { container } = render(
      <MarkdownEditor initialMarkdown={doc} onChange={() => {}} indentWidth={6} />
    )
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    view.dispatch({ selection: { anchor: doc.length } })
    fireEvent.keyDown(view.contentDOM, { key: 'Tab' })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(view.state.doc.toString()).toBe('- one\n  - two\n  - ')
    // Six spaces and no marker is what this produced before: the item had become
    // an indented code block, and Enter copied its whitespace.
    expect(view.state.doc.toString()).not.toContain('      ')
  })

  it('backs out to the level of the item it sits under', () => {
    const doc = '- one\n      - two\n'
    const after = run(outdentListItem, stateOf(doc, doc.length - 1, doc.length - 1, 6))
    expect(after.handled).toBe(true)
    expect(after.doc).toBe('- one\n- two\n')
    // And at the margin there is nowhere to go.
    expect(run(outdentListItem, stateOf('- one\n', 5, 5, 6)).handled).toBe(false)
  })
})

/**
 * **Pressing a `--keyword` opens its collection.**
 *
 * A collection is a page rather than a file, and the keyword in a line is the only
 * place in a note that names one — so the press is the shortest way to ask what
 * else in the vault says that.
 *
 * Mounted, and with a **real `mousedown` on the real span**, because that is the
 * only thing that would have caught the bug this shares its handler with: a `click`
 * needs the press and the release on the same element, and pressing a marked span
 * puts the caret in the line, which redraws it. A test calling the handler directly
 * passed throughout while the app took two presses.
 */
describe('pressing a keyword', () => {
  const pressed = (doc: string, selector: string) => {
    const opened: string[] = []
    const links: string[] = []
    const { container } = render(
      <MarkdownEditor
        initialMarkdown={doc}
        onChange={() => {}}
        onOpenCollection={(keyword) => opened.push(keyword)}
        onOpenLink={(target) => links.push(target)}
      />
    )
    const span = container.querySelector(selector)
    expect(span, `no ${selector} in the rendered line`).toBeTruthy()
    fireEvent.mouseDown(span as Element, { button: 0 })
    return { opened, links }
  }

  it('opens the collection the keyword names', () => {
    const { opened, links } = pressed('09:42 --expense on [[Corner Shop]]\n', '.cm-md-collection')
    expect(opened).toEqual(['expense'])
    expect(links).toEqual([])
  })

  /** The keyword sits wherever the sentence puts it, and the mark is on it either
   *  way — including on the line the caret is already in, where the syntax around
   *  it is revealed and every other span on the line has been replaced. */
  it('opens it from the middle of a sentence, caret on the line or not', () => {
    expect(
      pressed('10:00 - Making --feature-updates for [[Journeys]]\n', '.cm-md-collection').opened
    ).toEqual(['feature-updates'])
  })

  /** A link on the same line is still a link: two marks, two destinations. */
  it('leaves a link on the same line to the link', () => {
    const { opened, links } = pressed('09:42 --expense on [[Corner Shop]]\n', '.cm-md-link')
    expect(links).toEqual(['Corner Shop'])
    expect(opened).toEqual([])
  })

  /** Ordinary prose puts the caret where it was pressed, as it always did. */
  it('does nothing for a press on the words around it', () => {
    const opened: string[] = []
    const { container } = render(
      <MarkdownEditor
        initialMarkdown={'09:42 --expense on [[Corner Shop]]\n'}
        onChange={() => {}}
        onOpenCollection={(keyword) => opened.push(keyword)}
      />
    )
    fireEvent.mouseDown(container.querySelector('.cm-line') as Element, { button: 0 })
    expect(opened).toEqual([])
  })
})

describe('the mounted editor', () => {
  /**
   * **The caret starts under the properties, and is visible.**
   *
   * At offset 0 it sits between the opening `---` and the first key, so the first
   * thing typed in a note that carries properties edits one of them. And a caret
   * placed in an unfocused editor is not drawn at all — CodeMirror only draws it
   * for the focused one — so placing it and taking the keyboard are one answer.
   */
  it('starts the caret on the line under a note’s properties', () => {
    const doc = '---\nicon: compass\ndate: 2026-09-12\n---\n\n# Reading\n'
    const { container } = render(<MarkdownEditor initialMarkdown={doc} onChange={() => {}} />)
    const view = viewOf(container)
    // The block runs to the newline after its closing `---`; the caret is past it.
    expect(view.state.selection.main.head).toBe(doc.indexOf('---\n\n') + 4)
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5)
    expect(view.hasFocus).toBe(true)
  })

  /**
   * **Tab, through the keymap rather than by a direct call — which is the coverage
   * that was missing.** The block-indent tests further up call `indentListItem`, so
   * they could never catch a block that never *reaches* that command: a journal
   * entry carries no list marker, so it declined and the general Tab moved the
   * caret's line alone. Reported twice, the second time after the list half was
   * already fixed. A command tested only by direct call is a binding nobody tested.
   */
  describe('Tab over a block', () => {
    const tabbed = (doc: string, at: number, head = at, shift = false) => {
      const { container } = render(
        <MarkdownEditor initialMarkdown={doc} onChange={() => {}} indentWidth={2} />
      )
      const view = viewOf(container)
      view.dispatch({ selection: { anchor: at, head } })
      fireEvent.keyDown(view.contentDOM, { key: 'Tab', shiftKey: shift })
      return view.state.doc.toString()
    }

    /** A journal entry: a clock line with its detail indented under it. The whole
     *  block moves by one indent width, and the nesting inside it survives. */
    it('moves a prose block and the run nested under it', () => {
      const doc = '10:00 Making the updates\n      more detail\n      and more\n'
      expect(tabbed(doc, 8)).toBe(
        '  10:00 Making the updates\n        more detail\n        and more\n'
      )
    })

    /** A line with nothing under it is an ordinary line and the general Tab's. */
    it('leaves a line with no run to the general Tab', () => {
      expect(tabbed('alpha\nbeta\n', 2)).toBe('  alpha\nbeta\n')
    })

    /** A selection is `indentMore`'s, which already moves every line it is given. */
    it('indents every line of a selection', () => {
      const doc = 'alpha\nbeta\ngamma\n'
      expect(tabbed(doc, 0, doc.indexOf('gamma') + 5)).toBe('  alpha\n  beta\n  gamma\n')
    })

    /** And the list halves still reach their own command through the same key. */
    it('still nests a list item and carries its child', () => {
      const doc = '- one\n- parent\n  - child\n'
      expect(tabbed(doc, doc.indexOf('- parent') + 4)).toBe('- one\n  - parent\n    - child\n')
    })

    it('still moves every selected list item', () => {
      const doc = '- one\n- two\n- three\n'
      expect(tabbed(doc, doc.indexOf('- two'), doc.indexOf('- three') + 7)).toBe(
        '- one\n  - two\n  - three\n'
      )
    })

    /** Shift-Tab is the same question backwards, and clamps at the margin. */
    it('outdents a prose block without pushing its run past the margin', () => {
      const doc = '  10:00 Making the updates\n    more detail\n'
      expect(tabbed(doc, 10, 10, true)).toBe('10:00 Making the updates\n  more detail\n')
    })
  })

  /**
   * **A press checks the box, and `mousedown` is the whole of why.** The same trap
   * following a link fell into, and closer to the surface here: the toggle changes
   * the document, the decoration is rebuilt, and the element that was pressed is
   * gone before the button comes back up — so no `click` is ever generated. The
   * release below lands on a different node, which is the point.
   */
  it('checks and unchecks a task on the press', () => {
    const typed: string[] = []
    const { container } = render(
      <MarkdownEditor initialMarkdown={'- [ ] milk\n'} onChange={(text) => typed.push(text)} />
    )
    const view = viewOf(container)
    const box = () => container.querySelector('.cm-md-task') as HTMLElement
    const pressed = box()

    fireEvent.mouseDown(pressed, { button: 0, detail: 1 })
    expect(view.state.doc.toString()).toBe('- [x] milk\n')
    expect(box()).not.toBe(pressed)
    fireEvent.mouseUp(pressed, { button: 0, detail: 1 })

    fireEvent.mouseDown(box(), { button: 0, detail: 1 })
    expect(view.state.doc.toString()).toBe('- [ ] milk\n')
    // The note is saved by the same handler every keystroke goes through.
    expect(typed.at(-1)).toBe('- [ ] milk\n')
  })

  /**
   * Enter continues a task list, and that comes free: `markdownKeymap` is spread
   * into the one array that is the whole precedence here, and GFM's own
   * continuation writes a fresh **unchecked** box under a checked one. Pinned
   * because `addKeymap: false` means this binding is ours to keep.
   */
  it('continues a task list on Enter, unchecked', () => {
    const doc = '- [x] milk\n'
    const { container } = render(<MarkdownEditor initialMarkdown={doc} onChange={() => {}} />)
    const view = viewOf(container)
    view.dispatch({ selection: { anchor: doc.length - 1 } })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(view.state.doc.toString()).toBe('- [x] milk\n- [ ] \n')
  })

  /** A state the app draws no glyph for is still a task, and a press **clears** it
   *  rather than cycling: "check, then uncheck" is the whole of the gesture. */
  it('clears an Obsidian state that is not a tick', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown={'- [>] forwarded\n'} onChange={() => {}} />
    )
    const view = viewOf(container)
    fireEvent.mouseDown(container.querySelector('.cm-md-task') as HTMLElement, {
      button: 0,
      detail: 1,
    })
    expect(view.state.doc.toString()).toBe('- [ ] forwarded\n')
  })

  /** Only a plain left press: the right button is the menu's and a modifier is the
   *  platform's, exactly as for a link. */
  it('leaves a task alone on the other buttons and the modifiers', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown={'- [ ] milk\n'} onChange={() => {}} />
    )
    const view = viewOf(container)
    const box = container.querySelector('.cm-md-task') as HTMLElement
    fireEvent.mouseDown(box, { button: 2, detail: 1 })
    fireEvent.mouseDown(box, { button: 0, detail: 1, metaKey: true })
    expect(view.state.doc.toString()).toBe('- [ ] milk\n')
  })

  /**
   * Reported from the running app: a double click on a row renamed for a moment
   * and then gave up. The click under it opened the note, the note arrived a read
   * later, and this editor's mount took the keyboard off the rename field — which
   * commits on blur. So the file arriving does not take a keyboard someone else is
   * typing with.
   */
  it('leaves the keyboard where it is when a field has it', () => {
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()

    const { container } = render(<MarkdownEditor initialMarkdown={'# Reading\n'} onChange={() => {}} />)
    expect(document.activeElement).toBe(field)
    expect(viewOf(container).hasFocus).toBe(false)
    field.remove()
  })

  /**
   * Reported from the running app: a new action file is created as `# owner` and
   * nothing else, and opening it showed the `#` — because the caret was on that
   * line and this editor reveals the syntax the caret is in.
   */
  it('starts the caret under the title as well', () => {
    expect(caretOnOpen('# Reading\n\nthe plan\n')).toBe(10)
    // With a blank line after the block the caret lands *on* it, and the title
    // below keeps its `#` hidden, which is the same outcome by a shorter route.
    expect(caretOnOpen('---\nicon: x\n---\n\n# Reading\nbody\n')).toBe(16)
    // No blank line, so the title is the first thing past the block and is skipped.
    expect(caretOnOpen('---\nicon: x\n---\n# Reading\nbody\n')).toBe(26)
    // A title and nothing else: the end of the note, which is where typing goes.
    expect(caretOnOpen('# owner\n')).toBe(8)
    expect(caretOnOpen('# owner')).toBe(7)
  })

  it('leaves a heading further down alone, since that is a section', () => {
    // The caret belongs at the top of the body; a heading below is not a title.
    expect(caretOnOpen('some text\n\n# Later\n')).toBe(0)
  })

  it('starts at the top of a note that has neither', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown={'the plan\n\nand the rest\n'} onChange={() => {}} />
    )
    expect(viewOf(container).state.selection.main.head).toBe(0)
  })

  // Nothing is typed by placing a caret: the note on disk is untouched, which is
  // what `openNote.test.tsx` proves against the bytes.
  it('does not fire its change handler for placing the caret', () => {
    const onChange = vi.fn()
    render(<MarkdownEditor initialMarkdown={'---\nicon: x\n---\n\nbody\n'} onChange={onChange} />)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('comes up over the note’s text, editable and named', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown={'# Roadmap\n'} onChange={() => {}} />
    )
    const content = container.querySelector('.cm-content') as HTMLElement
    expect(content.getAttribute('contenteditable')).toBe('true')
    expect(content.getAttribute('aria-label')).toBe('Markdown source')
    expect(viewOf(container).state.doc.toString()).toBe('# Roadmap\n')
  })

  /**
   * Opening a note must not write to it — the unit half of what
   * `openNote.test.tsx` proves against the disk. A *stronger* guarantee than a
   * guard: there is nothing here to normalise the document on mount, and
   * CodeMirror's update listener does not run for the state the view was created
   * with. So the assertion is simply that nothing was called.
   */
  it('does not fire its change handler on mount', () => {
    const changed = vi.fn()
    render(<MarkdownEditor initialMarkdown={'- shipped the tree\n- reviewed it\n'} onChange={changed} />)
    expect(changed).not.toHaveBeenCalled()
  })

  it('fires synchronously, with the whole document, on a change', () => {
    const changed = vi.fn()
    const { container } = render(<MarkdownEditor initialMarkdown="one" onChange={changed} />)
    const view = viewOf(container)

    view.dispatch({ changes: { from: 3, insert: ' two' } })

    // Synchronous: no timer is advanced and no `waitFor` is needed. Crepe's
    // 200ms debounce loses the last keystrokes when the pane unmounts inside the
    // window; there is no window here to lose them in.
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenLastCalledWith('one two')
  })

  /**
   * **A file's line endings are its own.** CodeMirror splits on `\r\n`, `\r` and
   * `\n` alike and joins with `\n`, so the first keystroke in a note written on
   * Windows, or a CSV an export left behind, rewrote every line ending in it.
   */
  it('keeps CRLF line endings through an edit and a new line', () => {
    const changed = vi.fn()
    const { container } = render(
      <MarkdownEditor initialMarkdown={'one\r\ntwo\r\n'} onChange={changed} />
    )
    const view = viewOf(container)
    view.dispatch({ changes: { from: 3, insert: '!' } })
    expect(changed).toHaveBeenLastCalledWith('one!\r\ntwo\r\n')
    view.dispatch({ selection: { anchor: view.state.doc.line(2).to } })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(changed).toHaveBeenLastCalledWith('one!\r\ntwo\r\n\r\n')
  })

  it('keeps the stray ending of a mixed file as it was written', () => {
    const changed = vi.fn()
    const { container } = render(
      <MarkdownEditor initialMarkdown={'a\nb\r\nc\nd\n'} onChange={changed} />
    )
    viewOf(container).dispatch({ changes: { from: 0, insert: '-' } })
    expect(changed).toHaveBeenLastCalledWith('-a\nb\r\nc\nd\n')
  })

  // The caret is worked out in the file's characters, where `\r\n` is two; in the
  // document a line break is one, so each break above it pushed it one further in.
  it('opens a CRLF note below its properties, where an LF one opens', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown={'---\r\nicon: x\r\n---\r\n\r\nbody\r\n'} onChange={() => {}} />
    )
    const { state } = viewOf(container)
    expect(state.selection.main.head).toBe(state.doc.line(4).from)
  })

  it('does not fire for a selection move', () => {
    const changed = vi.fn()
    const { container } = render(<MarkdownEditor initialMarkdown="one two" onChange={changed} />)
    viewOf(container).dispatch({ selection: { anchor: 4 } })
    expect(changed).not.toHaveBeenCalled()
  })

  it('inserts the time on its combo, and leaves the caret past it', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown="" onChange={() => {}} insertTimeCombo="mod+shift+t" />
    )
    const view = viewOf(container)

    fireEvent.keyDown(view.contentDOM, { key: 'T', metaKey: true, shiftKey: true })

    const text = view.state.doc.toString()
    // The trailing space is part of it: without one, the first character typed
    // after the stamp stops it being a stamp.
    expect(text).toMatch(/^\d{2}:\d{2} $/)
    // Past all of it. The caret used to be mapped to the front of the insertion,
    // so the next keystroke landed in front of the time.
    expect(view.state.selection.main.head).toBe(text.length)
  })

  it('bolds the selection on ⌘B, through the keymap', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown="the plan here" onChange={() => {}} />
    )
    const view = viewOf(container)
    view.dispatch({ selection: { anchor: 4, head: 8 } })

    fireEvent.keyDown(view.contentDOM, { key: 'b', metaKey: true })

    expect(view.state.doc.toString()).toBe('the **plan** here')
  })

  it('takes the markers back out on ⌘Z, in one undo', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown="the plan here" onChange={() => {}} />
    )
    const view = viewOf(container)
    view.dispatch({ selection: { anchor: 4, head: 8 } })
    fireEvent.keyDown(view.contentDOM, { key: 'b', metaKey: true })
    expect(view.state.doc.toString()).toBe('the **plan** here')

    fireEvent.keyDown(view.contentDOM, { key: 'z', metaKey: true })

    expect(view.state.doc.toString()).toBe('the plan here')
  })

  /**
   * The feature, end to end, asserted on the rendered text rather than on a
   * decoration range — which is what makes it worth having beside the pure cases:
   * it covers the `ViewPlugin` and its recompute-on-selection, the two pieces the
   * pure function cannot reach.
   *
   * `textContent` and not a measurement: a replaced range is simply absent from the
   * DOM, so this is document state. Whether it takes no *width* is geometry, and
   * jsdom cannot say.
   */
  it('hides the syntax in the DOM, and brings it back where the caret goes', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown={'# Head\n\nthe **plan** here\n'} onChange={() => {}} />
    )
    const view = viewOf(container)
    const shown = () => container.querySelector('.cm-content')!.textContent

    // The caret opens on the line *under* the title, so the heading is rendered —
    // its `# ` hidden — and so is the bold run further down.
    expect(shown()).toBe('Headthe plan here')

    // Into the heading: its `# ` is there to be edited, and comes back.
    view.dispatch({ selection: { anchor: 1 } })
    expect(shown()).toBe('# Headthe plan here')

    // Into the bold run. The heading closes up behind the caret and the asterisks
    // appear: syntax you can put a caret in, which is the whole point of the
    // editor being the file's own text.
    view.dispatch({ selection: { anchor: 14 } })
    expect(shown()).toBe('Headthe **plan** here')

    // Rendered, not just revealed: the run carries its class and the markers carry
    // theirs, so the asterisks are dimmed rather than bold.
    const strong = container.querySelector('.cm-md-strong')!
    expect(strong.textContent).toBe('**plan**')
    expect(strong.querySelectorAll('.cm-md-marker').length).toBe(2)
  })

  /**
   * Added because a mutation survived: dropping `docChanged` from the plugin's
   * update condition left every other test green. Typing moves the caret, so the
   * selection check covers it — but an edit landing *after* the caret does not move
   * it, and the note then renders as it was before the edit.
   */
  it('renders syntax that arrived from an edit which did not move the caret', () => {
    const { container } = render(<MarkdownEditor initialMarkdown="x" onChange={() => {}} />)
    const view = viewOf(container)
    const shown = () => container.querySelector('.cm-content')!.textContent

    // The caret is at 0 and stays there: the insert is entirely after it.
    view.dispatch({ changes: { from: 1, insert: '\n\n**bold**' } })

    expect(view.state.selection.main.head).toBe(0)
    expect(shown()).toBe('xbold')
  })

  it('inserts italic on ⌘I and inline code on ⌘E', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown="the plan here" onChange={() => {}} />
    )
    const view = viewOf(container)
    view.dispatch({ selection: { anchor: 4, head: 8 } })
    fireEvent.keyDown(view.contentDOM, { key: 'i', metaKey: true })
    // A single `*`: one asterisk is italic, two are bold, so ⌘I and the `*` key
    // now write the same marker.
    expect(view.state.doc.toString()).toBe('the *plan* here')

    view.dispatch({ selection: { anchor: 5, head: 9 } })
    fireEvent.keyDown(view.contentDOM, { key: 'e', metaKey: true })
    expect(view.state.doc.toString()).toBe('the *`plan`* here')
  })
})

// ---------------------------------------------------------------------------
// `[` over a selection, and the `[[` picker
// ---------------------------------------------------------------------------

const note = (path: string) => ({
  path,
  absolutePath: `/v/${path}`,
  name: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
})
const NOTES = [note('Roadmap.md'), note('Notes/Reading list.md'), note('Areas/Health.md')]

describe('a URL inside a slot', () => {
  /** Markdown reads `<<https://…>>` as `<` + an Autolink + `>`, which made the
   *  slot's inner brackets the link's own. The slot wins: the link is the value. */
  it('is the slot’s value, with neither bracket hidden as the link’s', () => {
    const found = all(stateOf('link::<<https://x.test/a>>\n\nelsewhere', 30))
    expect(found).toContain('cm-md-link@8-24')
    expect(found.filter((one) => one.startsWith('hidden@'))).toEqual([])
    expect(found.some((one) => one.startsWith('cm-md-link@7-'))).toBe(false)
  })
})

describe('`<` over a selection', () => {
  it('makes it a slot in one press, and keeps the selection over the value', () => {
    const out = run(wrapInSlot, stateOf('spent 480 today', 6, 9))
    expect(out.handled).toBe(true)
    expect(out.doc).toBe('spent <<480>> today')
    expect([out.from, out.to]).toEqual([8, 11])
  })

  it('declines with nothing selected, so a plain `<` still types', () => {
    expect(run(wrapInSlot, stateOf('a < b', 2)).handled).toBe(false)
  })
})

describe('Backspace between the brackets', () => {
  /** The second `[` writes `[]]` in one keystroke; one Backspace takes it back.
   *  Without this the `[[` went and the `]]` stayed in the sentence. */
  it('takes all four, and leaves the rest of the line', () => {
    const out = run(deleteWikiLinkPair, stateOf('see [[]] here', 6))
    expect(out.handled).toBe(true)
    expect(out.doc).toBe('see  here')
    expect([out.from, out.to]).toEqual([4, 4])
  })

  it('declines with a word between them, or a selection, or one bracket', () => {
    // `[[note|]]` — an ordinary Backspace on the `e`.
    expect(run(deleteWikiLinkPair, stateOf('see [[note]] here', 10)).handled).toBe(false)
    // Something selected is a delete of that.
    expect(run(deleteWikiLinkPair, stateOf('see [[]] here', 6, 7)).handled).toBe(false)
    // A single pair is punctuation the app never wrote.
    expect(run(deleteWikiLinkPair, stateOf('see [] here', 5)).handled).toBe(false)
    // And the head of a line has nothing behind it.
    expect(run(deleteWikiLinkPair, stateOf('[[]]', 0)).handled).toBe(false)
  })
})

describe('`[` over a selection', () => {
  it('wraps once and keeps the selection, so a second press can see it', () => {
    // `plan` in `the plan here`. One bracket is not a wikilink — Obsidian takes two.
    const out = run(wrapInWikiLink, stateOf('the plan here', 4, 8))
    expect(out.handled).toBe(true)
    expect(out.doc).toBe('the [plan] here')
    // Still over the word, which is what lets the next press complete the pair.
    expect([out.from, out.to]).toEqual([5, 9])
  })

  it('completes the pair on the second press, caret inside for the picker', () => {
    // `plan` selected inside `the [plan] here`, as the first press leaves it.
    const out = run(wrapInWikiLink, stateOf('the [plan] here', 5, 9))
    expect(out.doc).toBe('the [[plan]] here')
    // Right after the word, so the `[[` source reads `[[plan`.
    expect([out.from, out.to]).toEqual([10, 10])
  })

  it('declines on the first `[`, so a plain bracket still types', () => {
    // A bracket is ordinary punctuation until it is doubled.
    expect(run(wrapInWikiLink, stateOf('the plan here', 4)).handled).toBe(false)
  })

  it('closes the pair on the second `[`, caret between the four', () => {
    // `see [` with the caret at the end: the keystroke that makes it `[[`.
    const out = run(wrapInWikiLink, stateOf('see [', 5))
    expect(out.handled).toBe(true)
    expect(out.doc).toBe('see [[]]')
    // Between them, which is what the `[[` source reads — the picker opens here.
    expect([out.from, out.to]).toEqual([6, 6])
  })
})

describe('the `[[` picker', () => {
  const complete = (doc: string, at: number, notes = NOTES) => {
    const state = stateOf(doc, at)
    return wikiLinkSource(() => notes)({
      state,
      pos: at,
      explicit: false,
      matchBefore: (expr: RegExp) => {
        const line = state.doc.lineAt(at)
        const text = line.text.slice(0, at - line.from)
        const found = new RegExp(`(?:${expr.source})$`).exec(text)
        return found ? { from: at - found[0].length, to: at, text: found[0] } : null
      },
    } as never)
  }

  it('offers every note on a bare `[[`, and filters as the name is typed', () => {
    // Tree order on an empty query, which is `matchNotes`' documented answer —
    // the vault's own order, not alphabetical.
    expect(complete('see [[', 6)?.options.map((o) => o.label)).toEqual([
      'Roadmap',
      'Reading list',
      'Health',
    ])
    // `road` is not a note's name, so the last row offers making one — see the
    // `new page` case below.
    expect(complete('see [[road', 10)?.options.map((o) => o.label)).toEqual(['Roadmap', 'road'])
  })

  it('inserts the wikilink Obsidian would, over the whole `[[query`', () => {
    const result = complete('see [[road', 10)!
    // From the brackets, not the caret, so `[[road` is replaced whole.
    expect(result.from).toBe(4)
    expect(result.options[0].apply).toBe('[[Roadmap]]')
  })

  it('shows the path beside the name, since two notes can share one', () => {
    // The path a link would name: no `.md`, because a link never carries one.
    expect(complete('see [[read', 10)?.options[0].detail).toBe('Notes/Reading list')
  })

  /**
   * **A nested note is offered by the path the tree calls it.**
   *
   * Its file is `Areas/Northwind/Northwind.md`, and there is no row anywhere in
   * the app for `Northwind/Northwind` — so offering that as where the page lives
   * asks the reader about a file the app keeps out of sight. Reported from the
   * running app.
   */
  it('offers a nested note as the tree names it, not by its inner file', () => {
    const nested = [note('Areas/Northwind/Northwind.md'), note('Areas/Northwind/Plan.md')]
    expect(complete('see [[northw', 12, nested)?.options[0]).toMatchObject({
      label: 'Northwind',
      detail: 'Areas/Northwind',
      apply: '[[Northwind]]',
    })
  })

  it('offers nothing when the caret is not after a `[[`', () => {
    expect(complete('see road', 8)).toBeNull()
  })

  it('reaches over a `]]` that is already there', () => {
    // What typing `[[` leaves behind. Without this the completion writes
    // `[[Roadmap]]]]`, because it replaced `[[road` and left the pair standing.
    const result = complete('see [[road]]', 10)!
    expect([result.from, result.to]).toEqual([4, 12])
    expect(complete('see [[road', 10)!.to).toBe(10)
  })

  it('offers the note that does not exist, last', () => {
    const result = complete('see [[Landmark Plaza', 20)!
    expect(result.options.map((o) => o.label)).toEqual(['Landmark Plaza'])
    const [option] = result.options
    expect(option.detail).toBe('new page')
    // A plain wikilink. Following it is what creates the note.
    expect(option.apply).toBe('[[Landmark Plaza]]')
  })

  it('does not offer it for a note that is already there', () => {
    expect(complete('see [[Roadmap', 13)?.options.map((o) => o.label)).toEqual(['Roadmap'])
    // By path, too — the spelling a name with a `/` in it is asking for.
    expect(complete('see [[Notes/Reading list', 24)?.options.map((o) => o.label)).toEqual([
      'Reading list',
    ])
  })
})

describe('the `/` menu', () => {
  const slash = (doc: string, at: number, dailyFolder = 'Daily') => {
    const state = stateOf(doc, at)
    return slashSource(() => dailyFolder)({
      state,
      pos: at,
      explicit: false,
      matchBefore: (expr: RegExp) => {
        const line = state.doc.lineAt(at)
        const text = line.text.slice(0, at - line.from)
        const found = new RegExp(`(?:${expr.source})$`).exec(text)
        return found ? { from: at - found[0].length, to: at, text: found[0] } : null
      },
    } as never)
  }

  it('offers the blocks a note is made of, and filters as it is typed', () => {
    // Nine blocks, plus the two offered wherever the menu opens.
    expect(slash('/', 1)?.options).toHaveLength(11)
    expect(slash('/head', 5)?.options.map((o) => o.label)).toEqual([
      'Heading 1',
      'Heading 2',
      'Heading 3',
    ])
  })

  it('writes the markdown, over the whole `/query`', () => {
    const result = slash('/quo', 4)!
    expect(result.from).toBe(0)
    expect(result.options[0].apply).toBe('> ')
  })

  /**
   * **It opens wherever a `/` opens a word**, which is the rule `--` uses. The old
   * guard was "first thing on the line", which kept `http://` out by keeping the
   * menu out of a sentence altogether — so there was no way to insert anything
   * inline.
   */
  it('opens after a space and not inside a URL or a path', () => {
    expect(slash('see http://x', 12)).toBeNull()
    expect(slash('Areas/', 6)).toBeNull()
    expect(slash('  /', 3)).not.toBeNull()
    expect(slash('a note and /', 12)).not.toBeNull()
  })

  /** A block command mid-sentence is punctuation, not a block: `# ` halfway through
   *  a line is a hash. So the blocks are offered where a block can begin, and the
   *  inline ones everywhere. */
  it('offers only the inline options in the middle of a line', () => {
    expect(slash('a note and /', 12)?.options.map((o) => o.label)).toEqual(['Today', 'Now'])
  })

  /** The link carries the folder, so following it makes the note where the daily
   *  notes are rather than at the root — and it still reads as the date. */
  it('inserts a link to today’s page, in the daily folder', () => {
    const today = slash('/tod', 4)!.options[0]
    const stamp = localDateStamp()
    expect(today.label).toBe('Today')
    expect(today.detail).toBe(stamp)
    expect(today.apply).toBe(`[[Daily/${stamp}]]`)
    // With no daily folder set it is a bare name, not a stray slash.
    expect(slash('/tod', 4, '')!.options[0].apply).toBe(`[[${stamp}]]`)
  })

  /** The same string ⌘⇧T writes, trailing space and all: without it `LEADING_CLOCK`
   *  does not match and the next keystroke turns `09:41` into `09:41w`. */
  it('inserts the time, with the space that keeps it a clock', () => {
    const now = slash('/now', 4)!.options[0]
    expect(now.label).toBe('Now')
    expect(now.apply).toBe(`${localTimeStamp()} `)
    expect(now.detail).toBe(localTimeStamp())
  })

  it('offers nothing rather than an empty popup when the query matches none', () => {
    expect(slash('/zzz', 4)).toBeNull()
  })
})

describe('the link under a click', () => {
  const at = (doc: string, pos: number) => linkTargetAt(stateOf(doc, 0), pos)

  it('reads a wikilink, and takes the target from the left of a pipe', () => {
    expect(at('see [[Roadmap]] now', 8)).toEqual({ target: 'Roadmap', wiki: true })
    expect(at('see [[Areas/Gym|the gym]] now', 10)).toEqual({ target: 'Areas/Gym', wiki: true })
  })

  it('reads a markdown link, and says it is not a wikilink', () => {
    // The two resolve differently — by path, not by name — so the kind matters.
    expect(at('see [Roadmap](Notes/Roadmap.md) now', 8)).toEqual({
      target: 'Notes/Roadmap.md',
      wiki: false,
    })
  })

  it('answers nothing off a link, so a click there just moves the caret', () => {
    expect(at('see [[Roadmap]] now', 1)).toBeNull()
    expect(at('see [[Roadmap]] now', 18)).toBeNull()
    expect(at('no links here', 5)).toBeNull()
  })

  it('finds the right one when a line holds two', () => {
    const line = 'see [[One]] and [[Two]]'
    expect(at(line, 8)?.target).toBe('One')
    expect(at(line, 20)?.target).toBe('Two')
  })
})

describe('what folds', () => {
  const fold = (doc: string, line: number) => {
    const state = stateOf(doc, 0)
    const l = state.doc.line(line)
    return indentRange(state, l.from, l.to)
  }

  it('folds a line that has something indented under it', () => {
    const doc = '- outer\n  - inner\n  - also\n- next\n'
    expect(fold(doc, 1)).toEqual({ from: 7, to: 26 })
  })

  /**
   * The bug this replaced `foldGutter()` for. `lang-markdown` offers to fold any
   * block except headings and lists, so three lines of one paragraph folded from
   * the first to the last — collapsing lines that are not indented at all.
   */
  it('offers nothing on a line whose neighbours are level with it', () => {
    expect(fold('one\ntwo\nthree\n', 1)).toBeNull()
    expect(fold('- a\n- b\n- c\n', 1)).toBeNull()
  })

  it('stops at the first line back at its own indentation', () => {
    const doc = '- outer\n  - inner\n- next\n  - other\n'
    // Ends at the close of `  - inner`, not at the second nested item further down.
    expect(fold(doc, 1)).toEqual({ from: 7, to: 17 })
  })

  it('carries a blank line inside the block rather than closing on it', () => {
    const doc = '- outer\n\n  - inner\n- next\n'
    expect(fold(doc, 1)?.to).toBe(18)
  })

  /**
   * The shape a daily note actually has: a stamped line, then its bullets, with the
   * bullets **not** indented in the file. They read as belonging to the line above,
   * so that line is what collapses them — which is the model the user described.
   */
  it('folds the list that follows a line, indented or not', () => {
    const doc = '12:08 - reading\n- one\n- two\n12:20 - next\n'
    // Through the end of `- two`, stopping before the next stamped line.
    expect(fold(doc, 1)?.to).toBe(27)
    expect(fold(doc, 4)).toBeNull()
  })

  it('does not let one bullet swallow its siblings', () => {
    // A list line only takes what is indented *under* it, or every item in a flat
    // list would offer to fold the rest of the list.
    expect(fold('- a\n- b\n- c\n', 1)).toBeNull()
    expect(fold('- a\n- b\n- c\n', 2)).toBeNull()
  })

  it('offers nothing on a blank line', () => {
    expect(fold('- a\n\n  - b\n', 2)).toBeNull()
  })

  /**
   * The arrow has to survive the fold.
   *
   * Reported from the running app: collapsing a section took its arrow away, so
   * there was nothing left to click. The gutter asks per *block*, and once a range
   * is folded the block that begins at the fold reaches to the end of everything it
   * swallowed — so the question being asked was "is anything nested under the last
   * line of this fold", which is usually no. `foldMarkerFor` takes the block's
   * start and finds the line itself.
   */
  it('keeps the arrow, turned, once the block is folded', () => {
    const doc = '- outer\n  - inner\n  - also\n- next\n'
    const state = EditorState.create({ doc, extensions: [codeFolding()] })
    const line = state.doc.line(1)

    expect(foldMarkerFor(state, line.from)).toEqual({ folded: false })

    const folded = state.update({
      effects: foldEffect.of(indentRange(state, line.from, line.to)!),
    }).state
    // The line still offers an arrow, and it now points the other way.
    expect(foldMarkerFor(folded, line.from)).toEqual({ folded: true })
    // Asking with the folded block's own `to` is what used to answer nothing.
    expect(foldMarkerFor(folded, state.doc.line(3).to)).toBeNull()
  })
})

/**
 * A rule down each step of an indent, marked on the spaces themselves.
 *
 * The prose font is proportional, so an indent step has no width this code could
 * compute — a mark over the spaces starts exactly where they do whatever the font
 * is doing, and the stylesheet rules its left edge.
 */
describe('the indent guides', () => {
  /** The step is the whole subject here, so it is stated rather than defaulted. */
  const guides = (doc: string, step = 4) => {
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), indentUnit.of(' '.repeat(step))],
    })
    return spans(livePreviewDecorations(state, 0, state.doc.length)).filter((span) =>
      span.startsWith('cm-md-guide')
    )
  }

  it('marks one step per level, with the elbow on the innermost', () => {
    // One indented line under its parent: a trunk half a line long and the elbow
    // that turns into it. As a plain vertical rule this was a stroke beside the
    // text connected to nothing, which is what it looked like.
    expect(guides('- outer\n    - inner\n')).toEqual([
      'cm-md-guide cm-md-guide-end cm-md-elbow@8-12',
    ])
    // Two steps in: the outer trunk also ends here, because nothing below is in it.
    expect(guides('- outer\n        - deep\n')).toEqual([
      'cm-md-guide cm-md-guide-end@8-12',
      'cm-md-guide cm-md-guide-end cm-md-elbow@12-16',
    ])
  })

  it('carries a trunk on while the block below is still inside it', () => {
    const doc = '- outer\n    - one\n    - two\n'
    // `one` is not the last at its level, so its trunk carries on; `two` is.
    expect(guides(doc)).toEqual([
      'cm-md-guide cm-md-elbow@8-12',
      'cm-md-guide cm-md-guide-end cm-md-elbow@18-22',
    ])
  })

  it('looks through a blank line, as folding does', () => {
    // One gap inside a list does not end the list, and a trunk that stopped at it
    // would say otherwise.
    expect(guides('- outer\n    - one\n\n    - two\n')[0]).toBe('cm-md-guide cm-md-elbow@8-12')
  })

  it('marks whole steps only', () => {
    // Three spaces at a step of four is not a level, and half a rule would say it
    // was. Two steps of two, on the other hand, is exactly two levels.
    expect(guides('- outer\n   - odd\n')).toEqual([])
    expect(guides('- outer\n    - inner\n', 2)).toEqual([
      'cm-md-guide cm-md-guide-end@8-10',
      'cm-md-guide cm-md-guide-end cm-md-elbow@10-12',
    ])
  })

  it('leaves an unindented line alone', () => {
    expect(guides('- one\n- two\n')).toEqual([])
  })
})



describe('a character over a selection', () => {
  it('wraps rather than replacing, and keeps the selection for a second press', () => {
    // `plan` in `the plan here`.
    const first = run(wrapWith('*'), stateOf('the plan here', 4, 8))
    expect(first.handled).toBe(true)
    expect(first.doc).toBe('the *plan* here')
    expect([first.from, first.to]).toEqual([5, 9])

    // The second press, over the selection the first one left.
    const second = run(wrapWith('*'), stateOf('the *plan* here', 5, 9))
    expect(second.doc).toBe('the **plan** here')
  })

  it('does strikethrough with `~`, which is GFM and not CommonMark', () => {
    expect(run(wrapWith('~'), stateOf('the plan here', 4, 8)).doc).toBe('the ~plan~ here')
    expect(run(wrapWith('~'), stateOf('the ~plan~ here', 5, 9)).doc).toBe('the ~~plan~~ here')
  })

  it('declines with no selection, so the character types normally', () => {
    expect(run(wrapWith('*'), stateOf('the plan here', 4)).handled).toBe(false)
    expect(run(wrapWith('`'), stateOf('the plan here', 4)).handled).toBe(false)
  })

  /** Removing is the toggle, as in Obsidian — there is no separate clear command. */
  it('is undone by the same toggle the shortcut uses', () => {
    expect(run(toggleMarker('**'), stateOf('the **plan** here', 6, 10)).doc).toBe('the plan here')
  })
})

/**
 * `---` is a line, and it is still three characters.
 *
 * The trap is the frontmatter block: it *opens* with `---`, which the parser reads
 * as a horizontal rule, so drawing every rule would replace the first line of every
 * note that carries a property with a hairline.
 */
describe('a horizontal rule', () => {
  it('draws a line when the caret is elsewhere', () => {
    expect(all(stateOf('above\n\n---\n\nbelow', 0))).toEqual(['rule@7-10'])
  })

  it('gives the three characters back when the caret is on them', () => {
    expect(all(stateOf('above\n\n---\n\nbelow', 8))).toEqual(['cm-md-marker@7-10'])
  })

  // The same break, written with the other two characters.
  it('draws a line for underscores and for stars', () => {
    expect(all(stateOf('above\n\n___\n\nbelow', 0))).toEqual(['rule@7-10'])
    expect(all(stateOf('above\n\n***\n\nbelow', 0))).toEqual(['rule@7-10'])
  })

  /**
   * The case that drew **nothing at all**, and the one a note is most likely to
   * have: `---` on the line under a paragraph is a *setext heading* in CommonMark —
   * the paragraph becomes an H2 and the dashes are its underline — so it is no
   * `HorizontalRule` node, and nothing claimed either half. No line, no heading,
   * three literal dashes sitting in the note.
   *
   * `___` never had this problem: underscores cannot underline a heading.
   */
  it('draws a line for dashes typed straight under a line of text', () => {
    expect(all(stateOf('Some text\n---\nafter', 0))).toEqual(['rule@10-13'])
    expect(all(stateOf('Some text\n---\nafter', 11))).toEqual(['cm-md-marker@10-13'])
  })

  /**
   * Reported from the running app: a single `-` drew a line. CommonMark's setext
   * underline is *one or more* dashes, so the branch that draws `---` under a
   * paragraph drew that too — and a lone `-` is how a list item starts, which made
   * the editor unusable for a list under a line of text.
   */
  it('needs three dashes, not one', () => {
    expect(all(stateOf('Some text\n-\nafter', 0))).toEqual([])
    expect(all(stateOf('Some text\n--\nafter', 0))).toEqual([])
    expect(all(stateOf('Some text\n---\nafter', 0))).toEqual(['rule@10-13'])
    // And four is still a divider, as it is for a break with a blank line above.
    expect(all(stateOf('Some text\n----\nafter', 0))).toEqual(['rule@10-14'])
  })

  /**
   * The other half of the same report: with a rule drawn for a lone `-`, typing
   * `- ` to start a list put a full-width widget on the line and the caret went to
   * the row below it. A list marker has to survive being typed.
   */
  it('leaves a dash that is starting a list alone', () => {
    // `- ` cannot interrupt a paragraph as an empty item, so for now it is text.
    expect(all(stateOf('Some text\n- \nafter', 12))).toEqual([])
    // With something in the item it is a list, and the marker becomes the bullet.
    expect(all(stateOf('Some text\n- one\nafter', 15))).toEqual([
      'bullet@10-12',
      'cm-md-hang@10-10',
    ])
    // And on a line of its own, where an empty item is a list from the start.
    expect(all(stateOf('Some text\n\n- \nafter', 13))).toEqual([
      'bullet@11-13',
      'cm-md-hang@11-11',
    ])
  })

  it('needs the line to hold nothing but the break', () => {
    expect(all(stateOf('Some text\n--- see below\nafter', 0))).toEqual([])
    // Spaced apart is still a break, and still the whole line: CommonMark allows
    // spaces between the characters, so `- - -` is one.
    expect(all(stateOf('above\n\n- - -\n\nbelow', 0))).toEqual(['rule@7-12'])
  })

  /**
   * The block's own pair draws too, so a note opens with its properties held
   * between two lines. They were left as characters once, on the reasoning that a
   * note should not open with a line where its first delimiter belongs.
   *
   * The two are not the same node: the opening `---` is a `HorizontalRule`, and the
   * closing one is the underline of a *setext heading* whose text is the last
   * property line. Both have to be claimed or the block draws one line and not the
   * other, which is the state this test caught.
   */
  /** **As fences, not as dividers.** They drew as the accent rule like any other
   *  row of dashes, so `icon: calendar` sat between the two heaviest strokes on the
   *  page. A fence bounds a block of data; it is a hairline, and only inside the
   *  block — a `---` in the prose below is still the rule. */
  it('draws the frontmatter block’s own delimiters as fences', () => {
    const state = stateOf('---\nicon: calendar\n---\n\n# Reading\n\n---\n', 30)
    expect(all(state).filter((span) => /^(rule|fence)/.test(span))).toEqual([
      'fence@0-3',
      'fence@19-22',
      // Past the heading and its blank line: `# Reading\n\n` ends at 35.
      'rule@35-38',
    ])
    expect(all(state)).toContain('cm-md-frontmatter@0-22')
  })

  it('gives a delimiter back as characters when the caret is on it', () => {
    const state = stateOf('---\nicon: calendar\n---\n\n# Reading\n', 1)
    expect(all(state)).toContain('cm-md-marker@0-3')
    expect(all(state)).toContain('fence@19-22')
  })
})

/**
 * A property's *name*, marked so the stylesheet can give it the colour the
 * timestamp carries. The block around it is one dim mono run; without this a
 * property is that run and nothing in it reads as a label.
 */
describe('a property in the block at the top', () => {
  const properties = (doc: string, caret: number) =>
    all(stateOf(doc, caret)).filter((span) => span.startsWith('cm-md-property'))

  it('marks the name of each property', () => {
    expect(properties('---\nicon: compass\ndate: 2026-09-12\n---\n\nbody\n', 44)).toEqual([
      'cm-md-property@4-8',
      'cm-md-property@18-22',
    ])
  })

  // The same rule `frontmatter.ts` reads by: an indented key belongs to the key
  // above it, and this app does not know what that means.
  it('leaves an indented key alone', () => {
    expect(properties('---\nmeta:\n  nested: yes\n---\n\nbody\n', 30)).toEqual([
      'cm-md-property@4-8',
    ])
  })

  // The delimiters are not properties, and neither is prose below the block.
  it('marks nothing outside the block', () => {
    expect(properties('# Title\n\nnot: a property\n', 0)).toEqual([])
  })
})

describe('the clock a journal line opens with', () => {
  it('marks a leading HH:MM, padded or not', () => {
    expect(all(stateOf('12:08 - reading\n', 0))).toEqual(['cm-md-stamp@0-5'])
    expect(all(stateOf('9:05 woke up\n', 0))).toEqual(['cm-md-stamp@0-4'])
  })

  /**
   * A range reads as one stamp, because it is one time: `12:00 to 12:30` is when a
   * thing happens, and marking only the first half would leave the second looking
   * like prose that happens to have a colon in it.
   */
  it('marks a range as one stamp', () => {
    expect(all(stateOf('12:00 to 12:30 standup\n', 0))).toEqual(['cm-md-stamp@0-14'])
    expect(all(stateOf('9:05 - 9:20 walk\n', 0))).toEqual(['cm-md-stamp@0-11'])
    // An en dash, which is what a writer gets from autocorrect.
    expect(all(stateOf('12:00 – 12:30 lunch\n', 0))).toEqual(['cm-md-stamp@0-13'])
  })

  it('leaves a time inside a sentence alone', () => {
    // Anchored to the line start, or every duration in a note would be marked.
    expect(all(stateOf('the train at 12:08 was late\n', 0))).toEqual([])
  })

  /** And nothing else on the line: a clock's line took half a line of air above
   *  it for a build, and a line taller than its neighbours read as the time being
   *  larger. A journal line is a line. */
  it('marks the stamp on every line, and only the stamp', () => {
    expect(all(stateOf('12:08 one\n13:00 two\n', 0))).toEqual([
      'cm-md-stamp@0-5',
      'cm-md-stamp@10-15',
    ])
  })

  it('wants a space or the line end after it, so 12:089 is not a stamp', () => {
    expect(all(stateOf('12:089 odd\n', 0))).toEqual([])
  })

  /**
   * A bullet before it means no stamp: the pattern is anchored to the line's start,
   * so `- 12:08 note` is a list item that happens to open with a time.
   *
   * Worth knowing that an *action* is read past a bullet — `- --calendar …` parses
   * — so the two syntaxes disagree about this. Nothing depends on the disagreement
   * yet, and this test is where it is written down.
   */
  it('does not mark a stamp that a bullet comes before', () => {
    expect(all(stateOf('- 12:08 note\n', 0))).toEqual(['bullet@0-2', 'cm-md-hang@0-0'])
  })
})

describe('a click on a link', () => {
  /**
   * The bug: a note whose **last word is a link**, clicked in the empty space to
   * the right of it to put the caret at the end of the text, opened the link
   * instead. `posAtCoords` has no position out there and returns the nearest one,
   * which is the end of the line — inside the link.
   *
   * The geometric half of this cannot be tested here (jsdom lays nothing out, so
   * there is no "past the end of the line" to click). What can: the question the
   * handler now asks first, which is what the click *landed on* rather than what
   * position it is nearest to.
   */
  it('is a link click only when it lands on the link', () => {
    const line = document.createElement('div')
    line.className = 'cm-line'
    line.innerHTML =
      'the last word is a <span class="cm-md-link">[[Pingbird Notes]]</span>'
    const link = line.querySelector('.cm-md-link')!

    expect(isLinkClick(link)).toBe(true)
    // The line itself is what a click past the end of the text hits.
    expect(isLinkClick(line)).toBe(false)
    expect(isLinkClick(null)).toBe(false)
  })

  it('follows a click on something drawn inside the link', () => {
    const link = document.createElement('span')
    link.className = 'cm-md-link'
    link.innerHTML = '[<span class="cm-md-em">Roadmap</span>](Roadmap.md)'
    expect(isLinkClick(link.querySelector('.cm-md-em'))).toBe(true)
  })
})

/**
 * **The `--` collection picker, and what a declaration is for.**
 *
 * A collection's page declares one line — `--expense <<amount>> on [[<<merchant>>]]
 * using <<method>>` — and typing `--expense` in a note completes to it as a snippet:
 * the caret lands in `amount` and Tab moves to `merchant`. That is the whole point
 * of declaring one, so what is pinned here is that the declaration on the page and
 * the line the editor writes are the same string.
 */
describe('the `--` collection picker', () => {
  const COLLECTIONS = [
    { name: 'expense', declaration: '--expense <<amount>> on [[<<merchant>>]] using <<method>>' },
    { name: 'errands', declaration: null },
  ]
  const dashes = (doc: string, at: number, collections = COLLECTIONS) => {
    const state = stateOf(doc, at)
    return collectionSource(() => collections)({
      state,
      pos: at,
      explicit: false,
      matchBefore: (expr: RegExp) => {
        const line = state.doc.lineAt(at)
        const text = line.text.slice(0, at - line.from)
        const found = new RegExp(`(?:${expr.source})$`).exec(text)
        return found ? { from: at - found[0].length, to: at, text: found[0] } : null
      },
    } as never)
  }

  it('offers every collection, from the dashes', () => {
    const result = dashes('09:42 --', 8)!
    expect(result.options.map((one) => one.label)).toEqual(['--expense', '--errands'])
    // Over the `--` itself, so what is typed is replaced rather than appended to.
    expect(result.from).toBe(6)
  })

  /** The structure, minus the keyword the label already carries: the popup shows
   *  what will be written. */
  it('shows the structure beside the name', () => {
    expect(dashes('--', 2)!.options[0].detail).toBe('<<amount>> on [[<<merchant>>]] using <<method>>')
    expect(dashes('--', 2)!.options[1].detail).toBeUndefined()
  })

  it('writes the declared line, with the caret in the first hole', () => {
    const option = dashes('09:42 --exp', 11)!.options[0]
    // A snippet, not a string: the holes are stops, which a plain insert has none of.
    expect(typeof option.apply).toBe('function')

    let state = stateOf('09:42 --exp', 11)
    const editor = {
      state,
      dispatch: (tr: Transaction) => {
        state = tr.state
      },
    }
    ;(option.apply as (e: unknown, c: unknown, from: number, to: number) => void)(
      editor,
      option,
      6,
      11
    )
    // The brackets land as **literal text the line keeps**, and the fields are
    // between them: you type into a slot, not over it.
    expect(state.doc.toString()).toBe(
      '09:42 --expense <<amount>> on [[<<merchant>>]] using <<method>>'
    )
    // The first field is what the declaration wrote inside the brackets, selected
    // so typing replaces it — and the brackets are outside the selection.
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('amount')
  })

  /** A collection with no declaration still completes its own name — the popup is
   *  also how you find out which collections a vault has. */
  it('writes the name alone for a collection with no structure', () => {
    expect(dashes('--err', 5)!.options[1].apply).toBe('--errands ')
  })

  /** `OPENER`'s rule, so the popup and the parser agree about where an action can
   *  start: the dashes have to open a word. */
  it('opens only where the dashes open a word', () => {
    expect(dashes('stroke--width', 8)).toBeNull()
    // At the start of a line, after a space, and after a bullet: all word openings.
    expect(dashes('--', 2)).toBeTruthy()
    expect(dashes('- --', 4)).toBeTruthy()
    expect(dashes('12:00 to 12:30 --', 17)).toBeTruthy()
  })

  it('offers nothing when the vault has no collections', () => {
    expect(dashes('--', 2, [])).toBeNull()
  })
})

/**
 * **Following a link takes one press, and the press is the point.**
 *
 * It was bound to `click`, and a click needs the press and the release on the *same
 * element*. Pressing a link puts the caret in it, live preview reveals the syntax
 * it had been hiding, and the span that was pressed is replaced before the button
 * comes back up — so the browser generates no click at all. Read out of the running
 * app's own event log, after three fixes aimed at everything except this:
 *
 *     mousedown span.cm-md-link < div.cm-line < div.cm-content
 *     mouseup   span.cm-md-link < div.cm-line < div.cm-content
 *     (no click)
 *
 * Which is why this drives the events and not the handler: a test that called the
 * handler directly passed throughout.
 */
describe('following a link in the note', () => {
  const mounted = (doc: string) => {
    const opened: { target: string; wiki: boolean }[] = []
    const { container } = render(
      <MarkdownEditor
        initialMarkdown={doc}
        onChange={() => {}}
        onOpenLink={(target, wiki) => opened.push({ target, wiki })}
      />
    )
    return { opened, container }
  }

  it('opens on the press, with no click to follow it', () => {
    const { opened, container } = mounted('See [[Roadmap]] today.\n')
    const link = container.querySelector('.cm-md-link') as HTMLElement
    expect(link).toBeTruthy()

    // The sequence the log recorded: a press and a release, and no click, because
    // by then the element that was pressed no longer exists.
    fireEvent.mouseDown(link, { button: 0, detail: 1 })
    fireEvent.mouseUp(link, { button: 0, detail: 1 })

    expect(opened).toEqual([{ target: 'Roadmap', wiki: true }])
  })

  it('opens a named markdown link the same way', () => {
    const { opened, container } = mounted('See [the plan](Notes/Roadmap.md).\n')
    fireEvent.mouseDown(container.querySelector('.cm-md-link') as HTMLElement, {
      button: 0,
      detail: 1,
    })
    expect(opened).toEqual([{ target: 'Notes/Roadmap.md', wiki: false }])
  })

  /** A press that is not a plain left press is not "follow this link": the right
   *  button is the menu's, and a modifier is the platform's. */
  it('leaves the other buttons and the modifiers alone', () => {
    const { opened, container } = mounted('See [[Roadmap]] today.\n')
    const link = container.querySelector('.cm-md-link') as HTMLElement
    fireEvent.mouseDown(link, { button: 2, detail: 1 })
    fireEvent.mouseDown(link, { button: 0, detail: 1, metaKey: true })
    fireEvent.mouseDown(link, { button: 0, detail: 1, altKey: true })
    expect(opened).toEqual([])
  })

  /** Pressing the text of a note is still placing a caret, not following a link. */
  it('does nothing when the press is not on a link', () => {
    const { opened, container } = mounted('Just a sentence with no link in it.\n')
    fireEvent.mouseDown(container.querySelector('.cm-line') as HTMLElement, {
      button: 0,
      detail: 1,
    })
    expect(opened).toEqual([])
  })
})

/**
 * **A collection line's labels are syntax, so they hide.**
 *
 * `key::` tells the app which value is which; by the time the line is being *read*
 * it has done its job, and the words around it are the sentence. The same bargain
 * `**bold**` makes: the caret on the line brings every label back, because a line
 * whose structure you cannot see is a line you cannot correct.
 */
describe('a collection line', () => {
  /** What the line looks like with the hidden runs taken out — which is what the
   *  reader sees, since a hidden decoration takes no width. */
  const rendered = (doc: string, caretAt: number) => {
    const state = stateOf(doc, caretAt)
    const cuts: [number, number][] = []
    const iter = livePreviewDecorations(state, 0, state.doc.length).iter()
    while (iter.value) {
      const spec = iter.value.spec as { widget?: unknown; class?: string }
      if (!spec.widget && !spec.class && iter.from !== iter.to) cuts.push([iter.from, iter.to])
      iter.next()
    }
    let out = doc
    for (const [from, to] of cuts.reverse()) out = out.slice(0, from) + out.slice(to)
    return out
  }

  const LINE =
    '09:42 --expense spent currency:: EUR amount:: 480 at merchant:: [[Bistro]] using account:: Northbank'

  it('hides the labels and keeps the sentence', () => {
    // The caret parked on another line, so nothing here is being edited. The
    // link's own brackets are hidden by the rule that has always hidden them,
    // which is why `[[Bistro]]` reads as `Bistro`.
    expect(rendered(`${LINE}\n\nelsewhere`, LINE.length + 8)).toContain(
      '09:42 --expense spent EUR 480 at Bistro using Northbank'
    )
  })

  it('brings them back when the caret is on the line', () => {
    expect(rendered(`${LINE}\n\nelsewhere`, 20)).toContain(
      '09:42 --expense spent currency:: EUR amount:: 480 at merchant:: Bistro using account:: Northbank'
    )
  })

  /** Only a collection line: `::` in ordinary prose is ordinary prose. */
  it('leaves a line with no keyword alone', () => {
    const prose = 'Ratio:: about nine to one, they said.'
    expect(rendered(`${prose}\n\nelsewhere`, prose.length + 8)).toContain(prose)
  })

  /**
   * **The keyword takes the app's label format** — the one a property's name, the
   * clock and a JSON key take, because it is a piece of the line the app itself
   * reads. It does *not* hide with the labels: `--expense` is what the line is, and
   * a sentence that stops saying so reads as prose that happens to be collected.
   */
  it('marks the keyword, whether the caret is on the line or not', () => {
    const marked = (caret: number) =>
      all(stateOf(`${LINE}\n\nelsewhere`, caret)).filter((one) => one.startsWith('cm-md-collection'))
    // `--expense` is six characters in, and ten long.
    expect(marked(LINE.length + 8)).toEqual(['cm-md-collection@6-15'])
    expect(marked(20)).toEqual(['cm-md-collection@6-15'])
  })

  /**
   * **A slot is a guide for typing the line, not part of it.** While the caret is on
   * the line `<<>>` says where a value goes and — two characters wide at each end —
   * where one ends and the next label begins, which is the whole of what it is for.
   * Once the caret leaves there is nothing left to guide, so it goes with the labels.
   */
  it('shows a slot while the line is being edited, and hides the brackets after', () => {
    const fresh = '09:42 --expense spent amount::<<480>> using account::<<cash>>'
    const doc = `${fresh}\n\nelsewhere`
    expect(rendered(doc, 10)).toContain(fresh)
    // The brackets go; what was typed between them is the sentence, and stays.
    expect(rendered(doc, fresh.length + 8)).toContain('09:42 --expense spent 480 using cash')
  })

  /** A single colon is prose — `Note: this` — and a clock is full of them. */
  it('hides only a doubled colon', () => {
    const line = '09:42 --expense spent amount: 480'
    expect(rendered(`${line}\n\nelsewhere`, line.length + 8)).toContain(line)
  })
})

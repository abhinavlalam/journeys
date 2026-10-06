/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

/**
 * The markdown editor: CodeMirror over the file's own bytes.
 *
 * Commands and Live Preview decorations are tested as pure functions
 * over an `EditorState`. jsdom lays nothing out, so a mounted
 * editor's viewport is made up there; `livePreviewDecorations` takes
 * its span as an argument so a test can hand it the whole document.
 *
 * A mount is for the wiring: the editor comes up, its change handler does
 * not fire on open, and it fires with the whole document when it does.
 *
 * Nothing geometric is tested here (caret position, a hidden
 * marker's width, wrapping); that needs a real webview.
 */

/**
 * Before the imports: `navigator.platform` is `''` in jsdom, and `@codemirror/view`
 * reads it at load to decide whether `Mod-` is ⌘ or Ctrl. Otherwise the keymap
 * under test would be the Windows one. (`matchMedia` is in `setup.ts`.)
 */
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, 'platform', {
    configurable: true,
    value: 'MacIntel',
  })
})

import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { EditorView, type Command, type Decoration, type DecorationSet } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { codeFolding, foldEffect, indentUnit } from '@codemirror/language'
import { MarkdownEditor, caretOnOpen } from '../MarkdownEditor'
import {
  continueIndent,
  toggleMarker,
  deleteWikiLinkPair,
  wrapInWikiLink,
  wrapWith,
} from '../editorCommands'
import { localDateStamp, localTimeStamp } from '../clock'
import { propertySource, slashSource, wikiLinkSource } from '../editorComplete'
import { completionStatus, startCompletion } from '@codemirror/autocomplete'
import { foldMarkerFor, indentRange } from '../editorFold'
import {
  isLinkClick,
  linkTargetAt,
  livePreviewDecorations,
  propertyTypes,
  taskAt,
  toggledTask,
} from '../editorPreview'
import { vaultFile as note } from './fakeVault'

afterEach(cleanup)

/**
 * A state with the markdown parser and a selection to run a
 * command over. `EditorState.create` parses a document this size
 * fully, so `syntaxTree` is the whole tree.
 */
function stateOf(doc: string, anchor: number, head = anchor, indentWidth = 2) {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown({ base: markdownLanguage }), indentUnit.of(' '.repeat(indentWidth))],
  })
}

/** The inline style a decoration carries; the value is the assertion. */
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

/**
 * Runs a command over a state and returns the document and selection
 * it produced, read off the `Transaction` passed to `dispatch`.
 */
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
    // Where ⌘B leaves the caret, so ⌘B twice undoes itself.
    const result = run(toggleMarker('**'), stateOf('the **plan** here', 6, 10))
    expect(result.doc).toBe('the plan here')
    expect([result.from, result.to]).toEqual([4, 8])
  })

  it('unwraps when the markers sit inside the selection', () => {
    // What selecting `**plan**` by hand gives.
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
    // `_plan_` with ⌘B: `_` is not `**`, so this wraps.
    expect(run(toggleMarker('**'), stateOf('the _plan_ here', 5, 9)).doc).toBe(
      'the _**plan**_ here'
    )
  })
})

// ---------------------------------------------------------------------------
// Live Preview
// ---------------------------------------------------------------------------

/**
 * Every decoration in the set as `class@from-to`. A hidden marker is a
 * `Decoration.replace({})` with no class; a replacing decoration with a widget is
 * named by its widget's class minus the prefix (`task`, `rule`). Sorted outermost
 * first at each position, since `RangeSet` order is CodeMirror's detail.
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
    // `the **plan** here`, caret at 0, outside the run.
    expect(all(stateOf('the **plan** here', 0))).toEqual([
      'cm-md-strong@4-12',
      'hidden@4-6',
      'hidden@10-12',
    ])
  })

  it('brings the asterisks back, dimmed, when the caret is inside the run', () => {
    // Caret between `pl` and `an`: the syntax must show to be edited.
    expect(all(stateOf('the **plan** here', 8))).toEqual([
      'cm-md-strong@4-12',
      'cm-md-marker@4-6',
      'cm-md-marker@10-12',
    ])
  })

  it('counts the run’s own edges as inside, so the markers can be reached', () => {
    // Caret right before the opening `**`. If the syntax only showed
    // once the caret was past it, the run could not be entered.
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
   * The third decoration is on the line, not the heading: it puts
   * space above. A margin on the heading's inline mark does nothing.
   */
  it('hides a heading’s hash *and* the space after it', () => {
    // `# Head`: hiding `#` alone left every heading indented by a space.
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
    // Line three, so the decoration is at its start, not the document's.
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
   * Reveal is per node, not per line. A caret at the start of `**_both_**` is
   * inside the bold run but not the italic, so the asterisks show and the
   * underscores stay hidden. Revealing a whole line would make dense lines jump.
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
    // Caret at 4, inside `both`: both pairs show.
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

  /** A list marker is shown as typed, at the margin or indented. */
  it('leaves a list marker as typed', () => {
    expect(all(stateOf('- see [[Pingbird]]\n', 0))).toEqual(['cm-md-link@6-18', 'hidden@6-8', 'hidden@16-18'])
    expect(all(stateOf('1. first\n', 8))).toEqual([])
  })

  /**
   * A `#tag` is always marked: the mark makes it pressable.
   * Nothing hides, because `#` is part of the tag.
   */
  it('marks a tag, with the caret in the line or out of it', () => {
    expect(all(stateOf('see #travel now\n', 0))).toEqual(['cm-md-tag@4-11'])
    // The caret on it changes nothing: there is no syntax to bring back.
    expect(all(stateOf('see #travel now\n', 6))).toEqual(['cm-md-tag@4-11'])
  })

  /**
   * The guards at the decoration level: a heading is not a tag,
   * nor is an anchor. `tags.test.ts` has the rest.
   */
  it('does not mark a heading or an anchor as a tag', () => {
    const tagged = (doc: string) => all(stateOf(doc, 0)).filter((one) => one.startsWith('cm-md-tag@'))
    expect(tagged('## Section\n')).toEqual([])
    expect(tagged('see https://example.invalid/a#b\n')).toEqual([])
    expect(tagged('see [[Areas/Plans#Roadmap]]\n')).toEqual([])
  })

  /** Code reads as written: no tag to press, no link with its brackets hidden. */
  it('marks no tag or link in code', () => {
    const marked = (doc: string) => all(stateOf(doc, doc.length)).filter((one) => /^(cm-md-tag|cm-md-link)@/.test(one))
    expect(marked('```\n#include [[x]]\n```\n')).toEqual([])
    expect(marked('see `#ef476f` and `[[x]]` here\n')).toEqual([])
  })

  /** The page block's look comes from the top, whatever span is in view. */
  it('reads the page properties from the top when the view starts below it', () => {
    const doc = 'icon:: book\nstatus:: draft\nowner:: me\n\nbody\n'
    const state = stateOf(doc, doc.length)
    const from = state.doc.line(2).from
    const inView = spans(livePreviewDecorations(state, from, state.doc.length))
    expect(inView).toContain(`cm-md-property@${from}-${from + 'status'.length}`)
    expect(inView.some((one) => one.startsWith('hidden@'))).toBe(false)
  })

  /**
   * A task is read as Obsidian reads it, not GFM: any single
   * character between the brackets is a state (`[-]`, `[>]`,
   * `[/]`), and one the app has no glyph for is drawn as itself.
   */
  it('draws a checkbox for the box, leaves the marker, and dims a done item', () => {
    expect(all(stateOf('- [ ] milk\n', 0))).toEqual(['task@2-6'])
    expect(all(stateOf('- [x] milk\n', 0))).toEqual(['task@2-6', 'cm-md-task-done@6-10'])
    // A state with no glyph is still a task, and is not dimmed.
    expect(all(stateOf('- [>] milk\n', 0))).toEqual(['task@2-6'])
    expect(all(stateOf('1. [ ] first\n', 0))).toEqual(['task@3-7'])
  })

  /**
   * The box stays drawn with the caret in the line, so it can be pressed while writing.
   */
  it('keeps the box drawn with the caret in the line', () => {
    expect(all(stateOf('- [ ] milk\n', 8))).toEqual(['task@2-6'])
    expect(all(stateOf('- [ ] milk\n', 3))).toEqual(['task@2-6'])
  })

  it('draws a task at any indent, and not in fenced code', () => {
    const tasks = (doc: string) => all(stateOf(doc, 0)).filter((one) => one.startsWith('task@'))
    expect(tasks('     - [ ] milk\n')).toEqual(['task@7-11'])
    expect(tasks('```\n- [ ] milk\n```\n')).toEqual([])
  })

  /**
   * The space after the bracket keeps these from being tasks: one
   * opens a wikilink, the other is a markdown link labelled `x`.
   */
  it('is not a task when the brackets are a link', () => {
    const tasks = (doc: string) => all(stateOf(doc, 0)).filter((one) => one.startsWith('task@'))
    expect(tasks('- [[Note]]\n')).toEqual([])
    expect(tasks('- [x](url)\n')).toEqual([])
  })

  /**
   * A press writes one character, the state between the
   * brackets, and clears any other state rather than cycling.
   */
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
   * Every indented line hangs, not only a list item: a line's
   * wrapped rows start under its text. The hang was once only on
   * list items, and indented prose wrapped back to the edge.
   */
  it('hangs an indented prose line by the width of its own spaces', () => {
    const doc = '10:00 the entry\n      the detail under it\n'
    const at = doc.indexOf('      the detail')
    expect(styleAt(stateOf(doc, 0), at)).toBe('--hang: calc(6 * var(--space-w))')
    // The block's first line is not indented, so it has no hang.
    expect(styleAt(stateOf(doc, 0), 0)).toBe('')
  })

  /** A blank or unindented line gets no hang. */
  it('gives no hang to a line with no indent', () => {
    expect(styleAt(stateOf('plain line here\n', 0), 0)).toBe('')
    expect(styleAt(stateOf('\n\n', 0), 0)).toBe('')
  })

  it('hangs a list line by its own spaces, as any indented line', () => {
    expect(styleAt(stateOf('  - two\n', 0), 0)).toBe('--hang: calc(2 * var(--space-w))')
    expect(styleAt(stateOf('- one\n', 0), 0)).toBe('')
  })

  /**
   * A link reads as its name. CommonMark reads `[[x]]` as plain text, so the scan
   * finds it. The brackets hide while the caret is elsewhere and come back when
   * it arrives. An alias gives the name: `[[Areas/Pingbird|Bird]]` shows `Bird`.
   */
  it('shows a wikilink’s name and hides its syntax', () => {
    // `[[` and `]]` hidden; `Pingbird` is the name.
    expect(all(stateOf('see [[Pingbird]]\n', 0))).toEqual([
      'cm-md-link@4-16',
      'hidden@4-6',
      'hidden@14-16',
    ])
    // With an alias, everything left of the pipe hides with the brackets.
    expect(all(stateOf('see [[Areas/Pingbird|Bird]]\n', 0))).toEqual([
      'cm-md-link@4-27',
      'hidden@4-21',
      'hidden@25-27',
    ])
    // The caret on it shows the syntax, so it can be edited.
    expect(all(stateOf('see [[Areas/Pingbird|Bird]]\n', 10))).toEqual(['cm-md-link@4-27'])
  })

  /**
   * `|!n` shows the last n names of the path, when the last name alone does not
   * say whose. The marker sits in the alias slot and hides with the brackets.
   */
  it('shows the last n names of a wikilink written |!n', () => {
    // `!2` hides `[[a/b/` at the front and `|!2]]` at the back: `c/d` shows.
    expect(all(stateOf('see [[a/b/c/d|!2]]\n', 0))).toEqual([
      'cm-md-link@4-18',
      'hidden@4-10',
      'hidden@13-18',
    ])
    // `!` with no number shows every name.
    expect(all(stateOf('see [[a/b/c/d|!]]\n', 0))).toEqual([
      'cm-md-link@4-17',
      'hidden@4-6',
      'hidden@13-17',
    ])
    // A count past the path's length clamps to the path.
    expect(all(stateOf('see [[a/b|!9]]\n', 0))).toEqual([
      'cm-md-link@4-14',
      'hidden@4-6',
      'hidden@9-14',
    ])
    // The caret on it brings the marker back, like other syntax.
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
   * A bare URL is a link. GFM parses one (an email too) as a `URL`
   * node, and nothing marked it, so pasted links could not be clicked.
   */
  it('marks a bare URL, an autolink and an email', () => {
    expect(all(stateOf('see https://example.invalid/a here\n', 0))).toEqual(['cm-md-link@4-29'])
    // `<url>`: the angle brackets are syntax; the URL is the name.
    expect(all(stateOf('see <https://example.invalid/a> here\n', 0))).toEqual([
      'cm-md-link@4-31',
      'hidden@4-5',
      'hidden@30-31',
    ])
    expect(all(stateOf('mail name@example.invalid now\n', 0))).toEqual(['cm-md-link@5-25'])
  })

  /** More inline nodes, tested here too. */
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

/**
 * The live view behind a rendered `MarkdownEditor`, found with
 * CodeMirror's `findFromDOM`.
 */
function viewOf(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)
  expect(view).toBeTruthy()
  return view!
}

/**
 * Enter keeps the indent of the line you are on. Markdown's own Enter
 * follows the block the line is in: after an ordered list, a line typed
 * with six spaces was continued with three, the list item's content column.
 */
describe('Enter on an indented line', () => {
  /**
   * The note that showed this: a list, a lazy continuation of
   * its last item, and an indented line under that.
   */
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

  it('continues a list line at the margin, and ends it on an empty item', () => {
    expect(run(continueIndent, stateOf('- one', 5, 5, 6)).doc).toBe('- one\n- ')
    expect(run(continueIndent, stateOf('  1. one', 8, 8, 6)).doc).toBe('  1. one\n  2. ')
    expect(run(continueIndent, stateOf('- [x] done', 10, 10, 6)).doc).toBe('- [x] done\n- [ ] ')
    expect(run(continueIndent, stateOf('- ', 2, 2, 6)).doc).toBe('')
  })

  it('opens a blank line above when Enter is pressed before the text', () => {
    expect(run(continueIndent, stateOf('     - milk', 0, 0, 5)).doc).toBe('\n     - milk')
  })

  describe('on an indented list line', () => {
    const enter = (doc: string) => {
      const { container } = render(<MarkdownEditor initialMarkdown={doc} onChange={() => {}} indentWidth={5} />)
      const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
      view.dispatch({ selection: { anchor: doc.length } })
      fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
      const text = view.state.doc.toString()
      // The caret is at the end, where the next word goes.
      expect(view.state.selection.main.head).toBe(text.length)
      return text
    }

    it('starts the next line with the same indent and marker', () => {
      expect(enter('     - milk')).toBe('     - milk\n     - ')
      expect(enter('\t* eggs')).toBe('\t* eggs\n\t* ')
    })

    it('ends the list on an empty item, keeping the indent', () => {
      expect(enter('     - milk\n     - ')).toBe('     - milk\n     ')
    })

    it('writes the next number on a numbered line', () => {
      expect(enter('     1. one')).toBe('     1. one\n     2. ')
    })

    it('ends the list, then moves out a level, on each Enter after', () => {
      expect(enter('     - milk\n     ')).toBe('     - milk\n')
    })
  })

  it('declines on a quote line, so the quote continues', () => {
    expect(run(continueIndent, stateOf('> quoted', 8, 8, 6)).handled).toBe(false)
  })

  /**
   * A plain line under a list item is, to markdown, part of that item. Markdown's own
   * Enter took a line shorter than a task's marker for an empty item and deleted it,
   * and under two tasks put the new line above the text instead of after it.
   */
  it('gives a plain line a plain new line, even under a task', () => {
    expect(run(continueIndent, stateOf('plain', 5, 5, 6)).doc).toBe('plain\n')
    for (const doc of ['- [ ] task\nmilk', '- [ ] a\n- [ ] b\nplain', '- one\nx']) {
      const { container, unmount } = render(<MarkdownEditor initialMarkdown={doc} onChange={() => {}} indentWidth={6} />)
      const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
      view.dispatch({ selection: { anchor: doc.length } })
      fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
      expect(view.state.doc.toString()).toBe(`${doc}\n`)
      unmount()
    }
  })

  it('moves an empty indented line out one level', () => {
    expect(run(continueIndent, stateOf('      ', 6, 6, 6)).doc).toBe('')
    expect(run(continueIndent, stateOf('            ', 12, 12, 6)).doc).toBe('      ')
  })
})

describe('the mounted editor', () => {
  /**
   * The caret starts under the properties, and is drawn. At offset 0
   * the first key typed edits a property. CodeMirror draws the caret
   * only in a focused editor, so placing it and focusing go together.
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
   * Tab through the keymap: a line moves one indent width with
   * the lines nested under it; a list line is like any other.
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

    /**
     * A journal entry: a clock line with its detail indented under it.
     * The block moves by one indent width, and its nesting is kept.
     */
    it('moves a prose block and the run nested under it', () => {
      const doc = '10:00 Making the updates\n      more detail\n      and more\n'
      expect(tabbed(doc, 8)).toBe(
        '  10:00 Making the updates\n        more detail\n        and more\n'
      )
    })

    /** A line with nothing under it gets the plain Tab. */
    it('leaves a line with no run to the general Tab', () => {
      expect(tabbed('alpha\nbeta\n', 2)).toBe('  alpha\nbeta\n')
    })

    /** A selection goes to `indentMore`, which moves every line in it. */
    it('indents every line of a selection', () => {
      const doc = 'alpha\nbeta\ngamma\n'
      expect(tabbed(doc, 0, doc.indexOf('gamma') + 5)).toBe('  alpha\n  beta\n  gamma\n')
    })

    /** A list line with a child moves with it, as any block does. */
    it('moves a list item and carries its child', () => {
      const doc = '- one\n- parent\n  - child\n'
      expect(tabbed(doc, doc.indexOf('- parent') + 4)).toBe('- one\n  - parent\n    - child\n')
    })

    it('moves every selected list item', () => {
      const doc = '- one\n- two\n- three\n'
      expect(tabbed(doc, doc.indexOf('- two'), doc.indexOf('- three') + 7)).toBe(
        '- one\n  - two\n  - three\n'
      )
    })

    /** Tab then Enter: the next line keeps the new indent and the marker. */
    it('continues a list at the depth Tab gave it', () => {
      const doc = '- one\n- two'
      const { container } = render(<MarkdownEditor initialMarkdown={doc} onChange={() => {}} indentWidth={5} />)
      const view = viewOf(container)
      view.dispatch({ selection: { anchor: doc.length } })
      fireEvent.keyDown(view.contentDOM, { key: 'Tab' })
      fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
      expect(view.state.doc.toString()).toBe('- one\n     - two\n     - ')
    })

    /** Shift-Tab is the reverse, and stops at the margin. */
    it('outdents a prose block without pushing its run past the margin', () => {
      const doc = '  10:00 Making the updates\n    more detail\n'
      expect(tabbed(doc, 10, 10, true)).toBe('10:00 Making the updates\n  more detail\n')
    })
  })

  /**
   * A press checks the box, on `mousedown`: the toggle rebuilds the
   * decoration and the pressed element is gone before the release, so no
   * `click` fires. The release below lands on a different node on purpose.
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
    // The note is saved by the same handler as every key.
    expect(typed.at(-1)).toBe('- [ ] milk\n')
  })

  /** Enter on a task line starts an unchecked box under it (`continueIndent`). */
  it('continues a task list on Enter, unchecked', () => {
    const doc = '- [x] milk\n'
    const { container } = render(<MarkdownEditor initialMarkdown={doc} onChange={() => {}} />)
    const view = viewOf(container)
    view.dispatch({ selection: { anchor: doc.length - 1 } })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(view.state.doc.toString()).toBe('- [x] milk\n- [ ] \n')
  })

  /**
   * A state with no glyph is still a task, and a press clears it rather than cycling.
   */
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

  /**
   * Only a plain left press: the right button is the menu's and
   * modifiers are the platform's, as for a link.
   */
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
   * A double click on a row opens the note and starts a rename. The note arrives a
   * read later, and the editor's mount took the keyboard, which ended the rename
   * on blur. So the arriving file does not take the keyboard from another field.
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
   * A note that is only `# title` opened with the `#` showing, because the
   * caret was on that line and the editor shows the syntax under the caret.
   */
  it('starts the caret under the title as well', () => {
    expect(caretOnOpen('# Reading\n\nthe plan\n')).toBe(10)
    // With a blank line after the block the caret lands on it,
    // and the title below keeps its `#` hidden.
    expect(caretOnOpen('---\nicon: x\n---\n\n# Reading\nbody\n')).toBe(16)
    // No blank line, so the title is the first thing past the block and is skipped.
    expect(caretOnOpen('---\nicon: x\n---\n# Reading\nbody\n')).toBe(26)
    // The same, for page properties written as `key:: value`.
    expect(caretOnOpen('icon:: x\n\n# Reading\nbody\n')).toBe(9)
    expect(caretOnOpen('icon:: x\n# Reading\nbody\n')).toBe(19)
    // A title and nothing else: the end of the note, where typing goes.
    expect(caretOnOpen('# owner\n')).toBe(8)
    expect(caretOnOpen('# owner')).toBe(7)
  })

  it('leaves a heading further down alone, since that is a section', () => {
    // The caret belongs at the top of the body; a heading further down is not a title.
    expect(caretOnOpen('some text\n\n# Later\n')).toBe(0)
  })

  it('starts at the top of a note that has neither', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown={'the plan\n\nand the rest\n'} onChange={() => {}} />
    )
    expect(viewOf(container).state.selection.main.head).toBe(0)
  })

  // Placing a caret types nothing: the note on disk is untouched
  // (`openNote.test.tsx` checks the bytes).
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
   * Opening a note must not write to it. Nothing here changes
   * the document on mount, and CodeMirror's update listener does
   * not run for the first state, so nothing should be called.
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

    // Synchronous: no timer is advanced and no `waitFor` is
    // needed, so no keys are lost when the pane unmounts.
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenLastCalledWith('one two')
  })

  /**
   * A file keeps its line endings. CodeMirror splits on `\r\n`,
   * `\r` and `\n` and joins with `\n`, so the first key in a
   * Windows note or an exported CSV rewrote every line ending.
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
    // A list line too, with the caret after the new marker.
    view.dispatch({ changes: { from: 0, insert: '- ' }, selection: { anchor: 6 } })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(changed).toHaveBeenLastCalledWith('- one!\r\n- \r\ntwo\r\n\r\n')
    expect(view.state.selection.main.head).toBe(view.state.doc.line(2).to)
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
  // document a break is one, so each break above pushed the caret one further.
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
    // The trailing space is part of it: without it, the next
    // character typed stops it being a stamp.
    expect(text).toMatch(/^\d{2}:\d{2} $/)
    // Past all of it. The caret used to be mapped to the front
    // of the insert, so the next key landed before the time.
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
   * The feature end to end, asserted on the rendered text rather than decoration
   * ranges, so it covers the `ViewPlugin` and its redraw on selection.
   * `textContent`, not a measurement: a replaced range is absent from the DOM.
   */
  it('hides the syntax in the DOM, and brings it back where the caret goes', () => {
    const { container } = render(
      <MarkdownEditor initialMarkdown={'# Head\n\nthe **plan** here\n'} onChange={() => {}} />
    )
    const view = viewOf(container)
    const shown = () => container.querySelector('.cm-content')!.textContent

    // The caret opens on the line under the title, so the heading
    // is rendered with its `# ` hidden, and so is the bold run.
    expect(shown()).toBe('Headthe plan here')

    // Into the heading: its `# ` comes back to be edited.
    view.dispatch({ selection: { anchor: 1 } })
    expect(shown()).toBe('# Headthe plan here')

    // Into the bold run: the heading's `# ` hides again and the asterisks appear.
    view.dispatch({ selection: { anchor: 14 } })
    expect(shown()).toBe('Headthe **plan** here')

    // Rendered, not just revealed: the run and its markers carry
    // their classes, so the asterisks are dimmed, not bold.
    const strong = container.querySelector('.cm-md-strong')!
    expect(strong.textContent).toBe('**plan**')
    expect(strong.querySelectorAll('.cm-md-marker').length).toBe(2)
  })

  /**
   * Removing `docChanged` from the plugin's redraw condition
   * left every other test green. An edit after the caret does
   * not move it, and the note then rendered as before the edit.
   */
  it('renders syntax that arrived from an edit which did not move the caret', () => {
    const { container } = render(<MarkdownEditor initialMarkdown="x" onChange={() => {}} />)
    const view = viewOf(container)
    const shown = () => container.querySelector('.cm-content')!.textContent

    // The caret is at 0 and stays there: the insert is after it.
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
    // A single `*`: one asterisk is italic, two bold, so ⌘I and
    // the `*` key write the same marker.
    expect(view.state.doc.toString()).toBe('the *plan* here')

    view.dispatch({ selection: { anchor: 5, head: 9 } })
    fireEvent.keyDown(view.contentDOM, { key: 'e', metaKey: true })
    expect(view.state.doc.toString()).toBe('the *`plan`* here')
  })
})

// ---------------------------------------------------------------------------
// `[` over a selection, and the `[[` picker
// ---------------------------------------------------------------------------

const NOTES = [note('Roadmap.md'), note('Notes/Reading list.md'), note('Areas/Health.md')]

describe('Backspace between the brackets', () => {
  /**
   * The second `[` writes `[]]` in one key; one Backspace takes
   * it back. Without this the `]]` stayed in the sentence.
   */
  it('takes all four, and leaves the rest of the line', () => {
    const out = run(deleteWikiLinkPair, stateOf('see [[]] here', 6))
    expect(out.handled).toBe(true)
    expect(out.doc).toBe('see  here')
    expect([out.from, out.to]).toEqual([4, 4])
  })

  it('declines with a word between them, or a selection, or one bracket', () => {
    // `[[note|]]`: an ordinary Backspace on the `e`.
    expect(run(deleteWikiLinkPair, stateOf('see [[note]] here', 10)).handled).toBe(false)
    // With a selection, Backspace deletes it.
    expect(run(deleteWikiLinkPair, stateOf('see [[]] here', 6, 7)).handled).toBe(false)
    // A single pair is punctuation the app did not write.
    expect(run(deleteWikiLinkPair, stateOf('see [] here', 5)).handled).toBe(false)
    // And the start of a line has nothing behind it.
    expect(run(deleteWikiLinkPair, stateOf('[[]]', 0)).handled).toBe(false)
  })
})

describe('`[` over a selection', () => {
  it('wraps once and keeps the selection, so a second press can see it', () => {
    // `plan` in `the plan here`. One bracket is not a wikilink; it takes two.
    const out = run(wrapInWikiLink, stateOf('the plan here', 4, 8))
    expect(out.handled).toBe(true)
    expect(out.doc).toBe('the [plan] here')
    // Still over the word, so the next press can make the link.
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
    // A single bracket is plain punctuation.
    expect(run(wrapInWikiLink, stateOf('the plan here', 4)).handled).toBe(false)
  })

  it('closes the pair on the second `[`, caret between the four', () => {
    // `see [` with the caret at the end: the next key makes it `[[`.
    const out = run(wrapInWikiLink, stateOf('see [', 5))
    expect(out.handled).toBe(true)
    expect(out.doc).toBe('see [[]]')
    // Between them, where the `[[` source reads and the popup opens.
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
    // Tree order on an empty query, as `matchNotes` gives it:
    // the vault's order, not alphabetical.
    expect(complete('see [[', 6)?.options.map((o) => o.label)).toEqual([
      'Roadmap',
      'Reading list',
      'Health',
    ])
    // `road` is not a note's name, so the last row offers making
    // one (see the `new page` case below).
    expect(complete('see [[road', 10)?.options.map((o) => o.label)).toEqual(['Roadmap', 'road'])
  })

  it('inserts the wikilink Obsidian would, over the whole `[[query`', () => {
    const result = complete('see [[road', 10)!
    // From the brackets, not the caret, so `[[road` is replaced whole.
    expect(result.from).toBe(4)
    expect(result.options[0].apply).toBe('[[Roadmap]]')
  })

  it('shows the path beside the name, since two notes can share one', () => {
    // The path a link would name: no `.md`, since a link never carries one.
    expect(complete('see [[read', 10)?.options[0].detail).toBe('Notes/Reading list')
  })

  /**
   * A nested note is offered by the path the tree shows. Its file is
   * `Areas/Northwind/Northwind.md`, and no row anywhere shows `Northwind/Northwind`.
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
    // What typing `[[` leaves behind. Without this the
    // completion writes `[[Roadmap]]]]`.
    const result = complete('see [[road]]', 10)!
    expect([result.from, result.to]).toEqual([4, 12])
    expect(complete('see [[road', 10)!.to).toBe(10)
  })

  it('offers the note that does not exist, last', () => {
    const result = complete('see [[Landmark Plaza', 20)!
    expect(result.options.map((o) => o.label)).toEqual(['Landmark Plaza'])
    const [option] = result.options
    expect(option.detail).toBe('new page')
    // A plain wikilink. Following it creates the note.
    expect(option.apply).toBe('[[Landmark Plaza]]')
  })

  it('does not offer it for a note that is already there', () => {
    expect(complete('see [[Roadmap', 13)?.options.map((o) => o.label)).toEqual(['Roadmap'])
    // By path too, the form a name with a `/` asks for.
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
   * It opens where a `/` starts a word, like the `#` of a tag. The old
   * rule (first thing on the line) kept it out of sentences altogether.
   */
  it('opens after a space and not inside a URL or a path', () => {
    expect(slash('see http://x', 12)).toBeNull()
    expect(slash('Areas/', 6)).toBeNull()
    expect(slash('  /', 3)).not.toBeNull()
    expect(slash('a note and /', 12)).not.toBeNull()
  })

  /**
   * A block command mid-sentence is punctuation: `# ` halfway through a line is
   * a hash. Blocks are offered where a block can begin; inline items everywhere.
   */
  it('offers only the inline options in the middle of a line', () => {
    expect(slash('a note and /', 12)?.options.map((o) => o.label)).toEqual(['Today', 'Now'])
  })

  /**
   * The link carries the folder, so following it makes the note
   * in the daily folder, and it still reads as the date.
   */
  it('inserts a link to today’s page, in the daily folder', () => {
    const today = slash('/tod', 4)!.options[0]
    const stamp = localDateStamp()
    expect(today.label).toBe('Today')
    expect(today.detail).toBe(stamp)
    expect(today.apply).toBe(`[[Daily/${stamp}]]`)
    // With no daily folder set it is a bare name, not a stray slash.
    expect(slash('/tod', 4, '')!.options[0].apply).toBe(`[[${stamp}]]`)
  })

  /**
   * The same text ⌘⇧T writes, trailing space and all: without it
   * the next key turns `09:41` into `09:41w`.
   */
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
    // The two resolve differently (by path, not by name), so the kind matters.
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
   * Why `foldGutter()` was replaced: `lang-markdown` folds any block but headings
   * and lists, so a three-line paragraph folded from first line to last.
   */
  it('offers nothing on a line whose neighbours are level with it', () => {
    expect(fold('one\ntwo\nthree\n', 1)).toBeNull()
    expect(fold('- a\n- b\n- c\n', 1)).toBeNull()
  })

  it('stops at the first line back at its own indentation', () => {
    const doc = '- outer\n  - inner\n- next\n  - other\n'
    // Ends at the close of ` - inner`, not at the second nested item below.
    expect(fold(doc, 1)).toEqual({ from: 7, to: 17 })
  })

  it('carries a blank line inside the block rather than closing on it', () => {
    const doc = '- outer\n\n  - inner\n- next\n'
    expect(fold(doc, 1)?.to).toBe(18)
  })

  /**
   * A daily note's shape: a stamped line, then its bullets, not indented
   * in the file. They belong to the line above, so that line folds them.
   */
  it('folds the list that follows a line, indented or not', () => {
    const doc = '12:08 - reading\n- one\n- two\n12:20 - next\n'
    // Through the end of `- two`, stopping before the next stamped line.
    expect(fold(doc, 1)?.to).toBe(27)
    expect(fold(doc, 4)).toBeNull()
  })

  it('does not let one bullet swallow its siblings', () => {
    // A list line only folds what is indented under it, or every
    // item in a flat list would fold the rest.
    expect(fold('- a\n- b\n- c\n', 1)).toBeNull()
    expect(fold('- a\n- b\n- c\n', 2)).toBeNull()
  })

  it('offers nothing on a blank line', () => {
    expect(fold('- a\n\n  - b\n', 2)).toBeNull()
  })

  /**
   * The arrow survives the fold. Once folded, the block starting at the fold reached
   * the end of everything inside it, so asking about its last line found nothing nested
   * and the arrow vanished. `foldMarkerFor` takes the block's start and finds the line.
   */
  it('keeps the arrow, turned, once the block is folded', () => {
    const doc = '- outer\n  - inner\n  - also\n- next\n'
    const state = EditorState.create({ doc, extensions: [codeFolding()] })
    const line = state.doc.line(1)

    expect(foldMarkerFor(state, line.from)).toEqual({ folded: false })

    const folded = state.update({
      effects: foldEffect.of(indentRange(state, line.from, line.to)!),
    }).state
    // The line still has an arrow, now pointing the other way.
    expect(foldMarkerFor(folded, line.from)).toEqual({ folded: true })
    // Asking with the folded block's own `to` used to answer nothing.
    expect(foldMarkerFor(folded, state.doc.line(3).to)).toBeNull()
  })
})

/**
 * A fold is one unit to the cursor, so a delete that reached it took every line it
 * hid: a heading and its five lines went with one key, unseen. Now the fold opens and
 * the key does nothing, so what was about to go is seen first. Through the keymap.
 */
describe('a key at a folded block', () => {
  const doc = 'before\n#diet\n     08:40 #food oats\n     09:00 #food tea\nafter'
  const folded = () => {
    const { container } = render(<MarkdownEditor initialMarkdown={doc} onChange={() => {}} />)
    const view = viewOf(container)
    const head = view.state.doc.line(2)
    const range = indentRange(view.state, head.from, head.to)!
    view.dispatch({ effects: foldEffect.of(range) })
    return { view, range }
  }
  const hasFold = (view: EditorView) => foldMarkerFor(view.state, view.state.doc.line(2).from)?.folded

  it('opens the fold on Backspace after it, and deletes nothing', () => {
    const { view, range } = folded()
    view.dispatch({ selection: { anchor: range.to } })
    fireEvent.keyDown(view.contentDOM, { key: 'Backspace' })
    expect(view.state.doc.toString()).toBe(doc)
    expect(hasFold(view)).toBe(false)
    // Open, the next Backspace takes one character, as anywhere else.
    fireEvent.keyDown(view.contentDOM, { key: 'Backspace' })
    expect(view.state.doc.toString()).toBe(doc.replace('tea', 'te'))
  })

  it('opens the fold when its line is deleted to its start, and deletes nothing', () => {
    const { view, range } = folded()
    view.dispatch({ selection: { anchor: range.to } })
    fireEvent.keyDown(view.contentDOM, { key: 'Backspace', metaKey: true })
    expect(view.state.doc.toString()).toBe(doc)
    expect(hasFold(view)).toBe(false)
  })

  it('still lets the heading’s own words go, before the fold', () => {
    const { view, range } = folded()
    view.dispatch({ selection: { anchor: range.from } })
    fireEvent.keyDown(view.contentDOM, { key: 'Backspace' })
    expect(view.state.doc.toString()).toBe(doc.replace('#diet', '#die'))
    expect(hasFold(view)).toBe(true)
  })
})

/**
 * A guide down each step of an indent, marked on the spaces. The prose
 * face is proportional, so a step has no width to compute; a mark over
 * the spaces starts where they do, and the sheet draws its left edge.
 */
describe('the indent guides', () => {
  /** The step is the subject here, so it is stated. */
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
    // One indented line under its parent: a trunk half a line
    // long and the elbow into it.
    expect(guides('- outer\n    - inner\n')).toEqual([
      'cm-md-guide cm-md-guide-end cm-md-elbow@8-12',
    ])
    // Two steps in: the outer trunk also ends here, since nothing below is in it.
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
    // One blank line inside a list does not end it, so the trunk does not stop there.
    expect(guides('- outer\n    - one\n\n    - two\n')[0]).toBe('cm-md-guide cm-md-elbow@8-12')
  })

  it('marks whole steps only', () => {
    // Three spaces at a step of four is not a level. Two steps of two is two levels.
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

    // The second press, over the selection the first left.
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

  /** Removing is the toggle, as in Obsidian; there is no separate clear. */
  it('is undone by the same toggle the shortcut uses', () => {
    expect(run(toggleMarker('**'), stateOf('the **plan** here', 6, 10)).doc).toBe('the plan here')
  })
})

/**
 * `---` is a line and still three characters. The trap is the property
 * block: it opens with `---`, which the parser reads as a rule, so drawing
 * every rule would replace the first line of every note with properties.
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
   * `---` under a paragraph is a setext heading underline in
   * CommonMark (the paragraph becomes an H2), not a `HorizontalRule`,
   * so nothing drew it. `___` cannot underline a heading.
   */
  it('draws a line for dashes typed straight under a line of text', () => {
    expect(all(stateOf('Some text\n---\nafter', 0))).toEqual(['rule@10-13'])
    expect(all(stateOf('Some text\n---\nafter', 11))).toEqual(['cm-md-marker@10-13'])
  })

  /**
   * A single `-` drew a line: a setext underline is one or more dashes.
   * A lone `-` starts a list item, so lists under a line of text broke.
   */
  it('needs three dashes, not one', () => {
    expect(all(stateOf('Some text\n-\nafter', 0))).toEqual([])
    expect(all(stateOf('Some text\n--\nafter', 0))).toEqual([])
    expect(all(stateOf('Some text\n---\nafter', 0))).toEqual(['rule@10-13'])
    // Four is still a divider, as with a blank line above.
    expect(all(stateOf('Some text\n----\nafter', 0))).toEqual(['rule@10-14'])
  })

  /**
   * With a rule drawn for a lone `-`, typing `- ` put a full-width widget on the
   * line and the caret dropped below it. A list marker must survive being typed.
   */
  it('leaves a dash that is starting a list alone', () => {
    expect(all(stateOf('Some text\n- \nafter', 12))).toEqual([])
    expect(all(stateOf('Some text\n- one\nafter', 15))).toEqual([])
    expect(all(stateOf('Some text\n\n- \nafter', 13))).toEqual([])
  })

  it('needs the line to hold nothing but the break', () => {
    expect(all(stateOf('Some text\n--- see below\nafter', 0))).toEqual([])
    // Spaced apart is still a break: CommonMark allows spaces
    // between the characters, so `- - -` is one.
    expect(all(stateOf('above\n\n- - -\n\nbelow', 0))).toEqual(['rule@7-12'])
  })

  /**
   * The property block's own pair draws too. The opening `---`
   * is a `HorizontalRule` and the closing one is a setext
   * underline under the last property, so both must be claimed.
   */
  /**
   * As fences, not dividers: a hairline, and only for the block's
   * own pair. A `---` in the prose below is still the rule.
   */
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
 * A property's name, marked so the sheet can give it the clock's
 * colour. Without the mark, nothing in the dim block reads as a label.
 */
/**
 * A block property's name hides while the line is read: `amount:: 480` shows
 * `480`; with the caret on the line the name comes back as a marker. Not in
 * code, and not in the page's own block, whose names are marked instead.
 */
describe('a block property', () => {
  const doc = 'icon:: book\n\n08:10 lunch amount:: 480 at:: [[Harbour Bistro]]\n`x:: 1`\n'
  // `08:10 lunch ` is 12 long, and the line starts at 13.
  const line = 13

  it('hides its name while the caret is elsewhere, and marks it with the caret on the line', () => {
    const away = all(stateOf(doc, 0))
    expect(away).toContain(`hidden@${line + 12}-${line + 21}`)
    expect(away).toContain(`hidden@${line + 25}-${line + 30}`)
    const on = all(stateOf(doc, line + 3))
    expect(on).toContain(`cm-md-marker@${line + 12}-${line + 21}`)
    expect(on).toContain(`cm-md-marker@${line + 25}-${line + 30}`)
  })

  // Types from `.config/properties.json`, which the editor reads through a facet.
  const typed = (doc: string, caret: number) =>
    EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      extensions: [markdown({ base: markdownLanguage }), propertyTypes.of(() => ({ amount: { type: 'number' } }))],
    })

  it('hides a quoted value’s quotes with its name, and brings both back on the line', () => {
    const quoted = 'intro\n\nlunch note:: "two burgers" and a coke\n'
    const at = quoted.indexOf('note::')
    expect(all(typed(quoted, 0))).toEqual(
      expect.arrayContaining([`hidden@${at}-${at + 8}`, `hidden@${at + 19}-${at + 20}`])
    )
    expect(all(typed(quoted, at + 2))).toEqual(
      expect.arrayContaining([`cm-md-marker@${at}-${at + 8}`, `cm-md-marker@${at + 19}-${at + 20}`])
    )
  })

  it('keeps the name of a value that is not of its type, marked, caret or not', () => {
    const wrong = 'intro\n\nlunch amount:: about 1200\n'
    const at = wrong.indexOf('amount::')
    for (const caret of [0, at + 2]) {
      const spans = all(typed(wrong, caret))
      expect(spans).toContain(`cm-md-property-invalid@${at}-${at + 9}`)
      expect(spans.some((span) => span.startsWith(`hidden@${at}-`))).toBe(false)
    }
  })

  it('leaves code and the page block alone', () => {
    const spansOf = all(stateOf(doc, 0))
    const codeLine = doc.indexOf('`x::')
    expect(spansOf.some((span) => span === `hidden@${codeLine + 1}-${codeLine + 5}`)).toBe(false)
    expect(spansOf.some((span) => span.startsWith('hidden@0-'))).toBe(false)
  })
})

describe('a property in the block at the top', () => {
  const properties = (doc: string, caret: number) =>
    all(stateOf(doc, caret)).filter((span) => span.startsWith('cm-md-property'))

  it('marks the name of each property', () => {
    expect(properties('---\nicon: compass\ndate: 2026-09-12\n---\n\nbody\n', 44)).toEqual([
      'cm-md-property@4-8',
      'cm-md-property@18-22',
    ])
  })

  // The `key:: value` form, which the app writes, is marked the same way.
  it('marks a block written as key:: value, and each name in it', () => {
    const doc = 'icon:: compass\npath:: Areas/Plans\n\nbody\n'
    expect(all(stateOf(doc, 36))).toContain('cm-md-frontmatter@0-33')
    expect(properties(doc, 36)).toEqual(['cm-md-property@0-4', 'cm-md-property@15-19'])
  })

  // As in `properties.ts`: an indented key belongs to the key above it.
  it('leaves an indented key alone', () => {
    expect(properties('---\nmeta:\n  nested: yes\n---\n\nbody\n', 30)).toEqual([
      'cm-md-property@4-8',
    ])
  })

  // The fences are not properties, and neither is prose below the block.
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
   * A range reads as one stamp: `12:00 to 12:30` is one time,
   * and marking half would leave the rest looking like prose.
   */
  it('marks a range as one stamp', () => {
    expect(all(stateOf('12:00 to 12:30 standup\n', 0))).toEqual(['cm-md-stamp@0-14'])
    expect(all(stateOf('9:05 - 9:20 walk\n', 0))).toEqual(['cm-md-stamp@0-11'])
    // An en dash, which autocorrect gives.
    expect(all(stateOf('12:00 – 12:30 lunch\n', 0))).toEqual(['cm-md-stamp@0-13'])
  })

  it('leaves a time inside a sentence alone', () => {
    // Anchored to the line start, or every duration in a note would be marked.
    expect(all(stateOf('the train at 12:08 was late\n', 0))).toEqual([])
  })

  /**
   * And nothing else on the line: extra space above a clock's
   * line made the time look larger.
   */
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
   * A bullet before it means no stamp: `- 12:08 note` is a list
   * item that opens with a time.
   */
  it('does not mark a stamp that a bullet comes before', () => {
    expect(all(stateOf('- 12:08 note\n', 0))).toEqual([])
  })
})

describe('a click on a link', () => {
  /**
   * A note whose last word is a link, clicked in the space to its right to
   * put the caret at the end, opened the link: `posAtCoords` returns the
   * nearest position, inside the link. jsdom has no layout, so this tests
   * the check the handler now makes first: what the click landed on.
   */
  it('is a link click only when it lands on the link', () => {
    const line = document.createElement('div')
    line.className = 'cm-line'
    line.innerHTML =
      'the last word is a <span class="cm-md-link">[[Pingbird Notes]]</span>'
    const link = line.querySelector('.cm-md-link')!

    expect(isLinkClick(link)).toBe(true)
    // A click past the end of the text lands on the line itself.
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
 * A tag's properties, offered on its line: all of them once
 * `#expense ` is typed, then narrowed as a name is typed, each
 * written `name:: ` by Tab. Enter over one makes a new line.
 */
describe('the properties a tag’s line is offered', () => {
  const TAGS = { expense: { properties: ['currency', 'amount', 'merchant'] } }
  const TYPES = { amount: { type: 'number' }, merchant: { type: 'backlink' } }
  const offered = (doc: string, at = doc.length) => {
    const state = stateOf(doc, at)
    const result = propertySource(() => TAGS, () => TYPES)({ state, pos: at, explicit: false } as never)
    return result && { from: result.from, options: result.options.map((one) => [one.label, one.detail, one.apply]) }
  }

  it('offers every property straight after the tag, each with its type', () => {
    expect(offered('08:40 #expense ')).toEqual({
      from: 15,
      options: [
        ['currency', 'text', 'currency:: '],
        ['amount', 'number', 'amount:: '],
        ['merchant', 'backlink', 'merchant:: '],
      ],
    })
  })

  it('offers them again as a name is typed, from its start, less the ones the line has', () => {
    expect(offered('08:40 #expense spent currency:: [[EUR]] am')).toEqual({
      from: 40,
      options: [
        ['amount', 'number', 'amount:: '],
        ['merchant', 'backlink', 'merchant:: '],
      ],
    })
  })

  it('offers nothing while a value is typed, on a line with no tag, or for a tag with no structure', () => {
    expect(offered('08:40 #expense amount:: 12')).toBeNull()
    expect(offered('08:40 #expense detail:: "two bu')).toBeNull()
    expect(offered('08:40 #expense merchant:: [[Harbour Bi')).toBeNull()
    expect(offered('08:40 lunch with Mira ')).toBeNull()
    expect(offered('08:40 #travel ')).toBeNull()
    // With nothing typed, only right after the tag, not after every space.
    expect(offered('08:40 #expense lunch ')).toBeNull()
  })

  /**
   * Through the real keymap: the popup opened on a mounted editor, then the
   * key. A popup ignores keys for its first 75ms (`interactionDelay`), so
   * the clock is moved past it; sooner, Enter makes a new line regardless.
   */
  async function popupOver(doc: string) {
    const { container } = render(
      <MarkdownEditor initialMarkdown={doc} onChange={() => {}} notes={NOTES} tagStructures={TAGS} propertyTypes={TYPES} />
    )
    const view = viewOf(container)
    view.dispatch({ selection: { anchor: doc.length } })
    startCompletion(view)
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
    const opened = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(opened + 1000)
    return view
  }
  afterEach(() => vi.restoreAllMocks())

  it('writes the name on Tab', async () => {
    const view = await popupOver('08:40 #expense ')
    fireEvent.keyDown(view.contentDOM, { key: 'Tab' })
    expect(view.state.doc.toString()).toBe('08:40 #expense currency:: ')
  })

  it('starts a new line on Enter, and writes no name', async () => {
    const view = await popupOver('08:40 #expense ')
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(view.state.doc.toString()).toBe('08:40 #expense \n')
    expect(completionStatus(view.state)).toBeNull()
  })

  it('leaves Enter taking any other popup’s pick: a note from `[[`', async () => {
    const view = await popupOver('see [[Roadm')
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect(view.state.doc.toString()).toBe('see [[Roadmap]]')
  })
})

/**
 * A one-line editor (a timeline entry) through the real keymap: Enter, Escape and
 * leaving go to the caller unless a popup is open, whose Enter comes first. No gutters.
 */
describe('an editor over one line', () => {
  afterEach(() => vi.restoreAllMocks())
  const mounted = (doc: string) => {
    const done: string[] = []
    const cancelled: true[] = []
    const left: string[] = []
    const { container } = render(
      <MarkdownEditor
        initialMarkdown={doc}
        caretAtEnd
        notes={NOTES}
        onChange={() => {}}
        line={{ onEnter: (text) => done.push(text), onEscape: () => cancelled.push(true), onLeave: (text) => left.push(text) }}
      />
    )
    return { view: viewOf(container), container, done, cancelled, left }
  }

  it('is done on Enter, with the line as it stands, and makes no second line', () => {
    const { view, done } = mounted('09:00 standup')
    view.dispatch({ changes: { from: 13, insert: ', late' } })
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect([done, view.state.doc.toString()]).toEqual([['09:00 standup, late'], '09:00 standup, late'])
  })

  it('hands Escape and leaving it to the caller, each on its own', () => {
    const escaped = mounted('09:00 standup')
    fireEvent.keyDown(escaped.view.contentDOM, { key: 'Escape' })
    expect([escaped.done, escaped.cancelled, escaped.left]).toEqual([[], [true], []])
    const gone = mounted('10:00 review')
    fireEvent.blur(gone.view.contentDOM)
    expect([gone.done, gone.left]).toEqual([[], ['10:00 review']])
  })

  it('lets an open popup take Enter first', async () => {
    const { view, done } = mounted('see [[Roadm')
    startCompletion(view)
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
    expect([view.state.doc.toString(), done]).toEqual(['see [[Roadmap]]', []])
  })

  it('has no gutters, where a note has its line numbers', () => {
    expect(mounted('09:00 standup').container.querySelector('.cm-gutters')).toBeNull()
    const { container } = render(<MarkdownEditor initialMarkdown="09:00 standup" onChange={() => {}} />)
    expect(container.querySelector('.cm-lineNumbers')).not.toBeNull()
  })
})

/**
 * Following a link takes one press. With `click`, pressing a link moved
 * the caret in, the syntax showed, and the pressed span was replaced
 * before the release, so no click fired. So this drives the events, not
 * the handler; a test calling the handler directly passed all along.
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

    // A press and a release and no click, since the pressed element is gone by then.
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

  /**
   * Only a plain left press follows a link: the right button is
   * the menu's, and modifiers are the platform's.
   */
  it('leaves the other buttons and the modifiers alone', () => {
    const { opened, container } = mounted('See [[Roadmap]] today.\n')
    const link = container.querySelector('.cm-md-link') as HTMLElement
    fireEvent.mouseDown(link, { button: 2, detail: 1 })
    fireEvent.mouseDown(link, { button: 0, detail: 1, metaKey: true })
    fireEvent.mouseDown(link, { button: 0, detail: 1, altKey: true })
    expect(opened).toEqual([])
  })

  /** Pressing a note's text places a caret; it does not follow a link. */
  it('does nothing when the press is not on a link', () => {
    const { opened, container } = mounted('Just a sentence with no link in it.\n')
    fireEvent.mouseDown(container.querySelector('.cm-line') as HTMLElement, {
      button: 0,
      detail: 1,
    })
    expect(opened).toEqual([])
  })
})


import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SCHEMES } from '../settings'

/**
 * Rules the stylesheet has to keep, checked by reading it.
 *
 * These exist because **jsdom lays nothing out**: every test in this project can
 * pass while the app renders wrong, and the geometry bugs found this way have all
 * been found by the user looking at the window. What can be checked without a
 * layout engine is the *text* of the sheet, so what is here is the shape of a
 * mistake rather than the size of a box.
 */
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

/** Every `selector { … }` in the sheet, comments stripped. */
function rules(): { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim().replace(/\s+/g, ' '),
    body: m[2],
  }))
}

describe('the two kinds of tree row', () => {
  /**
   * **One height, declared once, for both** — and it is the note's own leading,
   * `--row-h`, with no constant beside it. A folder row holds an arrow and a `+`
   * and a leaf row holds neither, so a small line height took the leaf row down to
   * its text while the controls held the folder row up: measured in Chrome at
   * line-height 1.55, folder 24.00 against leaf 22.47. There was a 24px floor here
   * for that, which at the default size sat within 0.05px of the leading and so
   * quietly *became* the rhythm of both panes; the controls stretch instead, and
   * every pane that draws a row reads this one token.
   *
   * Checked as text because a height is geometry: the numbers came out of Chrome,
   * across line heights 1.20 to 2.20, and all this can hold is that the two
   * selectors are still in one rule reading the derived token.
   */
  /** **The two gaps stay two.** A row's gap is the panes' setting and a line's is
   *  the note's; one token for both is what this refuses. */
  it('space rows by the row gap, and the note’s lines by the line gap', () => {
    const rows = rules().find(
      (rule) =>
        rule.selector.includes('.folder-header') && /margin-bottom:/.test(rule.body)
    )
    // The two pixels are the hover box bleeding into the gap; the pitch is the
    // setting's, which is what `max(…, 0px)` keeps true at a zero gap.
    expect(rows!.body).toMatch(
      /margin-bottom:\s*max\(var\(--row-gap\) - var\(--row-bleed\), 0px\)/
    )
    const lines = rules().find((rule) => rule.selector.endsWith('.cm-line'))
    // The line gap is the bottom of the shorthand; the sides are the prose inset,
    // which lives here because the drawn selection is measured against *the line's*
    // padding — see the rule's own comment.
    expect(lines!.body).toMatch(/padding:\s*0 var\(--column-pad\) var\(--line-gap\)/)
  })

  /**
   * **The prose inset is the line's, and the selection band is why.**
   * `rectanglesForRange` in `@codemirror/view` computes a band as `contentDOM`'s
   * rect minus *the first `.cm-line`'s* horizontal padding. With the inset on
   * `.cm-content` nothing was subtracted, so a selection crossing two lines painted
   * the whole content box — measured at a 560px pane, 0–560 against a text column of
   * 40–520. Pinned at both ends: the inset on the line, and not on the content.
   */
  /**
   * **A glyph wrapped in a span is as tall as its line, not as itself.** The fold
   * marker's DOM is a `<span>` around the SVG, so it inherited the gutter
   * element's line-height — the note's whole line box — and the arrow was centred
   * inside that before the element's padding centred it again. Measured at prose
   * 13.5: a 20.25px span around a 10.30px glyph put the arrow's middle 5.32px
   * below the number's. `display: flex` makes the span the glyph's own height,
   * which is what that padding's arithmetic assumes; after it, 10.12 against a
   * line box centre of 10.12.
   */
  it('makes the fold marker’s span as tall as its glyph', () => {
    const marker = rules().find((rule) =>
      rule.selector.includes('.cm-foldGutter .cm-gutterElement > span')
    )
    expect(marker, 'the fold arrow drifts half a line box without this').toBeTruthy()
    expect(marker!.body).toMatch(/display:\s*flex/)
  })

  it('puts the prose inset on the line, not on the content box', () => {
    const line = rules().find((rule) => rule.selector.endsWith('.cm-line'))!
    expect(line.body).toMatch(/padding:[^;]*var\(--column-pad\)/)
    const content = rules().find((rule) => rule.selector.endsWith('.cm-content'))!
    expect(content.body).toMatch(/padding:\s*0\.75rem 0\b/)
    // A list line overrides the shorthand's left, so it has to carry the inset too
    // or every item sits hard against the gutter.
    const list = rules().find((rule) => rule.selector.endsWith('.cm-line.cm-md-hang'))!
    expect(list.body).toMatch(/padding-left:\s*calc\(var\(--column-pad\) \+/)
  })

  it('take their height from one derived declaration', () => {
    const shared = rules().find(
      (rule) =>
        rule.selector.includes('.folder-header') &&
        rule.selector.includes('button.file-row') &&
        /min-height:\s*var\(--row-h\)/.test(rule.body)
    )
    expect(shared?.selector).toBe('.folder-header, .file-list li > button.file-row')
    // And the token is the leading, not a number of its own.
    expect(css).toMatch(/--row-h:\s*calc\(var\(--line-height-prose\) \* 1em\)/)
    expect(css).not.toMatch(/--row-min/)
  })

  /**
   * **A control's box is `--control`, which *is* `--row-h`.** A height of its own
   * would be a floor under one kind of row and not the other — the arrow stretches
   * for exactly that reason — but the `+` cannot stretch and stay square: a
   * stretched button inside a centred span came out 19.5 wide and 11.95 tall, the
   * letterbox around a square glyph that was reported. Taking the row's own token
   * makes it square *and* the row's height by construction, which is the property
   * stretching was for.
   */
  it('sizes its controls off the row, not off numbers of their own', () => {
    const chevron = rules().find((rule) => rule.selector === '.folder-chevron')!
    expect(chevron.body).toMatch(/align-self:\s*stretch/)
    expect(chevron.body).toMatch(/width:\s*var\(--control\)/)

    const plus = rules().find((rule) => rule.selector === '.folder-actions button')!
    expect(plus.body).toMatch(/width:\s*var\(--control\)/)
    expect(plus.body).toMatch(/height:\s*var\(--control\)/)
    expect(css).toMatch(/--control:\s*var\(--row-h\)/)

    // And no literal length is left in either.
    for (const rule of [chevron, plus]) {
      expect(rule.body, rule.selector).not.toMatch(/:\s*\d+(\.\d+)?(px|rem|em)/)
    }
  })
})

describe('a control that takes the page’s font', () => {
  /**
   * **A form control does not inherit `line-height`.** The UA gives `button`,
   * `input` and friends `normal` — about 1.17 — and it is not the sort of thing
   * that shows up as wrong: it shows up as a row 10px shorter than the line it is
   * supposed to match, four rounds of arithmetic away from being explained.
   *
   * Measured in Chrome before and after the fix: sidebar rows went from 17px (leaf)
   * and 24px (folder, where the 24px action button was the tallest thing left) to
   * 26.81px, which is exactly a line of the note.
   */
  it('declares a line height beside every inherited size', () => {
    // Checked by deleting one `line-height` and watching this fail.
    //
    // **A declared one, not necessarily `inherit`.** The trap is a control with no
    // line-height at all, which the UA then answers with `normal`; an icon button
    // that says `line-height: 1` to centre its glyph in a 24px box has answered the
    // question, and this used to fail it for giving the wrong answer.
    const missing = rules()
      .filter((rule) => /font-size:\s*inherit/.test(rule.body))
      .filter((rule) => !/line-height:/.test(rule.body))
      .map((rule) => rule.selector)
    expect(missing).toEqual([])
  })
})

/**
 * **The field a name is typed into, against the rows around it.**
 *
 * Reported from the running app: the new-note box was "too tightly packed" and the
 * spacing inconsistent. Measured at prose 13, leading 1.5, row gap 5 — a tree row
 * is 19.50 tall and leaves 5 under it, so the pitch is 24.50, and the field was
 * 21.50 with nothing under it: three pixels short of a row and jammed against the
 * next one. It stands a third of a line taller than a row now and leaves the same
 * gap, and a rename in place comes to exactly 24.50 — the border drawn in the gap,
 * a pixel each side, because a bordered box cannot be as short as the line inside
 * it.
 *
 * Checked as text: jsdom lays nothing out, and the numbers above came from Chrome.
 * What this can hold is that both sizes are the settings' and not their own.
 */
/**
 * **A link is underlined and a label is not.** They share `--accent-soft` — the
 * palette's one sanctioned text accent — so the underline is the whole of what
 * separates "this goes somewhere" from "this names something", and it cannot be
 * information that appears only under the pointer.
 */
describe('a link', () => {
  /** **Coloured at rest, underlined on hover.** A thin tinted underline on prose-
   *  coloured text was tried and asked back: a link is read by its colour. */
  it('is the mark’s colour, and takes its underline only under the pointer', () => {
    const link = rules().find((rule) => rule.selector === '.markdown-editor .cm-md-link')!
    expect(link.body).toMatch(/color:\s*var\(--mark\)/)
    expect(link.body).not.toMatch(/text-decoration/)
    const hover = rules().find((rule) =>
      rule.selector.split(',').map((one) => one.trim()).includes('.markdown-editor .cm-md-link:hover')
    )!
    expect(hover.body).toMatch(/text-decoration:\s*underline/)
    // One hover for everything that goes somewhere, said once: the day steps and the
    // welcome's second door wore their own copy of it.
    expect(hover.selector).toContain('.daily-step:hover')
    expect(hover.selector).toContain('.welcome-secondary:hover')
  })

  /** The note's fold arrow was `›`/`⌄` from the reading face in `--text-faint`,
   *  beside a tree whose rows draw an SVG chevron in `--mark`. One glyph now, from
   *  `icons.tsx`, and the gutter takes the chrome's tone. */
  it('shares the tree’s tone with the fold arrow', () => {
    const gutter = rules().find(
      (rule) => rule.selector === '.code-editor .cm-foldGutter .cm-gutterElement'
    )!
    expect(gutter.body).toMatch(/color:\s*var\(--mark\)/)
  })
})

/**
 * **The caret is as tall as the text it is in.** `.cm-cursor` is drawn in its own
 * layer beside the lines, so it inherits the editor's base size and nothing about
 * the line the caret is on: on a heading at 1.55em and in a property block at
 * 0.92em mono, the bar stayed body-sized. `caretScale` in `EditorHost` measures the
 * element the caret sits in — `cm-md-h1`, `cm-md-frontmatter`, or the line itself,
 * probed in that order — and the sheet reads the ratio.
 */
/**
 * **No size in pixels, anywhere.** Every box and every glyph in this app is a
 * multiple of the reading size, because the reading size is a setting: a 15px note
 * icon in a box sized from the type came out clipped the moment the two disagreed,
 * and that is the whole class of bug. Two tokens carry the glyph scale — `--glyph`
 * for one that depicts and `--glyph-sm` for one that points — and `--control` is
 * the square a glyph sits in, which is `--row-h`.
 *
 * A *stroke* is not a size: the caret's `border-left-width` and an SVG's
 * `stroke-width` are hairlines drawn on a grid, and they stay.
 */
describe('sizes', () => {
  const source = readFileSync(new URL('../icons.tsx', import.meta.url), 'utf8')

  it('are absent from the icon components', () => {
    // Each icon reads `GLYPH` or `GLYPH_SM`, so the size lives in the sheet.
    // `stroke-width` is a hairline on a viewBox grid, not a size.
    expect(source).not.toMatch(/(?<!stroke-)width="\d/)
    expect(source).not.toMatch(/height="\d/)
    expect(source.match(/width=\{GLYPH/g)?.length ?? 0).toBeGreaterThan(5)
  })

  /**
   * **A control sized in `em` has to say what its `em` is.**
   *
   * The UA gives a `button` its own 13.33px font-size, so `--control` — which is
   * `1.5em` — came out 20.0 wide on the folder row's arrow *button* and 19.5 on the
   * empty span a leaf row reserves in its place: every row with an arrow sat half a
   * pixel right of every row without one. Reported as a nested note with nothing
   * inside it being out of line with the nested notes around it, and it is the same
   * trap as the 17px row: a form control inherits neither the size nor the leading.
   */
  it('declare a font size on every control sized in em', () => {
    const emToken = /var\(--(control|row-h|field-h|glyph|glyph-sm|hair)\)|\d(\.\d+)?em/
    const offenders = rules()
      .filter((rule) => /\b(button|input|select|textarea)\b/.test(rule.selector))
      // A pseudo-element inherits from what it is drawn on, which this checks.
      .filter((rule) => !rule.selector.includes('::'))
      .filter((rule) => emToken.test(rule.body))
      .filter((rule) => !/font-size\s*:/.test(rule.body))
      .map((rule) => rule.selector)
    expect(offenders).toEqual([])
  })

  /**
   * **No stroke in the components either.** Each glyph states the grid it is drawn
   * on and nothing else; the sheet turns one `--icon-weight` into the stroke that
   * grid needs, so every glyph in the app renders at one thickness and one dial
   * moves them all. The dots are filled rather than stroked and take their radius
   * from the same token — a filled 2-unit circle beside a 1.5-unit stroke is what
   * made the graph and the gear read heavier than the lens.
   */
  it('leave the stroke to the sheet, one weight for every grid', () => {
    expect(source).not.toMatch(/strokeWidth/)
    expect(source).toMatch(/data-grid/)
    for (const grid of ['10', '16', '24']) {
      const rule = rules().find((one) => one.selector === `svg[data-grid='${grid}']`)
      expect(rule, grid).toBeTruthy()
      expect(rule!.body, grid).toMatch(/stroke-width:\s*calc\(var\(--icon-weight\)/)
    }
    const dot = rules().find((one) => one.selector.includes("circle[fill='currentColor']"))!
    expect(dot.body).toMatch(/r:\s*calc\(var\(--icon-weight\)/)
  })

  /**
   * **A box sized in `em` on an element with an `em` of its own has to say so.**
   *
   * `.folder-icon` is the one part of a row that sets a smaller `font-size` — the
   * glyph's — so `--control` (`1.85em`) resolved against 12.42px there and against
   * 13.5px on the arrow beside it: measured, an 18.63 icon column against a 20.25
   * arrow column, in every pane, and the collected lines under a row inherited the
   * same 1.62px. Dividing by the ratio the `font-size` multiplies by states the box
   * in the row's em, which is what makes the two one column.
   *
   * The same trap as the arrow that sat half a pixel right of a leaf's, one element
   * further in — and the rule is the same: **state what your `em` is.**
   */
  it('correct a control box for an element that shrinks its own em', () => {
    for (const rule of rules()) {
      const size = /font-size:\s*var\(--glyph\)/.test(rule.body)
      const box = /(?<![-\w])(width|height):\s*([^;]*var\(--control\)[^;]*)/.exec(rule.body)
      if (!size || !box) continue
      expect(box[2], rule.selector).toMatch(/var\(--glyph-num\)/)
    }
  })

  it('are tokens in the sheet, not pixels', () => {
    const offenders: string[] = []
    for (const rule of rules()) {
      if (rule.selector.startsWith(':root')) continue
      for (const found of rule.body.matchAll(
        /(?<![-\w])((?:min-|max-)?(?:width|height)|font-size)\s*:\s*([^;]*\d(?:px|pt)[^;]*)/g
      )) {
        offenders.push(`${rule.selector} { ${found[1]}: ${found[2].trim()} }`)
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * **The band above the header, and what has to clear it.**
 *
 * `.viewer::before` is a fade band pinned to the top of the scrollport so text
 * disappears gradually as it scrolls up rather than at a hard edge. It is
 * *positioned*, so it paints over the in-flow content beneath it — and it reaches
 * `--header-fade` past the header itself. The editor never noticed, its first line
 * sitting lower; a collection's page begins with a section, and at prose 13.5 the
 * band was opaque to 76px while the heading ran 69.20–89.45, so its top half was
 * painted out. Reported as the heading disappearing into the title.
 *
 * One token, named once and read twice: the band's own height is built from it and
 * the clearance is it, so the two cannot drift.
 */
describe('the header’s fade band', () => {
  /** Two things can be first on the page — a collection's section and a journal
   *  page's row of steps — and the rule names both. */
  it('is cleared by the first section, off the token the band is built from', () => {
    const root = rules().find((rule) => rule.selector === ':root')!
    expect(root.body).toMatch(/--header-fade:/)
    // The band's height names it, so growing the fade grows the clearance with it.
    expect(root.body).toMatch(/--header-h:[^;]*var\(--header-fade\)/)
    // The sum adds the *title's* line box, not the prose's: the title is set on
    // its own two numbers, and the header is as tall as they make it — measured,
    // 72.80 against a sum of 4.55rem.
    expect(root.body).toMatch(/--header-h:[^;]*var\(--title-size\) \* var\(--title-leading\)/)
    const title = rules().find((rule) => rule.selector.startsWith('.viewer-title,'))!
    expect(title.body).toMatch(/font-size:\s*var\(--title-size\)/)
    expect(title.body).toMatch(/line-height:\s*var\(--title-leading\)/)
    // And the band is opaque exactly as far as the header's own bottom edge —
    // derived from the same sum, where it was `4.75rem` worked out by hand.
    const band = rules().find((rule) => rule.selector === '.viewer:has(> .viewer-header)::before')!
    expect(band.body).toMatch(/var\(--bg-viewer\) calc\(var\(--header-h\) - var\(--header-fade\)\)/)

    const clears = rules().find(
      (rule) => rule.selector.startsWith('.viewer > .viewer-header + .note-section')
    )
    expect(clears, 'the first section must clear the band').toBeTruthy()
    expect(clears!.body).toMatch(/padding-top:\s*var\(--header-fade\)/)
  })
})

/**
 * **A gap is one of a few numbers, not any number.**
 *
 * The sheet had 93 literal margins, paddings and gaps across **35 distinct
 * numbers** — 0.42rem beside 0.45rem, 0.3 beside 0.35 beside 0.4, 0.5em beside
 * 0.55em — and nobody chose those apart. Each was picked by eye for one rule and
 * never compared with the one next to it, which is how a pane ends up almost
 * aligned with itself.
 *
 * They were snapped to their nearest common neighbour, never moving more than
 * 0.8px, and this keeps the set closed: a new rule picks one of these or changes
 * the list on purpose. Not a scale of `--space-1…8` tokens — sixteen names for
 * numbers whose only relationship is *being a gap* is more machinery than the
 * problem, and this sheet names a token per **job** (`--pane-inset`, `--icon-gap`,
 * `--row-gap`, `--marker-gap`) rather than per size.
 *
 * `:root` is where the tokens are defined, and `.viewer-header`'s padding is the
 * sum `--header-h` is built from — both are excluded, and both are read elsewhere
 * in this file.
 */
describe('spacing', () => {
  const SPACING = /(?<![-\w])((?:margin|padding|gap|inset|top|right|bottom|left)(?:-[a-z]+)?)\s*:\s*([^;]+)/g
  const LENGTH = /(?<![\w.-])(\d*\.?\d+)(px|rem|em)\b/g
  const ALLOWED = new Set([
    // `rem`, for the chrome: a pane, a banner, a menu, a button.
    '0.05rem', '0.15rem', '0.25rem', '0.4rem', '0.5rem', '0.6rem', '0.75rem',
    '0.85rem', '1rem', '2rem',
    // `em`, for anything typed off its own size — the settings panel, and the
    // marks inside the editor's prose.
    '0.15em', '0.35em', '0.5em', '0.75em', '0.9em', '1em', '1.18em', '1.6em', '2.4em',
    // Hairlines and the resizer's own two pixels, which are lines and not gaps.
    '1px', '2px',
  ])

  it('uses one of a few numbers for every gap', () => {
    const offenders: string[] = []
    for (const rule of rules()) {
      if (rule.selector.startsWith(':root') || rule.selector.includes('.viewer-header')) continue
      for (const [, prop, value] of rule.body.matchAll(SPACING)) {
        for (const [, number, unit] of value.matchAll(LENGTH)) {
          if (number === '0') continue
          const length = `${Number(number)}${unit}`
          if (!ALLOWED.has(length)) offenders.push(`${rule.selector} { ${prop}: ${length} }`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /** And the set stays small: it is 21 now, and a list that grows every time a
   *  rule is written is not a set of choices, it is the free-for-all again. */
  it('keeps the set of numbers small', () => {
    expect(ALLOWED.size).toBeLessThanOrEqual(24)
  })

  /**
   * **And the one place that styles outside this sheet obeys it too.**
   *
   * The `[[` picker is a CodeMirror theme rather than CSS — twice it was written as
   * rules here and twice CodeMirror's own late-injected base theme beat them — and
   * that exemption quietly became a second set of numbers: a `4px` radius beside the
   * sheet's token, a `0.85em` step-down beside the sheet's one at `0.92em`, and two
   * paddings in numbers nothing else uses. Moving the cascade is not a licence to
   * invent sizes, so the same set is read over that block.
   */
  it('holds the completion theme to the same numbers', () => {
    const theme = readFileSync(new URL('../editorComplete.ts', import.meta.url), 'utf8')
    const block = /completionAppearance = EditorView\.theme\(\{([\s\S]*?)\n\}\)/.exec(theme)
    expect(block, 'the theme block').toBeTruthy()
    const offenders: string[] = []
    for (const [, prop, value] of block![1].matchAll(
      /(\w+):\s*'([^']*)'/g
    )) {
      if (!/^(padding|margin|gap|inset|top|right|bottom|left|borderRadius)$/i.test(prop)) continue
      for (const [, number, unit] of value.matchAll(LENGTH)) {
        if (number === '0') continue
        const length = `${Number(number)}${unit}`
        if (!ALLOWED.has(length)) offenders.push(`${prop}: ${length}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the caret', () => {
  /** CodeMirror writes the bar's top and height inline from the glyph box under
   *  the head, per line. A fixed height and a re-centring margin here double-counted
   *  the half-leading and put the caret 1.43px low — measured. Colour and width only. */
  it('leaves its height and its offset to the editor', () => {
    const caret = rules().find((rule) => rule.selector.includes('.cm-cursor'))!
    expect(caret.body).not.toMatch(/height:|margin-top:/)
    expect(css).not.toMatch(/--caret-h|--caret-scale/)
  })
})

/**
 * **The open row is coloured, not filled.** A ground behind it was a second shape
 * in a pane of rows of text, inside a hover box that is already a ground — the name
 * takes the app's one mark colour and a weight instead, which is what a property's
 * name and a section's heading do.
 */
describe('the open row', () => {
  /**
   * **A nested note renders like a note.** Its row carried `font-weight: 500`
   * against a leaf's 400 — a second way of saying "this one is different" on top of
   * the arrow it already has, and it took the weight the *open* row uses.
   */
  it('is the only row with a weight of its own', () => {
    // `inherit` is the point, not an exception: the weight is a setting on the
    // pane and a control has to be told to take it, the way it is told the size.
    const rowish = /\.folder-toggle|\.folder-header|\.file-row|\.note-row|\.row-name/
    for (const rule of rules()) {
      if (!rowish.test(rule.selector) || rule.selector.includes('selected')) continue
      // A section's heading at the end of a note is a *label*, not a row's name:
      // it shares the app's one label rule with a property's name and the clock.
      if (/\.cm-md-|\.note-section/.test(rule.selector)) continue
      const weight = /font-weight:\s*([^;]+)/.exec(rule.body)?.[1].trim()
      expect(weight ?? 'inherit', rule.selector).toBe('inherit')
    }
  })

  /** **And no other box either.** A pressed icon button in the pane — the section
   *  the rail is showing, the graph's toggle — said so with a `--bg-active` ground,
   *  the same second shape the open row had. An icon has no text to embolden, so it
   *  takes the accent and a heavier stroke instead. */
  it('marks a pressed control by weight, not by a ground', () => {
    const pressed = rules().find(
      (rule) => rule.selector === ".sidebar-actions > button[aria-pressed='true']"
    )!
    expect(pressed.body).not.toMatch(/background:/)
    expect(pressed.body).toMatch(/color:\s*var\(--accent-soft\)/)
    const glyph = rules().find(
      (rule) => rule.selector === ".sidebar-actions > button[aria-pressed='true'] svg"
    )!
    expect(glyph.body).toMatch(/stroke-width:\s*var\(--stroke-on\)/)
  })

  it('marks its name rather than painting the row', () => {
    const name = rules().find((rule) => rule.selector.includes('.selected .row-name'))!
    expect(name.body).toMatch(/color:\s*var\(--mark\)/)
    expect(name.body).toMatch(/font-weight:/)
    // And no *row* paints itself any more. The icon picker's grid still fills its
    // chosen cell, which is a different question: sixty-three glyphs and no names.
    for (const rule of rules()) {
      const rowish = /\.file-list|\.folder-header|\.note-row/.test(rule.selector)
      if (!rowish || !rule.selector.includes('selected')) continue
      expect(rule.body, rule.selector).not.toMatch(/background:\s*var\(--bg-active\)/)
    }
  })
})

describe('a name typed in place', () => {
  const field = () => rules().find((rule) => rule.selector === '.rename-input')!
  const inRow = () => rules().find((rule) => rule.selector === '.rename-input.rename-in-row')!

  it('takes its height and its gap from the pane, not from numbers of its own', () => {
    expect(field().body).toMatch(/min-height:\s*calc\(var\(--row-h\) \+ [\d.]+em\)/)
    expect(field().body).toMatch(/margin-bottom:\s*var\(--row-gap\)/)
  })

  it('keeps a row’s pitch when it stands in for one', () => {
    expect(inRow().body).toMatch(/min-height:\s*var\(--row-h\)/)
    // The two pixels of border go where the gap already is.
    expect(inRow().body).toMatch(/margin-top:\s*-1px/)
    expect(inRow().body).toMatch(/margin-bottom:\s*calc\(var\(--row-gap\) - 1px\)/)
  })

  /** The gap under the search box is the field's own, so the search box and the
   *  tree's create box leave the same one. */
  it('is the only thing that spaces the search box', () => {
    const wrapper = rules().find((rule) => rule.selector === '.sidebar-search')!
    expect(wrapper.body).toMatch(/padding:\s*0;/)
  })

  /** A result list with no gap read as one block of text rather than as rows. */
  it('spaces search results by the same gap as rows', () => {
    const hit = rules().find((rule) => rule.selector === '.sidebar-search-hits button')!
    expect(hit.body).toMatch(/margin-bottom:\s*var\(--row-gap\)/)
  })

  /**
   * **The space under the divider is the divider's.**
   *
   * It was `.file-list`'s `margin-top`, which only the rows *inside* the list got —
   * so the search field, a sibling above it, sat 5.6px higher than the same field
   * rendered as the list's first row. Measured in Chrome in all four states after
   * the move — search open, a new note, the plain tree, the Actions pane — the first
   * element starts at y=81.5 and x=9.6 every time.
   */
  it('keeps every box in the pane free of margins of its own', () => {
    const list = rules().find((rule) => rule.selector === '.file-list')!
    expect(list.body).toMatch(/margin:\s*0;/)
    // And the search field's wrapper is a box with nothing in it either.
    const search = rules().find((rule) => rule.selector === '.sidebar-search')!
    expect(search.body).toMatch(/margin:\s*0;/)
    expect(search.body).toMatch(/padding:\s*0;/)
  })

  /**
   * **One inset for every box in the pane's column.** A row was `0.45rem`, the field
   * `0.5rem` and a result `0.25rem` — three numbers for one edge, and the field's
   * text came to rest 0.8px off the rows above it.
   */
  it('insets a row, a field and a result by the same token', () => {
    for (const selector of [
      '.file-list li > button',
      '.rename-input',
      '.sidebar-search-hits button',
    ]) {
      const rule = rules().find((one) => one.selector === selector)!
      expect(rule.body, selector).toMatch(/padding:[^;]*var\(--pane-inset\)/)
    }
  })
})

describe('the settings panel', () => {
  /**
   * **One box, whatever section is open.** The dialog was `max-height`, so it grew
   * and shrank as you moved down the rail — measured in Chrome at 1440x900:
   * Appearance 768x576, Typography 768x576, Shortcuts 768x576, Notes 768x576 with
   * a fixed height, against four different heights before it. A short window still
   * shrinks it: at 1280x520 the dialog is 369 tall and `.settings-content` scrolls
   * (scrollHeight 371 against a 329 box).
   */
  it('gives the dialog a height, not a cap', () => {
    const dialog = rules().find((rule) => rule.selector === '.settings-dialog')
    expect(dialog).toBeTruthy()
    expect(dialog!.body).toMatch(/\bheight:\s*min\(/)
    expect(dialog!.body).not.toMatch(/max-height/)
    // The overflow has to have somewhere to go, or a fixed height clips it.
    const content = rules().find((rule) => rule.selector === '.settings-content')
    expect(content!.body).toMatch(/overflow-y:\s*auto/)
  })

  /**
   * **Every control starts on one x.** Both field kinds declare the same first
   * track, so the shortcut rows line up with the selects and sliders above them.
   * Measured in Chrome: labels end at 659 and every control begins at 675, in all
   * four sections. The keybind rows had their own gap and their own `1fr` label
   * before this, which put the combo at 667 and stretched it to 237px wide.
   */
  /**
   * **Two measurements, and every control reads them.** Before: a select 31.4 tall
   * against a slider row's 20, the rows stepping 27.1, then 32.5, then 23.9, and
   * the slider's track starting 2px right of the select above it (the UA's own
   * margin on a range input). After, measured in Chrome across Typography and
   * Shortcuts: every label at x=205.0, every control at x=346.7, every row 24.0 or
   * 24.7 tall, stepping 31.2.
   */
  it('gives every control one height and one gap', () => {
    const dialog = rules().find((rule) => rule.selector === '.settings-dialog')!
    expect(dialog.body).toMatch(/--field-h:\s*calc\(var\(--row-h\) \+ [\d.]+em\)/)
    expect(dialog.body).toMatch(/--field-gap:/)

    for (const selector of [
      '.settings-select',
      '.settings-text-input',
      '.settings-keybind',
      '.settings-swatch',
      '.settings-slider',
    ]) {
      const rule = rules().find((one) => one.selector === selector)!
      expect(rule.body, selector).toMatch(/min-height:\s*var\(--field-h\)/)
    }

    const section = rules().find((rule) => rule.selector === '.settings-section')!
    expect(section.body).toMatch(/gap:\s*var\(--field-gap\)/)
  })

  /** The UA gives a range input its own horizontal margin, which put every track
   *  two pixels right of the select above it. */
  it('takes the platform’s margin off the slider', () => {
    const slider = rules().find(
      (rule) => rule.selector === ".settings-slider input[type='range']"
    )!
    expect(slider.body).toMatch(/margin:\s*0/)
    // A track of our own is not painted half-full by WebKit; the fill comes in from
    // the component that knows the value.
    const track = rules().find((rule) => rule.selector.includes('slider-runnable-track'))!
    expect(track.body).toMatch(/var\(--fill/)
  })

  it('lays both kinds of field on the same label column', () => {
    const field = rules().find((rule) => rule.selector === '.settings-field')
    const keybind = rules().find(
      (rule) => rule.selector === '.settings-field:has(.settings-keybind)'
    )
    const track = (body: string) => /grid-template-columns:\s*([^;]+)/.exec(body)?.[1].trim()
    expect(track(field!.body)).toBeTruthy()
    expect(track(keybind!.body)).toBeTruthy()
    expect(track(keybind!.body)!.split(/\s+/)[0]).toBe(track(field!.body)!.split(/\s+/)[0])
    // An `auto` track would take a share of the leftover row instead.
    expect(keybind!.body).toMatch(/justify-content:\s*start/)
  })
})

describe('a JSON file’s colour', () => {
  /**
   * **Every colour follows the scheme.** There are ten palettes and a light and a
   * dark mode, so a literal hex in here is a colour that is right in one of twenty
   * combinations and wrong in the rest. Keys take `--accent-soft` at full strength,
   * a value takes a mix of it, and the brackets take the three text tiers by depth
   * — measured in Chrome, dark and light, all seven distinct from each other and
   * from the prose around them.
   */
  it('names no colour of its own', () => {
    const json = rules().filter((rule) => rule.selector.includes('.cm-json-'))
    expect(json.length).toBeGreaterThan(4)
    for (const rule of json) {
      for (const [, value] of rule.body.matchAll(/color:\s*([^;]+)/g)) {
        expect(value).toMatch(/var\(--|color-mix\(/)
        expect(value).not.toMatch(/#[0-9a-f]{3}|rgba?\(|hsl\(/i)
      }
    }
  })
})

describe('a list’s own indent', () => {
  /**
   * **The hanging indent has to outrank `.cm-line`'s `padding` shorthand.**
   *
   * `.markdown-editor .cm-editor .cm-line` sets `padding` at (0,3,0). At (0,2,0)
   * the list rule's `padding-left` was reset to zero while its `text-indent`
   * applied, which pulled every list line's first row a step *left* of the margin
   * — measured in Chrome as padding-left 0px against text-indent -14.46px.
   *
   * Checked as text because specificity is not something jsdom can be asked.
   */
  it('is qualified enough to beat the line’s padding shorthand', () => {
    const hanging = rules().find((rule) => rule.selector.includes('.cm-md-hang'))
    expect(hanging).toBeTruthy()
    const classes = (selector: string) => (selector.match(/\.[a-z][\w-]*/g) ?? []).length
    const lineRule = rules().find(
      (rule) => rule.selector.endsWith('.cm-line') && /padding:/.test(rule.body)
    )
    expect(lineRule).toBeTruthy()
    expect(classes(hanging!.selector)).toBeGreaterThan(classes(lineRule!.selector))
    // And after it, since a tie goes to source order.
    expect(css.indexOf(hanging!.selector)).toBeGreaterThan(css.indexOf(lineRule!.selector))
  })

  /**
   * Both markers take one box **one step wide, gap included**, so a bullet's text
   * and a number's land where a line indented one step starts.
   *
   * Measured in Chrome before this was written: with the gap outside the box, a
   * `-` put its text on the grid at 47.16px and a `1.` put its at 51.84px, because
   * the box was `step - gap` = 1.16px and every marker overflowed it. `box-sizing`
   * is what makes "one step, gap included" true, and its absence is the failure.
   */
  it('gives a bullet and a number one box, one step wide', () => {
    const marker = rules().find(
      (rule) => rule.selector.includes('.cm-md-bullet') && rule.selector.includes('.cm-md-number')
    )
    expect(marker).toBeTruthy()
    expect(marker!.body).toMatch(/box-sizing:\s*border-box/)
    expect(marker!.body).toMatch(/min-width:\s*var\(--indent-step\)/)
    expect(marker!.body).toMatch(/padding-right:\s*var\(--marker-gap\)/)
    expect(marker!.body).toMatch(/text-align:\s*right/)
    // The gap can no longer be taken off the box's width: that is what left it
    // 1.16px wide.
    expect(marker!.body).not.toMatch(/margin-right/)
  })

  /**
   * **A side of a `.cm-line`'s padding has to out-specify the shorthand.**
   *
   * `.code-editor .cm-editor .cm-line` sets all four at three classes. A rule
   * setting one side at two lost silently, and `.cm-md-heading-line`'s half-em of
   * air above a heading did exactly that from the day it was written — measured in
   * Chrome, `padding-top: 0px` on a heading line, which is a good part of why a
   * page of prose read as one undifferentiated block.
   */
  it('lets a line’s own rule reach past the padding shorthand', () => {
    const shorthand = rules().find(
      (rule) => /\.cm-line\s*$/.test(rule.selector) && /padding:\s/.test(rule.body)
    )
    expect(shorthand).toBeTruthy()
    const classes = (selector: string) => (selector.match(/\.[a-z][\w-]*/g) ?? []).length
    const floor = classes(shorthand!.selector)
    for (const rule of rules()) {
      if (!rule.selector.includes('cm-line') && !rule.selector.includes('cm-md-')) continue
      if (!/padding-(top|bottom|left|right):/.test(rule.body)) continue
      if (!rule.selector.includes('.cm-line')) continue
      expect(classes(rule.selector), `${rule.selector} loses to the shorthand`).toBeGreaterThanOrEqual(floor)
    }
  })
})

describe('one family', () => {
  /**
   * **One family on a screen, and the hierarchy is size and weight.**
   *
   * A serif display face set the author's `#`/`##`/`###`, the title and the
   * sections at the end of a note, on the argument that a serif over a sans reads
   * as hierarchy rather than as a change of style. It was asked back in three
   * rounds, smallest scope last, and the report each time was the one that had
   * started it: the fonts keep changing. Two families are a hierarchy only to
   * whoever drew the roles. So the set is closed at one and this refuses a second
   * coming back, rather than listing a narrower set of places for a fourth time.
   */
  const HEADINGS = [
    '.markdown-editor .cm-md-h1',
    '.markdown-editor .cm-md-h2',
    '.markdown-editor .cm-md-h3',
  ]

  it('has no display face to set', () => {
    const root = rules().find((rule) => rule.selector === ':root')!
    expect(root.body).not.toMatch(/--font-display/)
    const readers = rules()
      .filter((rule) => /font-family:\s*var\(--font-display\)/.test(rule.body))
      .map((rule) => rule.selector)
    expect(readers).toEqual([])
  })

  /**
   * The weight is load-bearing and not taste: `--fw-prose` is a setting that
   * reaches 600, so a heading at the serif's 500 was *lighter* than the paragraph
   * under it at the top of that range.
   */
  it('sets every heading at the title’s own weight, in no face of its own', () => {
    for (const rule of rules().filter((rule) => HEADINGS.includes(rule.selector))) {
      expect(rule.body, rule.selector).toMatch(/font-weight:\s*var\(--fw-strong\)/)
      expect(rule.body, rule.selector).not.toMatch(/font-family/)
    }
    // `####` and below were already this, and are the reason it is the right weight.
    const deep = rules().find((rule) => rule.selector.includes('.cm-md-h4'))!
    expect(deep.body).toMatch(/font-weight:\s*var\(--fw-strong\)/)
  })

  it('runs a hairline from a section’s heading to the edge of the column', () => {
    const line = rules().find(
      (rule) => rule.selector === '.note-section > .folder-header > .folder-toggle::after'
    )!
    expect(line.body).toMatch(/flex:\s*1/)
    expect(line.body).toMatch(/border-top:\s*1px solid var\(--border\)/)
    // The heading itself is in the text colour, not the mark, and in the reading
    // face: the sections are the note's apparatus, read rather than announced.
    const heading = rules().find((rule) => rule.selector === '.note-section > .folder-header .row-name')!
    expect(heading.body).toMatch(/color:\s*var\(--text\)/)
    expect(heading.body).not.toMatch(/font-family/)
  })
})

/**
 * **A weight is a token, like a duration.** Thirty-one rules carried 600, 500 or
 * 400 as numbers; the three roles are named in `:root` and a rule says which it
 * means, or inherits.
 */
describe('weight', () => {
  it('is a named role wherever a rule sets one', () => {
    for (const rule of rules().filter((one) => one.selector !== ':root')) {
      for (const [, value] of rule.body.matchAll(/font-weight:\s*([^;]+)/g)) {
        expect(value.trim(), rule.selector).toMatch(/^(inherit|var\(--fw-(strong|medium|regular|prose)\))$/)
      }
    }
  })
})

describe('motion', () => {
  /**
   * **One duration, one curve, as a token.** A state change — a hover ground, a
   * glyph taking the mark — takes `--motion` or takes nothing; a literal duration
   * on one rule is a row that fades beside a heading that snaps. And the token is
   * zeroed under `prefers-reduced-motion`, which is the one place it may be set
   * again.
   */
  it('is one token wherever anything transitions', () => {
    for (const rule of rules()) {
      for (const [, value] of rule.body.matchAll(/transition:\s*([^;]+)/g)) {
        expect(value, rule.selector).not.toMatch(/\d+m?s\b/)
        expect(value, rule.selector).toMatch(/var\(--motion\)/)
      }
    }
  })

  it('is switched off for a viewer who asked for none', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{\s*--motion:\s*0s;/)
  })
})

describe('a scheme', () => {
  /**
   * Every scheme the panel offers paints both modes and has a chip in each: the
   * default block is slate, and the others are attribute blocks. A scheme added
   * to `SCHEMES` without its blocks would render in slate's colours and be
   * indistinguishable from it in the panel.
   */
  it('has a dark block, a light block and a swatch in each mode', () => {
    for (const scheme of SCHEMES) {
      if (scheme !== 'slate') {
        for (const theme of ['dark', 'light']) {
          expect(css, `${scheme}/${theme}`).toContain(`:root[data-scheme='${scheme}'][data-theme='${theme}'] {`)
        }
      }
      expect(css, scheme).toContain(`.settings-swatch[data-scheme='${scheme}'] {`)
      expect(css, scheme).toContain(`:root[data-theme='light'] .settings-swatch[data-scheme='${scheme}'] {`)
    }
  })
})

describe('a mark inside a sentence', () => {
  /**
   * **Changes one thing about the text, and never its size.** The clock and the
   * keyword sit in the middle of a journal line; a run set a step smaller there
   * reads as the line being squeezed — reported as "vertically squished" — and a
   * bold run beside a dim one is three formats on one line. Colour only.
   */
  it('keeps the prose’s size and weight', () => {
    for (const cls of ['.cm-md-stamp', '.cm-md-collection']) {
      for (const rule of rules().filter((rule) => rule.selector.includes(cls))) {
        expect(rule.body, rule.selector).not.toMatch(/font-size:/)
        expect(rule.body, rule.selector).not.toMatch(/font-weight:/)
      }
    }
  })
})

describe('the drawn selection', () => {
  /** CodeMirror's base theme lands after this sheet and paints its focused
   *  selection at three classes — the light theme's lavender. Ours has to carry
   *  `.cm-editor` too, or a near-white text sits on a near-white band in dark mode. */
  it('out-specifies the editor’s own colour', () => {
    const rule = rules().find((rule) => rule.selector.includes('.cm-selectionBackground'))!
    expect(rule.selector).toContain('.code-editor .cm-editor.cm-focused .cm-selectionBackground')
    expect(rule.body).toMatch(/background:\s*var\(--bg-active\)/)
  })
})

describe('the left pane', () => {
  /**
   * **One scrollport, and it is the pane's.** The sections stack and their lists
   * grow; `.sidebar-body` is the box that scrolls. It had no rule at all for a
   * build — a plain block in a flex column the pane clips — so a tree taller than
   * the window was cut off with nothing to scroll.
   */
  it('scrolls the body, and no list inside it', () => {
    const body = rules().find((rule) => rule.selector === '.sidebar-body')!
    expect(body.body).toMatch(/overflow-y:\s*auto/)
    expect(body.body).toMatch(/flex:\s*1/)
    // `min-height: 0`, or a flex item's content floor stops it scrolling at all.
    expect(body.body).toMatch(/min-height:\s*0/)
    const list = rules().find((rule) => rule.selector === '.file-list')!
    expect(list.body).toMatch(/overflow:\s*visible/)
    expect(list.body).toMatch(/flex:\s*none/)
  })

  /** A heading holds the top while its own rows pass under it, and no further. */
  it('makes a section’s heading sticky, on the pane’s own ground', () => {
    const heading = rules().find((rule) => rule.selector === '.pane-section > .folder-header')!
    expect(heading.body).toMatch(/position:\s*sticky/)
    expect(heading.body).toMatch(/background:\s*var\(--bg-sidebar\)/)
  })

  /** The rail and the footer are gone from the markup; their rules went with them. */
  it('has no rules left for the rail or the footer', () => {
    expect(css).not.toMatch(/\.sidebar-rail\b/)
    expect(css).not.toMatch(/\.sidebar-footer\b/)
  })
})

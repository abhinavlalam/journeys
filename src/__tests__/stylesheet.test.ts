import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SCHEMES } from '../settings'

/**
 * Rules the stylesheet must keep, checked by reading it. jsdom lays nothing out, so
 * every other test can pass while the app renders wrong. What can be checked without
 * layout is the sheet's text: the shape of a mistake, not the size of a box.
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
   * One height, declared once for both kinds of row: the note's leading,
   * `--row-h`, with no constant beside it. A folder row holds an arrow
   * and a `+` and a leaf row neither, so at a small leading the controls
   * held folder rows taller (24.00 against 22.47 at 1.55). The controls
   * stretch instead. Checked as text; the numbers came from Chrome.
   */
  /**
   * The two gaps stay two: a row's gap is the panes' setting and
   * a line's is the note's.
   */
  it('space rows by the row gap, and the note’s lines by the line gap', () => {
    const rows = rules().find(
      (rule) =>
        rule.selector.includes('.folder-header') && /margin-bottom:/.test(rule.body)
    )
    // The two pixels are the hover box reaching into the gap; the
    // pitch is the setting's, which `max(…, 0px)` keeps at a zero gap.
    expect(rows!.body).toMatch(
      /margin-bottom:\s*max\(var\(--row-gap\) - var\(--row-bleed\), 0px\)/
    )
    const lines = rules().find((rule) => rule.selector.endsWith('.cm-line'))
    // The line gap is the bottom of the shorthand; the sides are the prose inset,
    // here because the drawn selection is measured against the line's padding.
    expect(lines!.body).toMatch(/padding:\s*0 var\(--column-pad\) var\(--line-gap\)/)
  })

  /**
   * The prose inset is the line's, because of the selection. CodeMirror measures a
   * selection band as the content's rect minus the first `.cm-line`'s padding.
   * With the inset on `.cm-content`, a selection across two lines painted the
   * whole box. Checked at both ends: on the line, not on the content.
   */
  /**
   * A glyph wrapped in a span is as tall as its line. The fold marker's
   * `<span>` inherited the line's height, so the arrow was centred twice and
   * sat half a line low. `display: flex` makes the span the glyph's height.
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
    // An indented line's hang sets the left padding, so it must
    // carry the inset too, or the line sits against the gutter.
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
   * A control's box is `--control`, which is `--row-h`. The `+` cannot
   * stretch and stay square: stretched in a centred span it was 19.5
   * by 11.95. The row's own token makes it square and a row tall.
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
   * A form control does not inherit `line-height`. The UA gives
   * buttons and inputs `normal`, about 1.17, which made sidebar
   * rows 17px and 24px where a line of the note is 26.81.
   */
  it('declares a line height beside every inherited size', () => {
    // Checked by deleting one `line-height` and watching this fail.
    //
    // A declared value, not necessarily `inherit`: the trap is a
    // control with none. An icon button saying `line-height: 1`
    // to centre its glyph has answered the question.
    const missing = rules()
      .filter((rule) => /font-size:\s*inherit/.test(rule.body))
      .filter((rule) => !/line-height:/.test(rule.body))
      .map((rule) => rule.selector)
    expect(missing).toEqual([])
  })
})

/**
 * The field a name is typed into, against the rows around it. At prose
 * 13, leading 1.5, gap 5, a row's pitch is 24.50 and the field was 21.50
 * with no gap below. It is now a third of a line taller than a row with
 * the same gap, and a rename comes to exactly 24.50, its border drawn in
 * the gap. Checked as text: both sizes come from the settings.
 */
/**
 * A link is underlined and a label is not. They share
 * `--accent-soft`, so the underline alone tells "goes somewhere" from
 * "names something", and it cannot appear only under the pointer.
 */
describe('a link', () => {
  /**
   * Coloured at rest, underlined on hover. A thin underline on
   * prose-coloured text was asked away: a link is read by its colour.
   */
  it('is the mark’s colour, and takes its underline only under the pointer', () => {
    const link = rules().find((rule) => rule.selector === '.markdown-editor .cm-md-link')!
    expect(link.body).toMatch(/color:\s*var\(--mark\)/)
    expect(link.body).not.toMatch(/text-decoration/)
    const hover = rules().find((rule) =>
      rule.selector.split(',').map((one) => one.trim()).includes('.markdown-editor .cm-md-link:hover')
    )!
    expect(hover.body).toMatch(/text-decoration:\s*underline/)
    // One hover for everything that goes somewhere, written once.
    expect(hover.selector).toContain('.daily-step:hover')
    expect(hover.selector).toContain('.welcome-secondary:hover')
  })

  /**
   * The fold arrow is the tree's SVG chevron from `icons.tsx`, in the chrome's tone.
   */
  it('shares the tree’s tone with the fold arrow', () => {
    const gutter = rules().find(
      (rule) => rule.selector === '.code-editor .cm-foldGutter .cm-gutterElement'
    )!
    expect(gutter.body).toMatch(/color:\s*var\(--mark\)/)
  })
})

/**
 * No size in pixels anywhere. Every box and glyph is a multiple of the reading
 * size, which is a setting; a 15px icon in a box sized from the type was clipped
 * when the two disagreed. `--glyph` for a glyph that depicts, `--glyph-sm` for
 * one that points, and `--control`, the square a glyph sits in, is `--row-h`.
 *
 * A stroke is not a size: the caret's `border-left-width` and an
 * SVG's `stroke-width` are hairlines and stay.
 */
describe('sizes', () => {
  const source = readFileSync(new URL('../icons.tsx', import.meta.url), 'utf8')

  it('are absent from the icon components', () => {
    // Each icon reads `GLYPH` or `GLYPH_SM`, so the size lives in the
    // sheet. `stroke-width` is a hairline on a viewBox grid, not a size.
    expect(source).not.toMatch(/(?<!stroke-)width="\d/)
    expect(source).not.toMatch(/height="\d/)
    expect(source.match(/width=\{GLYPH/g)?.length ?? 0).toBeGreaterThan(5)
  })

  /**
   * A control sized in `em` must state its `em`. A button's UA 13.33px
   * font made `--control` 20.0 wide on the folder arrow button and 19.5
   * on a leaf's empty span, so rows with arrows sat half a pixel right.
   */
  it('declare a font size on every control sized in em', () => {
    const emToken = /var\(--(control|row-h|field-h|glyph|glyph-sm|hair)\)|\d(\.\d+)?em/
    const offenders = rules()
      .filter((rule) => /\b(button|input|select|textarea)\b/.test(rule.selector))
      // A pseudo-element inherits from what it is drawn on.
      .filter((rule) => !rule.selector.includes('::'))
      .filter((rule) => emToken.test(rule.body))
      .filter((rule) => !/font-size\s*:/.test(rule.body))
      .map((rule) => rule.selector)
    expect(offenders).toEqual([])
  })

  /**
   * No stroke in the components either. Each glyph states its grid; the sheet
   * turns one `--icon-weight` into the stroke for that grid, so every glyph has
   * one thickness. Dots are filled and take their radius from the same token.
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
   * A box in `em` on an element with its own `em` must say so. `.folder-icon`
   * sets a smaller font size, so `--control` resolved against 12.42px there
   * and 13.5px on the arrow beside it: the icon column was 1.62px narrower in
   * every pane. Dividing by the ratio states the box in the row's em.
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
 * The band above the header, and what must clear it. `.viewer::before` is
 * a fade band pinned to the scrollport's top; it is positioned, so it
 * paints over content under it, and reaches `--header-fade` past the
 * header. A tag page's first heading had its top half painted out. One
 * token: the band's height is built from it and the clearance is it.
 */
describe('the header’s fade band', () => {
  /**
   * Two things can be first on the page, a tag's section and a
   * daily note's day steps, and the rule names both.
   */
  it('is cleared by the first section, off the token the band is built from', () => {
    const root = rules().find((rule) => rule.selector === ':root')!
    expect(root.body).toMatch(/--header-fade:/)
    // The band's height names it, so a longer fade moves the clearance too.
    expect(root.body).toMatch(/--header-h:[^;]*var\(--header-fade\)/)
    // The sum adds the title's line box, not the prose's: the
    // title has its own size and leading.
    expect(root.body).toMatch(/--header-h:[^;]*var\(--title-size\) \* var\(--title-leading\)/)
    const title = rules().find((rule) => rule.selector.startsWith('.viewer-title,'))!
    expect(title.body).toMatch(/font-size:\s*var\(--title-size\)/)
    expect(title.body).toMatch(/line-height:\s*var\(--title-leading\)/)
    // And the band is opaque to the header's bottom edge, from the same sum.
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
 * A gap is one of a few numbers. The sheet once had 93 literal margins,
 * paddings and gaps across 35 values, each picked by eye. They were snapped to
 * their nearest common neighbour (never more than 0.8px), and this keeps the
 * set closed: a new rule picks one, or changes the list on purpose. Tokens are
 * named per job (`--pane-inset`, `--icon-gap`, `--row-gap`), not per size.
 *
 * `:root` defines the tokens, and `.viewer-header`'s padding is the sum
 * `--header-h` is built from; both are skipped here and checked elsewhere.
 */
describe('spacing', () => {
  const SPACING = /(?<![-\w])((?:margin|padding|gap|inset|top|right|bottom|left)(?:-[a-z]+)?)\s*:\s*([^;]+)/g
  const LENGTH = /(?<![\w.-])(\d*\.?\d+)(px|rem|em)\b/g
  const ALLOWED = new Set([
    // `rem`, for the chrome: a pane, a banner, a menu, a button.
    '0.05rem', '0.15rem', '0.25rem', '0.4rem', '0.5rem', '0.6rem', '0.75rem',
    '0.85rem', '1rem', '2rem',
    // `em`, for anything sized off its own type: the settings
    // panel, and marks inside the prose.
    '0.15em', '0.35em', '0.5em', '0.75em', '0.9em', '1em', '1.18em', '1.6em', '2.4em',
    // Hairlines and the resizer's two pixels, which are lines, not gaps.
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

  /**
   * And the set stays small: 21 now. A list that grows with
   * every rule is no set at all.
   */
  it('keeps the set of numbers small', () => {
    expect(ALLOWED.size).toBeLessThanOrEqual(24)
  })

  /**
   * The `[[` popup's CodeMirror theme obeys the same set. Moved out of the sheet
   * for the cascade, it had picked up its own radius, step-down size and paddings.
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
  /**
   * CodeMirror writes the caret's top and height inline, per line. A fixed
   * height and margin here put it 1.43px low. Colour and width only.
   */
  it('leaves its height and its offset to the editor', () => {
    const caret = rules().find((rule) => rule.selector.includes('.cm-cursor'))!
    expect(caret.body).not.toMatch(/height:|margin-top:/)
    expect(css).not.toMatch(/--caret-h|--caret-scale/)
  })
})

/**
 * The open row is coloured, not filled: its name takes the mark
 * and a weight, as a property's name and a section heading do.
 */
describe('the open row', () => {
  /**
   * A nested note renders like a note. Its row had a heavier weight than a leaf's,
   * a second signal on top of its arrow, and the weight the open row uses.
   */
  it('is the only row with a weight of its own', () => {
    // `inherit` is the point: the weight is a setting on the pane,
    // and a control must be told to take it, as with the size.
    const rowish = /\.folder-toggle|\.folder-header|\.file-row|\.note-row|\.row-name/
    for (const rule of rules()) {
      if (!rowish.test(rule.selector) || rule.selector.includes('selected')) continue
      // A section heading at the end of a note is a label, not a row's name:
      // it shares the label rule with a property's name and the clock.
      if (/\.cm-md-|\.note-section/.test(rule.selector)) continue
      const weight = /font-weight:\s*([^;]+)/.exec(rule.body)?.[1].trim()
      expect(weight ?? 'inherit', rule.selector).toBe('inherit')
    }
  })

  /**
   * And no other box: a pressed icon button (the rail's section,
   * the graph toggle) had a `--bg-active` ground, the same second
   * shape. An icon takes the accent and a heavier stroke instead.
   */
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
    // No row paints itself any more. The icon picker's grid still
    // fills its chosen cell: sixty-three glyphs with no names.
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

  /**
   * The gap under the search box is the field's own, so it
   * matches the tree's create box.
   */
  it('is the only thing that spaces the search box', () => {
    const wrapper = rules().find((rule) => rule.selector === '.sidebar-search')!
    expect(wrapper.body).toMatch(/padding:\s*0;/)
  })

  /** A result list with no gap read as one block of text. */
  it('spaces search results by the same gap as rows', () => {
    const hit = rules().find((rule) => rule.selector === '.sidebar-search-hits button')!
    expect(hit.body).toMatch(/margin-bottom:\s*var\(--row-gap\)/)
  })

  /**
   * The space under the divider is the divider's. As `.file-list`'s margin, only
   * rows inside the list got it, and the search field above sat 5.6px higher.
   * After the move the first element starts at the same place in all four states.
   */
  it('keeps every box in the pane free of margins of its own', () => {
    const list = rules().find((rule) => rule.selector === '.file-list')!
    expect(list.body).toMatch(/margin:\s*0;/)
    // And the search field's wrapper has no box either.
    const search = rules().find((rule) => rule.selector === '.sidebar-search')!
    expect(search.body).toMatch(/margin:\s*0;/)
    expect(search.body).toMatch(/padding:\s*0;/)
  })

  /**
   * One inset for every box in the pane's column. Three different
   * values for one edge left the field's text 0.8px off the rows.
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
   * One box whatever section is open. With `max-height` the dialog grew and shrank
   * down the rail. A short window still shrinks it, and `.settings-content` scrolls.
   */
  it('gives the dialog a height, not a cap', () => {
    const dialog = rules().find((rule) => rule.selector === '.settings-dialog')
    expect(dialog).toBeTruthy()
    expect(dialog!.body).toMatch(/\bheight:\s*min\(/)
    expect(dialog!.body).not.toMatch(/max-height/)
    // The overflow needs somewhere to go, or a fixed height clips it.
    const content = rules().find((rule) => rule.selector === '.settings-content')
    expect(content!.body).toMatch(/overflow-y:\s*auto/)
  })

  /**
   * Every control starts on one x: both field kinds declare the same first track,
   * so shortcut rows line up with the selects and sliders. The keybind rows once
   * had their own gap and `1fr` label, putting the combo off line and 237px wide.
   */
  /**
   * Two measures, read by every control. Before, a select and a slider
   * row were different heights and rows stepped unevenly; after, every
   * label and control starts on one x and rows step evenly.
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

  /** The UA's margin on a range input put every track 2px right of the select above. */
  it('takes the platform’s margin off the slider', () => {
    const slider = rules().find(
      (rule) => rule.selector === ".settings-slider input[type='range']"
    )!
    expect(slider.body).toMatch(/margin:\s*0/)
    // WebKit does not fill our own track; the fill comes from
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
    // An `auto` track would take a share of the leftover row.
    expect(keybind!.body).toMatch(/justify-content:\s*start/)
  })
})

describe('a JSON file’s colour', () => {
  /**
   * Every colour follows the scheme: a literal hex would be right in one
   * palette and mode and wrong in the rest. Keys take `--accent-soft`,
   * values a mix of it, brackets the three text tiers by depth.
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

describe('the hanging indent', () => {
  /**
   * The hang must outrank `.cm-line`'s `padding` shorthand, (0,3,0). At (0,2,0) its
   * `padding-left` was reset to zero while its `text-indent` applied, pulling the
   * first row left of the margin. Checked as text, since jsdom has no specificity.
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
   * A side of a `.cm-line`'s padding must out-specify the shorthand, set at
   * three classes. At two it lost, and headings never had their space above.
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
   * One family on a screen; the hierarchy is size and weight. A serif for
   * headings, the title and the note's end sections was asked away three
   * times. So the set is closed at one family, and this refuses a second.
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
   * The weight matters: `--fw-prose` can reach 600, so a heading
   * at 500 was lighter than its paragraph.
   */
  it('sets every heading at the title’s own weight, in no face of its own', () => {
    for (const rule of rules().filter((rule) => HEADINGS.includes(rule.selector))) {
      expect(rule.body, rule.selector).toMatch(/font-weight:\s*var\(--fw-strong\)/)
      expect(rule.body, rule.selector).not.toMatch(/font-family/)
    }
    // `####` and below were already this.
    const deep = rules().find((rule) => rule.selector.includes('.cm-md-h4'))!
    expect(deep.body).toMatch(/font-weight:\s*var\(--fw-strong\)/)
  })

  it('runs a hairline from a section’s heading to the edge of the column', () => {
    const line = rules().find(
      (rule) => rule.selector === '.note-section > .folder-header > .folder-toggle::after'
    )!
    expect(line.body).toMatch(/flex:\s*1/)
    expect(line.body).toMatch(/border-top:\s*1px solid var\(--border\)/)
    // The heading is in the text colour and the reading face.
    const heading = rules().find((rule) => rule.selector === '.note-section > .folder-header .row-name')!
    expect(heading.body).toMatch(/color:\s*var\(--text\)/)
    expect(heading.body).not.toMatch(/font-family/)
  })
})

/**
 * A weight is a token, like a duration. The three roles are
 * named in `:root`, and a rule says which it means, or inherits.
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
   * One duration and curve, as a token: a state change takes `--motion` or nothing. The
   * token is zeroed under `prefers-reduced-motion`, the one place it may be set again.
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
   * Every scheme in the panel paints both modes and has a chip in each. A scheme
   * added without its blocks would render as slate and look the same in the panel.
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
   * A mark in a sentence changes colour only, never size: a smaller run
   * looked squashed, and bold beside dim was three formats on one line.
   */
  it('keeps the prose’s size and weight', () => {
    for (const cls of ['.cm-md-stamp', '.cm-md-tag']) {
      for (const rule of rules().filter((rule) => rule.selector.includes(cls))) {
        expect(rule.body, rule.selector).not.toMatch(/font-size:/)
        expect(rule.body, rule.selector).not.toMatch(/font-weight:/)
      }
    }
  })
})

describe('the drawn selection', () => {
  /**
   * CodeMirror's base theme loads after this sheet and paints its
   * focused selection at three classes. Ours must carry `.cm-editor`
   * too, or near-white text sits on a near-white band in dark mode.
   */
  it('out-specifies the editor’s own colour', () => {
    const rule = rules().find((rule) => rule.selector.includes('.cm-selectionBackground'))!
    expect(rule.selector).toContain('.code-editor .cm-editor.cm-focused .cm-selectionBackground')
    expect(rule.body).toMatch(/background:\s*var\(--bg-active\)/)
  })
})

describe('the left pane', () => {
  /**
   * One scrollport, the pane's: the sections stack, their lists grow,
   * and `.sidebar-body` scrolls. Without it a tall tree was cut off.
   */
  it('scrolls the body, and no list inside it', () => {
    const body = rules().find((rule) => rule.selector === '.sidebar-body')!
    expect(body.body).toMatch(/overflow-y:\s*auto/)
    expect(body.body).toMatch(/flex:\s*1/)
    // `min-height: 0`, or a flex item's content minimum stops it scrolling.
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

  /** The rail and footer are gone from the markup; their rules went with them. */
  it('has no rules left for the rail or the footer', () => {
    expect(css).not.toMatch(/\.sidebar-rail\b/)
    expect(css).not.toMatch(/\.sidebar-footer\b/)
  })
})

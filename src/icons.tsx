import { folderNotePath } from './vaultModel'

/**
 * **The weight of every glyph is a setting, and it lives in the sheet.**
 *
 * A `stroke-width` is in viewBox units, so the same number is a different *rendered*
 * thickness on every grid and at every size: the set once spanned 0.85px to 1.50px
 * across seven hand-written numbers, with the `+` at 2 on a 16-unit grid the
 * heaviest thing on screen. Each glyph now says only which grid it is drawn on —
 * `data-grid` — and `index.css` works the stroke out from `--icon-weight`, which
 * `applySettings` writes from the reading settings. One dial, every glyph, and no
 * weight in this file at all.
 *
 * The dots some glyphs carry are `fill`ed rather than stroked, so they are sized
 * from the same token: a filled 2-unit circle beside a 1.5-unit stroke is what made
 * the graph and the gear read heavier than the lens beside them.
 */
const GRID_16 = { 'data-grid': '16', viewBox: '0 0 16 16' } as const
const GRID_10 = { 'data-grid': '10', viewBox: '0 0 10 10' } as const
const GRID_24 = { 'data-grid': '24', viewBox: '0 0 24 24' } as const

/**
 * **The size a chrome glyph is drawn at**, and it is the sheet's `--glyph` rather
 * than a number of its own: the row of controls held a 15px search, a 16px fold
 * pair and a 12px `+` — three numbers, three files, one row — and every one is
 * drawn on the same 16-unit grid, so the difference was arbitrary. Reading the
 * token means the size lives in one place for CSS and for JSX alike.
 */
export const GLYPH = 'var(--glyph)'

/** A disclosure arrow: it points rather than depicts, so it is the smaller step of
 *  the scale. Also in the sheet, also in `em`. */
export const GLYPH_SM = 'var(--glyph-sm)'

/**
 * The chevron's two paths — **down for open, right for shut** — and the box they
 * are drawn in.
 *
 * `chevronMarkup` hands them out because the note's fold gutter builds its marker by
 * hand (a `GutterMarker`, not JSX) and drew `›` and `⌄` from the font instead: two glyphs
 * of a different weight and size from the arrow on every row in the tree. One
 * source, so the two panes cannot disagree about what an arrow looks like.
 */
const CHEVRON = {
  open: 'M1.5 3.5 5 7l3.5-3.5',
  shut: 'M3.5 1.5 7 5l-3.5 3.5',
  box: `width="${GLYPH_SM}" height="${GLYPH_SM}" viewBox="0 0 10 10" data-grid="10"`,
  stroke: 'stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"',
}

const CHECK = {
  path: 'M2 5.3 4.2 7.5 8 3',
  box: `width="${GLYPH_SM}" height="${GLYPH_SM}" viewBox="0 0 10 10" data-grid="10"`,
  stroke: 'stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"',
}

/**
 * The tick inside a checked task, as markup: a CodeMirror widget builds its DOM by
 * hand, exactly as the fold gutter does.
 *
 * It states its grid and nothing else, so `--icon-weight` sets its stroke like
 * every other glyph — a tick drawn with a hand-picked `stroke-width` would be the
 * one mark in the app that does not follow the setting, which is the mistake the
 * whole `data-grid` arrangement exists to stop.
 */
export function checkMarkup(): string {
  return `<svg ${CHECK.box} fill="none" aria-hidden="true"><path d="${CHECK.path}" ${CHECK.stroke}/></svg>`
}

/** The same chevron as markup, for DOM built without JSX. */
export function chevronMarkup(open: boolean): string {
  return `<svg ${CHEVRON.box} fill="none" aria-hidden="true"><path d="${
    open ? CHEVRON.open : CHEVRON.shut
  }" ${CHEVRON.stroke}/></svg>`
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width={GLYPH_SM} height={GLYPH_SM} {...GRID_10} fill="none" aria-hidden="true">
      <path
        d={open ? CHEVRON.open : CHEVRON.shut}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Two chevrons, pointing at each other to shut the whole tree and apart to open it.
 *
 * The pair every tree view uses. Both are on screen at once, because a half-open
 * tree has both gestures to offer and a single button can only ever name one.
 */
export function FoldAllIcon({ collapse }: { collapse: boolean }) {
  return (
    <svg width={GLYPH} height={GLYPH} {...GRID_16} fill="none" aria-hidden="true">
      {/* Wide chevrons: a narrow pair is mostly whitespace, and it would read as a
          smaller control than the gear beside it at the same nominal size. The
          3.2-unit channel down the middle is the whole legibility of the thing —
          closer together, the two strokes met and the glyph read as a rhombus one
          way and a multiplication sign the other. */}
      <path
        d={
          collapse
            ? 'M3.4 2.8 8 6.4l4.6-3.6M3.4 13.2 8 9.6l4.6 3.6'
            : 'M3.4 6.4 8 2.8l4.6 3.6M3.4 9.6 8 13.2l4.6-3.6'
        }
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A terminal: a prompt's chevron and a cursor's line, in a frame. */
export function TerminalIcon() {
  return (
    <svg width={GLYPH} height={GLYPH} {...GRID_16} fill="none" aria-hidden="true">
      <path
        d="M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5zM5 6l2 2-2 2M8.5 10.5h3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A pane split in two: a frame with a line down or across it. `row` puts the
 *  new pane beside, `column` below — the two buttons on a tab strip. */
export function SplitIcon({ direction }: { direction: 'row' | 'column' }) {
  return (
    <svg width={GLYPH} height={GLYPH} {...GRID_16} fill="none" aria-hidden="true">
      {/* The frame as a path: the sheet's test refuses a `width`/`height` on a
          glyph, and a `<rect>` would need both. */}
      <path
        d={`M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5z${direction === 'row' ? 'M8 2.5v11' : 'M2.5 8h11'}`}
        stroke="currentColor"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The `+`, **one size wherever it is**: the rail's and a row's were 22px and a
 * CSS-overridden 1.35em, so the same gesture had two weights on one screen. It is
 * `GLYPH` now, like every other control.
 */
export function PlusIcon() {
  return (
    <svg width={GLYPH} height={GLYPH} {...GRID_16} fill="none" aria-hidden="true">
      <path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}


/** Braces, for a file rather than a panel. Two strokes, each the mirror of the
    other, so the pair reads as one shape and not as two brackets. */
export function BracesIcon() {
  return (
    <svg width={GLYPH} height={GLYPH} {...GRID_16} fill="none" aria-hidden="true">
      <path
        d="M6.2 2.4c-1.2 0-1.6.7-1.6 1.7v1.6c0 1-.4 1.6-1.3 1.6.9 0 1.3.6 1.3 1.6v1.7c0 1 .4 1.7 1.6 1.7M9.8 2.4c1.2 0 1.6.7 1.6 1.7v1.6c0 1 .4 1.6 1.3 1.6-.9 0-1.3.6-1.3 1.6v1.7c0 1-.4 1.7-1.6 1.7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A magnifier. The handle starts just outside the ring, on the diagonal, so the
    two strokes meet without one crossing into the other. */
export function SearchIcon() {
  return (
    <svg width={GLYPH} height={GLYPH} {...GRID_16} fill="none" aria-hidden="true">
      <circle cx="6.9" cy="6.9" r="4.2" stroke="currentColor" />
      <path
        d="M10.1 10.1 13.7 13.7"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Three notes and the links between them. The edges are one path drawn *before*
    the circles, so each line ends under the node it lands on rather than beside it. */
export function GraphIcon() {
  return (
    <svg width={GLYPH} height={GLYPH} {...GRID_16} fill="none" aria-hidden="true">
      <path
        d="M4 4.6 12 6M4 4.6 7.6 11.6"
        stroke="currentColor"
        strokeLinecap="round"
      />
      <circle cx="4" cy="4.6" r="2.1" fill="currentColor" />
      <circle cx="12" cy="6" r="1.7" fill="currentColor" />
      <circle cx="7.6" cy="11.6" r="1.7" fill="currentColor" />
    </svg>
  )
}

/** Sliders, not a gear: WebKit resolves U+2699 through Apple Color Emoji without a
    VS15 selector, which would drop a colour glyph into monochrome chrome. */
export function SettingsIcon() {
  return (
    <svg width={GLYPH} height={GLYPH} {...GRID_16} fill="none" aria-hidden="true">
      <path
        d="M2 4.5h12M2 8h12M2 11.5h12"
        stroke="currentColor"
        strokeLinecap="round"
      />
      <circle cx="5.5" cy="4.5" r="2" fill="currentColor" />
      <circle cx="10.5" cy="8" r="2" fill="currentColor" />
      <circle cx="5.5" cy="11.5" r="2" fill="currentColor" />
    </svg>
  )
}

/**
 * The icons a note can carry.
 *
 * Monochrome and drawn here rather than emoji: every one is a path stroked like the
 * chevron and the folder glyph, and every one takes `currentColor` — so a chosen
 * icon dims with its row, brightens when the row is selected, and works in every
 * palette without a colour of its own. Emoji went in first and could do none of
 * that: WebKit resolves them through Apple Color Emoji, which ignores
 * `currentColor` entirely.
 *
 * Geometry from **Lucide** (lucide.dev), ISC — `LICENSE-lucide` at the root of this
 * repository is that licence verbatim, Feather's MIT notice included, because
 * several of these descend from it. Inlined rather than installed: this app wants
 * sixty-odd glyphs out of some fifteen hundred, and a package for that is a
 * dependency to track and a bundle to tree-shake in exchange for nothing.
 *
 * One `d` per icon, because this renders a single stroked path and Lucide draws
 * with `<circle>`, `<ellipse>`, `<rect>` and `<line>` as well. The conversion is
 * mechanical; what it has to get right is that a path beginning with a *relative*
 * moveto must be made absolute before it is concatenated onto the one before it, or
 * the second half of `code` starts wherever the first half stopped.
 *
 * **The order is the layout.** The picker draws these seven to a row, so each run of
 * seven below is a row on screen and they are grouped by what a note is *about* —
 * writing, keeping, time, work, people, home, away, making, media. Alphabetical
 * would scatter every group across the grid.
 *
 * Keys are permanent: a note in the vault says `icon: calendar` in its own text, so
 * a key renamed here orphans it. Labels are only the tooltip and can be reworded.
 */
export const NOTE_ICONS: readonly { key: string; label: string; path: string }[] = [
  { key: 'book', label: 'Book', path: 'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20' },
  { key: 'bookmark', label: 'Bookmark', path: 'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z' },
  { key: 'idea', label: 'Idea', path: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4' },
  { key: 'brain', label: 'Thinking', path: 'M12 18V5M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5M17.997 5.125a4 4 0 0 1 2.526 5.77M18 18a4 4 0 0 0 2-7.464M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517M6 18a4 4 0 0 1-2-7.464M6.003 5.125a4 4 0 0 0-2.526 5.77' },
  { key: 'study', label: 'Study', path: 'M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0zM22 10v6M6 12.5V16a6 3 0 0 0 12 0v-3.5' },
  { key: 'quote', label: 'Quote', path: 'M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2zM5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z' },
  { key: 'pen', label: 'Draft', path: 'M13 21h8M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' },
  { key: 'inbox', label: 'Inbox', path: 'M22 12L16 12L14 15L10 15L8 12L2 12M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' },
  { key: 'folder', label: 'Folder', path: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' },
  { key: 'archive', label: 'Archive', path: 'M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-18a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1zM4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4' },
  { key: 'tag', label: 'Tag', path: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42zM7 7.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0' },
  { key: 'hash', label: 'Topic', path: 'M4 9L20 9M4 15L20 15M10 3L8 21M16 3L14 21' },
  { key: 'link', label: 'Link', path: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' },
  { key: 'paperclip', label: 'Attachment', path: 'M16 6l-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551' },
  { key: 'calendar', label: 'Calendar', path: 'M8 2v3M16 2v3M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2zM3 9h18' },
  { key: 'clock', label: 'Clock', path: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0M12 6v6l4 2' },
  { key: 'check', label: 'Done', path: 'M20 6 9 17l-5-5' },
  { key: 'list', label: 'Checklist', path: 'M13 5h8M13 12h8M13 19h8M3 17l2 2 4-4M3 7l2 2 4-4' },
  { key: 'flag', label: 'Flag', path: 'M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528' },
  { key: 'target', label: 'Goal', path: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0M6 12a6 6 0 1 0 12 0a6 6 0 1 0 -12 0M10 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0' },
  { key: 'trophy', label: 'Win', path: 'M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3M4 22h16M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1zM6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3' },
  { key: 'work', label: 'Work', path: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z' },
  { key: 'chart', label: 'Numbers', path: 'M16 7h6v6M22 7l-8.5 8.5-5-5L2 17' },
  { key: 'money', label: 'Money', path: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2zM10 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M6 12h.01M18 12h.01' },
  { key: 'cart', label: 'Shopping', path: 'M2.05 2.05l1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25M16 20a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M6 20a2 2 0 1 0 4 0a2 2 0 1 0 -4 0' },
  { key: 'mail', label: 'Mail', path: 'M22 7l-8.991 5.727a2 2 0 0 1-2.009 0L2 7M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z' },
  { key: 'phone', label: 'Call', path: 'M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384' },
  { key: 'chat', label: 'Conversation', path: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719' },
  { key: 'person', label: 'Person', path: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M8 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0' },
  { key: 'users', label: 'People', path: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.128a4 4 0 0 1 0 7.744M22 21v-2a4 4 0 0 0-3-3.87M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0' },
  { key: 'heart', label: 'Heart', path: 'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5' },
  { key: 'health', label: 'Health', path: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2' },
  { key: 'fitness', label: 'Fitness', path: 'M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829zM2.5 21.5l1.4-1.4M20.1 3.9l1.4-1.4M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829zM9.6 14.4l4.8-4.8' },
  { key: 'smile', label: 'Mood', path: 'M15 10V9M16.472 15a6 6 0 01-8.943 0M9 10V9M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0' },
  { key: 'gift', label: 'Gift', path: 'M12 7v14M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5M4 7h16a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1z' },
  { key: 'home', label: 'Home', path: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { key: 'food', label: 'Food', path: 'M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7' },
  { key: 'coffee', label: 'Coffee', path: 'M10 2v2M14 2v2M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1M6 2v2' },
  { key: 'plant', label: 'Plant', path: 'M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4M5 21h14' },
  { key: 'pet', label: 'Pet', path: 'M9 4a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M16 8a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M18 16a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z' },
  { key: 'droplet', label: 'Water', path: 'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z' },
  { key: 'moon', label: 'Sleep', path: 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401' },
  { key: 'travel', label: 'Travel', path: 'M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z' },
  { key: 'car', label: 'Drive', path: 'M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2M5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M9 17h6M15 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0' },
  { key: 'map', label: 'Map', path: 'M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0zM15 5.764v15M9 3.236v15' },
  { key: 'globe', label: 'World', path: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20' },
  { key: 'pin', label: 'Place', path: 'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0M9 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0' },
  { key: 'mountain', label: 'Outdoors', path: 'M8 3l4 8 5-5 5 15H2L8 3z' },
  { key: 'sun', label: 'Weather', path: 'M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41' },
  { key: 'code', label: 'Code', path: 'M16 18l6-6-6-6M8 6l-6 6 6 6' },
  { key: 'terminal', label: 'Terminal', path: 'M12 19h8M4 17l6-6-6-6' },
  { key: 'database', label: 'Data', path: 'M3 5a9 3 0 1 0 18 0a9 3 0 1 0 -18 0M3 5V19A9 3 0 0 0 21 19V5M3 12A9 3 0 0 0 21 12' },
  { key: 'bug', label: 'Bug', path: 'M12 20v-9M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4zM14.12 3.88 16 2M21 21a4 4 0 0 0-3.81-4M21 5a4 4 0 0 1-3.55 3.97M22 13h-4M3 21a4 4 0 0 1 3.81-4M3 5a4 4 0 0 0 3.55 3.97M6 13H2M8 2l1.88 1.88M9 7.13V6a3 3 0 1 1 6 0v1.13' },
  { key: 'key', label: 'Key', path: 'M2 21l9.6-9.6M7.5 15.5l2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19M10 7.5a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0' },
  { key: 'lock', label: 'Private', path: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2zM7 11V7a5 5 0 0 1 10 0v4' },
  { key: 'rocket', label: 'Launch', path: 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05' },
  { key: 'music', label: 'Music', path: 'M9 18V5l12-2v13M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M15 16a3 3 0 1 0 6 0a3 3 0 1 0 -6 0' },
  { key: 'image', label: 'Image', path: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2zM7 9a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21' },
  { key: 'camera', label: 'Photo', path: 'M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4zM9 13a3 3 0 1 0 6 0a3 3 0 1 0 -6 0' },
  { key: 'video', label: 'Video', path: 'M16 13l5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2z' },
  { key: 'palette', label: 'Design', path: 'M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8zM13 6.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0M17 10.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0M6 12.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0M8 7.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0' },
  { key: 'star', label: 'Star', path: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z' },
  { key: 'zap', label: 'Energy', path: 'M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z' },
]

/**
 * What a note shows before anyone picks an icon: a page with a folded corner.
 *
 * Deliberately *not* in `NOTE_ICONS` — that list is the menu, and "page" is what
 * having no icon looks like rather than a choice in it. Every row therefore draws
 * something, so a name never starts at a different place from the row above it.
 */
export const DEFAULT_NOTE_ICON = 'page'

const PAGE = {
  key: DEFAULT_NOTE_ICON,
  label: 'Page',
  path: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2zM14 2v5a1 1 0 0 0 1 1h5',
}

const BY_KEY = new Map([...NOTE_ICONS, PAGE].map((icon) => [icon.key, icon]))

/** An emoji, and not the name of an icon this app does not have: anything without
 *  an ASCII letter in it is a glyph the font can draw. `icon: compass` used to
 *  render the word *compass* into the icon's box, where it overflowed across the
 *  name beside it — the same way `settings` did in the create menu. */
const isGlyph = (icon: string) => icon.length <= 4 && !/[\x00-\x7F]/.test(icon)

/**
 * A note's chosen icon, by key.
 *
 * A key this set does not know is not dropped: an emoji — set before this list
 * existed, or typed into the frontmatter by hand — is drawn as itself, and any other
 * word as the page. An emoji will not take the row's colour, which is the cost of
 * not being one of these.
 */
export function NoteIcon({ icon }: { icon: string }) {
  const found = BY_KEY.get(icon)
  if (!found) return isGlyph(icon) ? <>{icon}</> : <NoteIcon icon={DEFAULT_NOTE_ICON} />
  return (
    <svg width={GLYPH} height={GLYPH} {...GRID_24} fill="none" aria-hidden="true">
      {/* Lucide's own grid is 24 and it draws at 1.7, not the 2 it ships: 1.7 of 24
          rendered at 15px is 1.06 CSS pixels, which is the weight the rest of this
          file's glyphs settled on. The colour is the stylesheet's — `.folder-icon`
          paints every note's icon in the scheme's, whether or not the note holds
          others. */}
      <path
        d={found.path}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * A folder note's icon.
 *
 * Display is **own only**: what a row draws is the property inside that one note,
 * so what you see in the tree is what is written in the file. Icons spread down a
 * folder by being *written* — when the folder's icon is set (`claimsIcon`) and when
 * a note is made in it (`endowNote`) — and never by being derived at render time.
 *
 * The note's path is derived rather than looked up, because a row knows its own
 * path and not the file inside it — `folderNotePath` is that rule, shared with
 * everything else that needs a folder's own note from a string.
 */
export function resolveNoteIcon(
  folderPath: string,
  icons: Record<string, string>
): string | undefined {
  return icons[folderNotePath(folderPath)]
}

/**
 * Whether a note inside a folder takes the icon just set on that folder.
 *
 * Two kinds of note do: one with no icon of its own, and one still carrying the
 * folder's *previous* icon — which is what makes changing a folder's icon carry the
 * notes it already gave one to, and makes removing it take them back. A note with
 * an icon somebody chose is left alone.
 *
 * Removing (`icon` null) claims only the second kind. Claiming the first would
 * rewrite every note in the subtree to produce the text it already had.
 */
export function claimsIcon(
  current: string | undefined,
  previous: string | undefined,
  icon: string | null
): boolean {
  return current === previous || (icon !== null && !current)
}

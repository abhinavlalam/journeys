// **What in a note is code**, and so not prose: the one rule, for everything that
// reads a note's text for meaning — links, tags, block properties. A `#include` in
// a fence is not a tag, a `[[link]]` in a code sample is not a backlink, and `key:: value` in a snippet is not a property.
//
// Its own module because every reader needs it and none of them owns it: it sat
// in `links.ts`, and the properties would have had to import the links to read a
// note, which import the properties to skip a note's block.

function blank(run: string): string {
  return run.replace(/[^\n]/g, ' ')
}

/**
 * Replaces every code region with spaces, **keeping the string's length** so offsets
 * into it are still offsets into the original.
 *
 * Without this, every markdown link in every code sample in the vault becomes a
 * backlink. **The one rule for what is code** — the tags and the properties read it
 * too, through `proseLines`, or a `#include` in a fence is a tag. Handles fences of
 * three or more backticks or tildes, **at any indent**, because one under a list
 * item sits as deep as the item's text; closed by a run of the same character at
 * least as long, so a fence can hold a shorter one; unclosed, to the end of the
 * note; and a CRLF line's `\r` is not part of what a fence line says.
 *
 * A four-space-indented code block is deliberately *not* masked: in these notes a
 * deeply nested list item is far more common than an indented code sample, and
 * masking those would silently drop real links.
 */
export function maskCode(text: string): string {
  const lines = text.split('\n')
  let out = ''
  let fence: { char: string; len: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const bare = line.endsWith('\r') ? line.slice(0, -1) : line
    const nl = i < lines.length - 1 ? '\n' : ''
    if (fence) {
      const close = bare.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null
      out += blank(line) + nl
      continue
    }
    const open = bare.match(/^[ \t]*(`{3,}|~{3,})(.*)$/)
    // An info string may not hold a backtick, so ``` `js` ``` is an inline span.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], len: open[1].length }
      out += blank(line) + nl
      continue
    }
    out += line + nl
  }

  return maskInlineCode(out)
}

/**
 * Masks inline code spans. A run of N backticks is closed by the next run of
 * *exactly* N — and a run with no such closer is literal text, not an opener, so an
 * unpaired backtick cannot swallow the rest of the note. A blank line ends the
 * search: it ends the paragraph, so the backticks are literal.
 *
 * From backtick to backtick, copying the text between in one piece, and the
 * paragraph's end found once per paragraph: every vault read runs this over every
 * note several times — links, tags, properties — and a copy of the rest of the note
 * per backtick made it the slowest part of reading one.
 */
function maskInlineCode(text: string): string {
  const para = /\n[ \t]*\r?\n/g
  let out = ''
  let copied = 0
  let limit = -1
  let i = text.indexOf('`')
  while (i !== -1) {
    let open = i
    while (text[open] === '`') open++
    const len = open - i
    // The first blank line at or after `open`; one found for an earlier run still
    // is, until the scan passes it.
    if (open > limit) {
      para.lastIndex = open
      limit = para.exec(text)?.index ?? text.length
    }
    let end = -1
    for (let j = text.indexOf('`', open); j !== -1 && j < limit; ) {
      let run = j
      while (text[run] === '`') run++
      if (run - j === len) {
        end = run
        break
      }
      j = text.indexOf('`', run)
    }
    if (end === -1) {
      i = text.indexOf('`', open)
      continue
    }
    out += text.slice(copied, i) + blank(text.slice(i, end))
    copied = end
    i = text.indexOf('`', end)
  }
  return out + text.slice(copied)
}

/**
 * A note's lines with everything that is **not prose** masked out: fenced blocks,
 * their delimiters and inline code become spaces.
 *
 * `maskCode`'s rule, the one the links read too. A vault holds shell and C in
 * fences — `#!/bin/sh`, `#include` — and a line someone pasted is not a tag they
 * keep. This had a rule of its own, which closed a fence on any
 * run of backticks, so a fence holding a shorter one leaked what followed. Line
 * numbers are kept, because `collectLines` reads the *unmasked* line back out by
 * index.
 */
export function proseLines(raw: string): string[] {
  return maskCode(raw).split(/\r?\n/)
}

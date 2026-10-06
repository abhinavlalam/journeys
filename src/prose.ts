// What in a note is code, and so not prose: the one rule for everything that
// reads a note for meaning (links, tags, block properties). A `#include` in a
// fence is not a tag, and a `[[link]]` in a code sample is not a backlink.
// Its own module, since every reader needs it and none owns it.

function blank(run: string): string {
  return run.replace(/[^\n]/g, ' ')
}

/** How far a line is indented: its leading whitespace, in characters. */
export const indentOf = (line: string) => line.length - line.trimStart().length

/**
 * Replaces every code region with spaces, keeping the length, so
 * offsets still match the original.
 *
 * Fences of three or more backticks or tildes, at any indent (one under a list
 * item sits as deep as its text). Closed by a run of the same character at least
 * as long; unclosed runs to the end of the note. A CRLF line's `\r` is ignored.
 *
 * A four-space indented block is not code here: in these notes a deep
 * list item is far more common, and masking it would drop real links.
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
    // An info string cannot hold a backtick, so ``` `js` ``` is an inline span.
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
 * Masks inline code. A run of N backticks is closed by the next run
 * of exactly N; a run with no closer is plain text, so a stray
 * backtick cannot swallow the note. A blank line ends the search.
 *
 * Jumps backtick to backtick and finds each paragraph's end once,
 * since every vault read runs this over every note several times.
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
    // The first blank line at or after `open`. One found for an
    // earlier run still holds until the scan passes it.
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
 * A note's lines with code masked out: fences, their markers and
 * inline code become spaces. `maskCode`'s rule. Line numbers are
 * kept, since `gatherLines` reads the unmasked line back by index.
 */
export function proseLines(raw: string): string[] {
  return maskCode(raw).split(/\r?\n/)
}

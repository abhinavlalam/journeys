// Colour for a delimited file: one hue per column, down the whole file.
//
// **The file stays a file.** A CSV opens as its own text, line for line, with the
// commas where they were written — this is Rainbow CSV's idea, asked for by name,
// and the reason it beats a table for a file you are *editing*: a table is a
// reading of the data, and rewriting one back into rows is where a tool eats a
// quote somebody needed. What colour buys is the thing a table was wanted for —
// which field is which — without touching a byte.
//
// **A scan, not a parser**, as `jsonPreview` is: a line is split on its separator
// outside quotes, and each field between separators takes the colour of its index.
// There is no CSV grammar worth the name (four dialects and a shrug), and nothing
// here has to agree with a parser elsewhere, because nothing else reads it.

import { Decoration, type DecorationSet } from '@codemirror/view'
import type { EditorState, Range } from '@codemirror/state'
import { decorated } from './EditorHost'

/** How many colours there are before the cycle repeats. Six: enough for a table
 *  read across, and every one of them measured against both grounds — see the
 *  sheet. A seventh column starts again at the first, which is what Rainbow CSV
 *  does and is fine: the eye tells neighbours apart, not columns nine apart. */
const COLUMNS = 6

const MARK = Array.from({ length: COLUMNS }, (_, column) =>
  Decoration.mark({ class: `cm-csv-c${column}` })
)

/**
 * The separator a file uses, decided **once for the file** by its first line.
 *
 * A comma unless a tab or a semicolon appears more often — the three separators
 * `.csv` files are written with in practice. Per file and not per line, because a
 * line that happens to hold more tabs than commas is a line with tabs in it, not a
 * change of dialect halfway down a file.
 */
export function separatorOf(firstLine: string): string {
  const count = (character: string) => firstLine.split(character).length - 1
  const commas = count(',')
  const tabs = count('\t')
  const semicolons = count(';')
  if (tabs > commas && tabs >= semicolons) return '\t'
  if (semicolons > commas) return ';'
  return ','
}

/**
 * Where each field of a line begins and ends, given the separator.
 *
 * **A quote protects its separator**, because that is the one rule every dialect
 * agrees on: `"Smith, John"` is one field. A doubled `""` inside a quoted field is
 * an escaped quote and does not end it. An unclosed quote runs to the end of the
 * line — a file being typed is unbalanced most of the time, and a colour that
 * disappears while you type is worse than one that runs on.
 */
export function fieldsOf(line: string, separator: string): { from: number; to: number }[] {
  const fields: { from: number; to: number }[] = []
  let start = 0
  let quoted = false
  for (let at = 0; at < line.length; at++) {
    const character = line[at]
    if (character === '"') {
      if (quoted && line[at + 1] === '"') at++
      else quoted = !quoted
      continue
    }
    if (!quoted && character === separator) {
      fields.push({ from: start, to: at })
      start = at + 1
    }
  }
  fields.push({ from: start, to: line.length })
  return fields
}

/**
 * The marks for the visible span.
 *
 * The separator is read from the document's **first** line however far down the
 * viewport is, so a file scrolled to the middle is coloured the same as one at the
 * top. Empty fields carry no mark: a zero-width decoration is nothing to see, and
 * `Decoration.mark` refuses one anyway.
 */
export function csvDecorations(state: EditorState, from: number, to: number): DecorationSet {
  const separator = separatorOf(state.doc.line(1).text)
  const found: Range<Decoration>[] = []
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(to).number
  for (let number = first; number <= last; number++) {
    const line = state.doc.line(number)
    if (line.text === '') continue
    fieldsOf(line.text, separator).forEach((field, column) => {
      if (field.to > field.from) {
        found.push(MARK[column % COLUMNS].range(line.from + field.from, line.from + field.to))
      }
    })
  }
  return Decoration.set(found)
}

export const csvPreview = decorated(csvDecorations)

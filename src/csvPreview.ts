// Colour for a delimited file: one colour per column, down the whole file.
//
// The file stays text, commas where they were written, as in Rainbow CSV. A
// table view would have to write rows back, which is where tools lose
// quotes. Colour shows which field is which without touching a byte.
//
// A scan, not a parser, as in `jsonPreview`: each line is split on its
// separator outside quotes, and each field takes the colour of its index.

import { Decoration, type DecorationSet } from '@codemirror/view'
import type { EditorState, Range } from '@codemirror/state'
import { decorated } from './EditorHost'

/**
 * How many colours before they repeat. Six, each checked against
 * both grounds in the sheet. A seventh column starts over; the
 * eye compares neighbours, not columns six apart.
 */
const COLUMNS = 6

const MARK = Array.from({ length: COLUMNS }, (_, column) =>
  Decoration.mark({ class: `cm-csv-c${column}` })
)

/**
 * The file's separator, decided once from its first line: a
 * comma, unless a tab or a semicolon appears more often. Per
 * file, not per line, so one line with tabs does not change it.
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
 * Where each field of a line begins and ends. Quotes protect separators (`"Smith,
 * John"` is one field), and `""` inside quotes is an escaped quote. An unclosed
 * quote runs to the line's end, since a file being typed is often unbalanced.
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
 * The marks for the visible span. The separator comes from the first
 * line wherever the view is, so the colours do not shift on scroll.
 * Empty fields get no mark; `Decoration.mark` refuses zero width.
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

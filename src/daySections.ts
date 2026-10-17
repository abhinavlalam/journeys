// A daily note in sections: `## Log` and `## Notes` by default (the owner's names,
// `daySections` in the settings), the same in every daily note, in that order. A
// section is its heading and the lines after it up to the next section's; the note is
// still markdown, and the sections are drawn apart (`daySectionPreview`).
//
// A line goes where its kind says: a line carrying one of a section's tags goes there;
// else one with a clock (what happened, a meeting) goes in the first, the timeline's;
// else the second. What is nested under a line goes with it.

import { leadingClock } from './clock'
import { splitPageProperties } from './properties'
import { indentOf, proseLines } from './prose'
import { tagNames } from './tags'

export interface DaySection {
  name: string
  /** Tags whose lines go in this section, in lower case. */
  tags: string[]
}

/** A section as a note has it: which of the day's sections, its heading's line, and its last line. */
export interface Span {
  index: number
  heading: number
  end: number
}

const HEADING = /^##\s+(.+?)\s*$/

/** The note's sections, by their `## name` lines at the margin, outside code, in the note's order. */
export function spansOf(raw: string, names: readonly string[]): Span[] {
  const lines = raw.split('\n')
  const prose = proseLines(raw)
  const wanted = names.map((name) => name.toLowerCase())
  const heads = prose.flatMap((line, at) => {
    const index = wanted.indexOf(HEADING.exec(line.trimEnd())?.[1].toLowerCase() ?? '')
    return index === -1 ? [] : [{ index, heading: at }]
  })
  return heads.map((head, at) => ({ ...head, end: (heads[at + 1]?.heading ?? lines.length) - 1 }))
}

/** The section a line goes in, by its tags, else by its clock (or a clock under it), else the second. */
export function sectionOf(line: string, sections: readonly DaySection[], below: readonly string[] = []): number {
  const tags = tagNames(line)
  const tagged = sections.findIndex((section) => section.tags.some((tag) => tags.includes(tag)))
  if (tagged !== -1) return tagged
  return leadingClock(line.trim()) || below.some((one) => leadingClock(one.trim())) ? 0 : 1
}

/** A new daily note: its sections' headings, an empty line between. */
export const daySkeleton = (sections: readonly DaySection[]) => sections.map((section) => `## ${section.name}\n`).join('\n')

/**
 * Whether a day is kept in sections: it has them, or nothing is written yet and it is
 * begun with them. A day written before them is filed as it was until it is put in them
 * (`sectioned`): a heading tacked onto its end read as a section of one line.
 */
export const inSections = (raw: string, sections: readonly DaySection[]) =>
  sections.length > 0 && (raw.trim() === '' || spansOf(raw, sections.map((section) => section.name)).length > 0)

/**
 * The note with `block` (a line and what is nested under it) at the end of a section:
 * after its last written line, or under its heading. A section the note lacks is made,
 * before the next one it has, or at the note's end.
 */
export function withInSection(written: string, sections: readonly DaySection[], index: number, block: readonly string[]): string {
  const raw = written.trim() === '' ? daySkeleton(sections) : written
  const lines = raw.split('\n')
  const spans = spansOf(raw, sections.map((section) => section.name))
  const span = spans.find((one) => one.index === index)
  if (span) {
    let last = span.end
    while (last > span.heading && lines[last].trim() === '') last--
    lines.splice(last + 1, 0, ...block)
    return lines.join('\n')
  }
  const made = [`## ${sections[index].name}`, ...block]
  const next = spans.find((one) => one.index > index)
  if (next) {
    lines.splice(next.heading, 0, ...made, '')
    return lines.join('\n')
  }
  const gap = raw === '' || raw.endsWith('\n\n') ? '' : raw.endsWith('\n') ? '\n' : '\n\n'
  return `${raw}${gap}${made.join('\n')}\n`
}

/**
 * A note written before its sections, put in them: its page properties first, then
 * each section with its lines in the order they were written, each line taking what
 * is nested under it. A note that has its sections already is left as it is.
 */
export function sectioned(raw: string, sections: readonly DaySection[]): string {
  if (spansOf(raw, sections.map((section) => section.name)).length > 0) return raw
  const { prefix, body } = splitPageProperties(raw)
  const blocks: string[][] = []
  for (const line of body.split('\n')) {
    if (line.trim() !== '' && (indentOf(line) === 0 || blocks.length === 0)) blocks.push([line])
    else if (blocks.length > 0) blocks.at(-1)!.push(line)
  }
  const into = sections.map((): string[][] => [])
  for (const block of blocks) {
    while (block.length > 1 && block.at(-1)!.trim() === '') block.pop()
    into[sectionOf(block[0], sections, block.slice(1))].push(block)
  }
  const written = sections.map((section, at) => [`## ${section.name}`, ...into[at].flat()].join('\n')).join('\n\n')
  const top = prefix === '' ? '' : `${prefix.replace(/\n*$/, '')}\n\n`
  return `${top}${written}\n`
}

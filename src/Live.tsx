import type { ReactNode } from 'react'
import { TAG_NAME } from './tags'
import { linkLabelSpan } from './vaultModel'

/**
 * What a line shows other than as typed: a `[[wikilink]]`, a markdown link, a bare
 * address, `**strong**` or `__strong__` text, and a tag after a space or the start.
 */
const LIVE = new RegExp(
  String.raw`\[\[([^\]\n]+)\]\]|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)|(\*\*|__)(.+?)\5|(^|\s)#(${TAG_NAME})`,
  'g'
)

/**
 * Words as the note shows them: a link reads as its name and opens what it names, a
 * tag opens its page, and neither also opens the row it is in. Emphasis loses its
 * marks and is not made heavier: a mark in a sentence changes colour and nothing
 * else. A timeline entry and the lines under it read this way, and a table's words and
 * values: as written, a markdown link was its whole address and a strong phrase its
 * asterisks, and a `url` value could not be opened.
 */
export function Live({
  text,
  onOpenLink,
  onOpenTag,
  colours,
}: {
  text: string
  /** A link's target, and whether it was a `[[wikilink]]` rather than a markdown link or an address. */
  onOpenLink: (target: string, wiki: boolean) => void
  /** Absent where tags are not live, and a tag reads as its words. */
  onOpenTag?: (tag: string) => void
  /** Each tag's colour, for its chip. */
  colours?: Readonly<Record<string, string>>
}) {
  const parts: ReactNode[] = []
  let at = 0
  const link = (key: number, shown: string, target: string, wiki: boolean) => (
    <button key={key} className="line-link" onClick={(event) => (event.stopPropagation(), onOpenLink(target, wiki))}>
      {shown}
    </button>
  )
  for (const hit of text.matchAll(LIVE)) {
    const start = hit.index ?? 0
    const lead = hit[7] ?? ''
    parts.push(text.slice(at, start) + lead)
    if (hit[1]) {
      const inner = hit[1]
      const shown = linkLabelSpan(inner)
      parts.push(link(start, inner.slice(shown.from, shown.to).trim(), inner.split('|')[0].trim(), true))
    } else if (hit[2]) {
      parts.push(link(start, hit[2], hit[3], false))
    } else if (hit[4]) {
      parts.push(link(start, hit[4], hit[4], false))
    } else if (hit[6]) {
      parts.push(hit[6])
    } else if (onOpenTag) {
      parts.push(
        <button
          key={start}
          className="timeline-tag"
          data-hue={colours?.[hit[8].toLowerCase()]}
          onClick={(event) => (event.stopPropagation(), onOpenTag(hit[8].toLowerCase()))}
        >
          #{hit[8]}
        </button>
      )
    } else {
      parts.push(`#${hit[8]}`)
    }
    at = start + hit[0].length
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}

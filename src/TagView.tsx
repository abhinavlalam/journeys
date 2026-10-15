import { readBlock, type PropertyType } from './properties'
import { ViewerHeader } from './ViewerHeader'
import { GatheredNotes, readable, Section, stepIn, statusCount } from './rows'
import { TAG_COLOURS, type TagColour } from './tags'
import type { CollectedNote } from './useVaultTexts'
import type { VaultFile } from './vaultModel'

/**
 * A tag's page: its colour, and every line in the vault with `#name`, under its note.
 * A tag has no file; its page is built from the notes. A tag is a label: what a
 * tracker counts is in its table (until 2026-10-15 a tag had a structure of properties,
 * its lines drawn as a table and totalled each day).
 */
export function TagView({
  name,
  collected,
  typeOf,
  icons,
  loading,
  colour,
  onColour,
  onOpen,
}: {
  name: string
  /** Null while the vault is still being read. */
  collected: CollectedNote[] | null
  typeOf: (property: string) => PropertyType
  icons: Record<string, string>
  loading: boolean
  /** The tag's colour, in notes and on the timeline, and a change to it (null: none). */
  colour: TagColour | undefined
  onColour: (next: TagColour | null) => void
  onOpen: (file: VaultFile) => void
}) {
  const total = (collected ?? []).reduce((sum, one) => sum + one.lines.length, 0)
  return (
    <>
      {/* `#travel`, not `travel`: the header shows the syntax,
          as `icon::` does on a property page. */}
      <ViewerHeader name={`#${name}`} status={statusCount(total, 'line')} />
      {/* The tag's colour: its marks in notes, and its entries' dots, rows and chips. */}
      <Section title="Colour" count={colour ? 1 : 0} startOpen>
        <li className="tag-swatches" style={{ paddingLeft: stepIn(1) }}>
          <button className="tag-swatch none" aria-label="No colour" aria-pressed={!colour} onClick={() => onColour(null)} />
          {TAG_COLOURS.map((one) => (
            <button
              key={one}
              className="tag-swatch"
              data-hue={one}
              aria-label={`${one.charAt(0).toUpperCase()}${one.slice(1)}`}
              aria-pressed={colour === one}
              onClick={() => onColour(one)}
            />
          ))}
        </li>
      </Section>
      <Section title="Lines" count={total} startOpen>
        {/* Each line as the note shows it: property names and quotes out, links as their names. */}
        <GatheredNotes notes={collected} icons={icons} loading={loading} onOpen={onOpen} head={(text) => readable(readBlock(text, typeOf))} />
      </Section>
    </>
  )
}

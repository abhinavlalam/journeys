import { ViewerHeader } from './ViewerHeader'
import { countOf, GatheredNotes, readable, Section } from './rows'
import type { CollectedNote } from './useVaultTexts'
import type { VaultFile } from './vaultModel'

/**
 * A tag's page: every line in the vault carrying `#name`, under the note it is in.
 *
 * **A tag has no file, and its page is the question asked of the notes** — the
 * correction collections and properties have each already had, applied to the one
 * kind that had not needed it yet. A `.config/actions/tags/travel.md` would be an
 * empty page named after a thing; the thing is the eleven lines that say `#travel`.
 *
 * Drawn as the collection page's Lines section, because it *is* that section —
 * `GatheredNotes`, the one list both pages draw. What it has not got is a
 * Structure and a table: a tag declares nothing, so there are no fields to read out
 * of a line and nothing to tabulate. `readable` renders the entry, for the reason
 * the backlink lines take it: a quotation reads as the note reads.
 */
export function TagView({
  name,
  collected,
  icons,
  loading,
  onOpen,
}: {
  name: string
  /** Null while the vault is still being read. */
  collected: CollectedNote[] | null
  icons: Record<string, string>
  loading: boolean
  onOpen: (file: VaultFile) => void
}) {
  const notes = collected ?? []
  const total = notes.reduce((sum, one) => sum + one.lines.length, 0)

  return (
    <>
      {/* `#travel` and not `travel`: the header names the syntax, as `--expense`
          and `icon:` do on the other two pages. */}
      <ViewerHeader name={`#${name}`} status={total > 0 ? countOf(total, 'line') : ''} />
      <Section title="Lines" count={total} startOpen>
        <GatheredNotes notes={collected} icons={icons} loading={loading} onOpen={onOpen} head={readable} />
      </Section>
    </>
  )
}


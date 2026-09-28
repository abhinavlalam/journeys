import { useState } from 'react'
import { CollectionTable } from './CollectionTable'
import { PlusIcon } from './icons'
import { blockProperties, PROPERTY_NAME, readBlock, type PropertyType } from './properties'
import { ViewerHeader } from './ViewerHeader'
import { countOf, GatheredNotes, NameField, NoteRow, readable, RowIcon, Section, stepIn } from './rows'
import type { CollectedNote } from './useVaultTexts'
import type { VaultFile } from './vaultModel'

/**
 * A tag's page: the properties its lines carry, and every line in the vault carrying
 * `#name`, under the note it is in.
 *
 * **A tag has no file, and its page is the question asked of the notes** — the
 * correction collections and properties have each already had. A
 * `.config/actions/tags/travel.md` would be an empty page named after a thing; the
 * thing is the eleven lines that say `#travel`.
 *
 * **Its structure is a list of properties**, one per row: `+` adds one, `×` takes
 * one off, and a row opens the property's own page, where its type is set. With a
 * structure and lines, a **Table** reads each line's values in its columns — the
 * same table a collection draws, summing the `number` ones — above the Lines, which
 * keep the sentences. The two are sections to open and shut, not a mode to be in:
 * the collection page's bargain.
 */
export function TagView({
  name,
  collected,
  properties,
  typeOf,
  icons,
  loading,
  onProperties,
  onError,
  onOpenProperty,
  onOpen,
  onOpenLink,
}: {
  name: string
  /** Null while the vault is still being read. */
  collected: CollectedNote[] | null
  /** The tag's structure: the properties its lines carry, in order. */
  properties: readonly string[]
  typeOf: (property: string) => PropertyType
  icons: Record<string, string>
  loading: boolean
  onProperties: (next: string[]) => void
  onError: (message: string) => void
  onOpenProperty: (property: string) => void
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string) => void
}) {
  const notes = collected ?? []
  const total = notes.reduce((sum, one) => sum + one.lines.length, 0)
  const [adding, setAdding] = useState<string | null>(null)
  const table = properties.length > 0 && notes.length > 0

  /**
   * A name typed in the field — `with::` as `with`, the way a line writes it — added
   * unless it is there already. **One that is not a name keeps the field and says
   * so**: dropped as the field closed, it read as the `+` not working.
   */
  function add() {
    const typed = (adding ?? '').trim().replace(/:+$/, '')
    if (typed && !new RegExp(`^${PROPERTY_NAME}$`).test(typed)) {
      onError(`${typed} is not a property name: a property is one word, starting with a letter.`)
      return
    }
    setAdding(null)
    const taken = properties.some((one) => one.toLowerCase() === typed.toLowerCase())
    if (typed && !taken) onProperties([...properties, typed])
  }

  /** A line's values, by the structure's own spelling of each property. */
  function valuesOf(text: string): Record<string, string> {
    const found = new Map(
      blockProperties(text, typeOf)
        .filter((one) => one.valid && one.value)
        .map((one) => [one.name.toLowerCase(), one.value])
    )
    return Object.fromEntries(properties.map((one) => [one, found.get(one.toLowerCase()) ?? '']))
  }

  return (
    <>
      {/* `#travel` and not `travel`: the header names the syntax, as `icon::` does
          on a property's page. */}
      <ViewerHeader name={`#${name}`} status={total > 0 ? countOf(total, 'line') : ''} />
      <Section
        title="Properties"
        count={properties.length}
        startOpen
        actions={
          <button
            aria-label="Add a property"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setAdding((current) => current ?? '')}
          >
            <PlusIcon />
          </button>
        }
      >
        {properties.map((one) => (
          <li key={one} className="note-row" style={{ paddingLeft: stepIn(1) }}>
            <NoteRow
              icon={<RowIcon icon="list" />}
              name={one}
              trailing={<span className="row-count">{typeOf(one)}</span>}
              onClick={() => onOpenProperty(one)}
            />
            <span className="folder-actions">
              <button aria-label={`Remove ${one}`} onClick={() => onProperties(properties.filter((kept) => kept !== one))}>
                ×
              </button>
            </span>
          </li>
        ))}
        {adding !== null && (
          <li style={{ paddingLeft: stepIn(1) }}>
            <NameField
              value={adding}
              placeholder="Property name…"
              onChange={setAdding}
              onSubmit={add}
              onCancel={() => setAdding(null)}
              onBlur={() => setAdding(null)}
            />
          </li>
        )}
        {properties.length === 0 && adding === null && (
          <li style={{ paddingLeft: stepIn(1) }}>
            <NoteRow icon={<RowIcon />} name="No properties yet: + adds one." disabled />
          </li>
        )}
      </Section>
      {table && (
        <Section title="Table" count={total} startOpen>
          <li className="collection-table-box">
            <CollectionTable
              columns={properties}
              valuesOf={valuesOf}
              summable={(column) => typeOf(column) === 'number'}
              notes={notes}
              onOpen={onOpen}
              onOpenLink={onOpenLink}
            />
          </li>
        </Section>
      )}
      <Section title="Lines" count={total} startOpen={!table}>
        {/* Each line as the note reads it: properties' names and quotes left out,
            links as their names. */}
        <GatheredNotes
          notes={collected}
          icons={icons}
          loading={loading}
          onOpen={onOpen}
          head={(text) => readable(readBlock(text, typeOf))}
        />
      </Section>
    </>
  )
}

import { useState } from 'react'
import { LineTable } from './LineTable'
import { PlusIcon } from './icons'
import { blockProperties, PROPERTY_NAME, readBlock, type PropertyType } from './properties'
import { ViewerHeader } from './ViewerHeader'
import { countOf, GatheredNotes, NameField, NoteRow, readable, RowIcon, Section, stepIn } from './rows'
import { LINE_VIEWS, tagsOnly, type LineView } from './tags'
import type { CollectedNote } from './useVaultTexts'
import type { VaultFile } from './vaultModel'

/**
 * A tag's page: the properties its lines carry, and every line in the vault with
 * `#name`, under its note. A tag has no file; its page is built from the notes.
 *
 * Its structure is a list of properties, one per row: `+` adds, `×`
 * removes, and a row opens the property's page, where its type is set.
 * Its lines are shown as a list or a table, chosen in the header. The
 * table reads each line's values into columns and sums the `number` ones.
 */
export function TagView({
  name,
  collected,
  properties,
  view,
  typeOf,
  icons,
  loading,
  onView,
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
  view: LineView
  typeOf: (property: string) => PropertyType
  icons: Record<string, string>
  loading: boolean
  onView: (next: LineView) => void
  onProperties: (next: string[]) => void
  onError: (message: string) => void
  onOpenProperty: (property: string) => void
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string) => void
}) {
  // A table leaves out a line of tags alone, a group's heading: it would be a
  // row of empty cells. A list keeps it, heading the lines nested under it.
  const notes =
    view === 'table'
      ? (collected ?? [])
          .map((one) => ({ ...one, lines: one.lines.filter((line) => !tagsOnly(line.text)) }))
          .filter((one) => one.lines.length > 0)
      : (collected ?? [])
  const total = notes.reduce((sum, one) => sum + one.lines.length, 0)
  const [adding, setAdding] = useState<string | null>(null)

  /**
   * A typed name (`with::` read as `with`), added unless already
   * there. A name that is not valid keeps the field open and says why.
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

  /** A line's values, keyed by the structure's spelling of each property. */
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
      {/* `#travel`, not `travel`: the header shows the syntax,
          as `icon::` does on a property page. */}
      <ViewerHeader name={`#${name}`} status={total > 0 ? countOf(total, 'line') : ''}>
        <span className="view-switch" role="group" aria-label="View">
          {LINE_VIEWS.map((one) => (
            <button key={one} className="header-action" aria-pressed={view === one} onClick={() => onView(one)}>
              {one === 'list' ? 'List' : 'Table'}
            </button>
          ))}
        </span>
      </ViewerHeader>
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
      <Section title="Lines" count={total} startOpen>
        {view === 'table' && notes.length > 0 ? (
          <li className="line-table-box">
            <LineTable
              columns={properties}
              valuesOf={valuesOf}
              summable={(column) => typeOf(column) === 'number'}
              notes={notes}
              onOpen={onOpen}
              onOpenLink={onOpenLink}
            />
          </li>
        ) : (
          // Each line as the note shows it: property names and quotes out,
          // links as their names. Also what a table with no lines shows.
          <GatheredNotes
            notes={collected}
            icons={icons}
            loading={loading}
            onOpen={onOpen}
            head={(text) => readable(readBlock(text, typeOf))}
          />
        )}
      </Section>
    </>
  )
}

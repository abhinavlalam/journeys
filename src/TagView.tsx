import { useState } from 'react'
import { LineTable } from './LineTable'
import { PlusIcon } from './icons'
import { blockProperties, PROPERTY_NAME, readBlock, type PropertyType } from './properties'
import { ViewerHeader } from './ViewerHeader'
import { countOf, GatheredNotes, NameField, NoteRow, readable, RowIcon, Section, stepIn } from './rows'
import { COMBINES, LINE_VIEWS, lineWords, TAG_COLOURS, tagsOnly, TOTAL_PLACES, type Combine, type DayTotal, type LineView, type TagColour, type TotalPlace } from './tags'

/** How each way of combining reads in its menu. */
const COMBINE_NAMES: Record<Combine, string> = { sum: 'Sum', average: 'Average', count: 'Count', min: 'Lowest', max: 'Highest' }
/** Where a total shows, as its menu says it. */
const PLACE_NAMES: Record<TotalPlace, string> = { both: 'Timeline and note', timeline: 'Timeline', note: 'Note' }
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
  totals,
  onTotals,
  colour,
  onColour,
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
  /** The tag's daily totals (`dayTotalsOf`), and a change to them. */
  totals: readonly DayTotal[]
  onTotals: (next: DayTotal[]) => void
  /** The tag's colour on the timeline, and a change to it (null: none). */
  colour: TagColour | undefined
  onColour: (next: TagColour | null) => void
  onError: (message: string) => void
  onOpenProperty: (property: string) => void
  onOpen: (file: VaultFile) => void
  /** A link's target, and whether it was a `[[wikilink]]`. */
  onOpenLink: (target: string, wiki: boolean) => void
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
      {/* The tag's colour on the timeline: its entries' dots, rows and chips. */}
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
      {/* Each `number` property, totalled for every day when chosen here, and how:
          combined, labelled and shown as set. The one place the choice is made. */}
      {properties.some((one) => typeOf(one) === 'number') && (
        <Section title="Daily totals" count={totals.length} startOpen>
          {properties
            .filter((one) => typeOf(one) === 'number')
            .map((one) => {
              const at = totals.findIndex((total) => total.property.toLowerCase() === one.toLowerCase())
              const total = totals[at]
              const change = (fields: Partial<DayTotal>) => onTotals(totals.map((was, n) => (n === at ? { ...was, ...fields } : was)))
              return (
                <li key={one} className="note-row" style={{ paddingLeft: stepIn(1) }}>
                  <NoteRow
                    icon={<RowIcon icon={total ? 'check' : undefined} />}
                    name={one}
                    aria-pressed={!!total}
                    aria-label={total ? `Stop totalling ${one} each day` : `Total ${one} each day`}
                    trailing={<span className="row-count">{total ? 'totalled each day' : 'not totalled'}</span>}
                    onClick={() =>
                      onTotals(total ? totals.filter((_, n) => n !== at) : [...totals, { property: one, by: 'sum', label: '', show: 'both' }])
                    }
                  />
                  {total && (
                    <span className="total-settings" style={{ paddingLeft: stepIn(1) }}>
                      <select aria-label={`How ${one} is combined`} value={total.by} onChange={(event) => change({ by: event.currentTarget.value as Combine })}>
                        {COMBINES.map((by) => (
                          <option key={by} value={by}>
                            {COMBINE_NAMES[by]}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={`What ${one}'s total is called`}
                        placeholder={`${one} · #${name}`}
                        defaultValue={total.label}
                        onBlur={(event) => event.currentTarget.value !== total.label && change({ label: event.currentTarget.value.trim() })}
                        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
                      />
                      <select aria-label={`Where ${one}'s total shows`} value={total.show} onChange={(event) => change({ show: event.currentTarget.value as TotalPlace })}>
                        {TOTAL_PLACES.map((place) => (
                          <option key={place} value={place}>
                            {PLACE_NAMES[place]}
                          </option>
                        ))}
                      </select>
                    </span>
                  )}
                </li>
              )
            })}
        </Section>
      )}
      <Section title="Lines" count={total} startOpen>
        {view === 'table' && notes.length > 0 ? (
          <li className="line-table-box">
            <LineTable
              columns={properties}
              valuesOf={valuesOf}
              wordsOf={(text) => lineWords(text, typeOf)}
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

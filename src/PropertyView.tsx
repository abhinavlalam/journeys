import { useRef } from 'react'
import { Cell } from './CollectionTable'
import { useColumnWidths } from './columnWidths'
import { ViewerHeader } from './ViewerHeader'
import { countOf, NoteRow, READING, stepIn, RowIcon, Section } from './rows'
import type { VaultFile } from './vaultModel'

/**
 * A property: every note that carries it, and what each one says.
 *
 * **A collection's page one scale up**, and the same correction. Clicking `icon`
 * used to open — or write — `.config/actions/properties/icon.md`, and three of
 * those sat in a vault at zero bytes: an empty page named after a thing is not the
 * thing. The thing is thirty-three notes saying `icon: calendar`, `icon: person`,
 * `icon: work`, which is a question asked of the notes and answered here.
 *
 * Presentational and given no filesystem — the values arrive off the one vault
 * read, so this mounts under a test with no disk at all. The table is the
 * collection table's own classes, because it is the same object: rows read out of
 * notes, the note leading, the note opening on a click, a `[[link]]` value a link.
 */
export function PropertyView({
  name,
  values,
  icons,
  loading,
  onOpen,
  onOpenLink,
}: {
  name: string
  values: readonly { note: VaultFile; value: string }[]
  icons: Record<string, string>
  loading: boolean
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string) => void
}) {
  const table = useRef<HTMLTableElement>(null)
  const { widths, gripFor } = useColumnWidths(table)
  return (
    <>
      {/* `icon:` and not `icon`: the header names the syntax, as `--expense` does. */}
      <ViewerHeader name={`${name}:`} status={values.length > 0 ? countOf(values.length, 'note') : ''} />
      <Section title="Values" count={values.length} startOpen>
        {values.length === 0 ? (
          <li style={{ paddingLeft: stepIn(1) }}>
            <NoteRow
              icon={<RowIcon />}
              name={loading ? READING : 'No note carries this yet.'}
              disabled
            />
          </li>
        ) : (
          <li className="collection-table-box">
            <table className="collection-table" ref={table} data-sized={widths ? '' : undefined}>
              <thead>
                <tr>
                  <th data-col="note" style={{ width: widths?.note }}>
                    note
                    {gripFor('note')}
                  </th>
                  <th data-col={name} style={{ width: widths?.[name] }}>
                    {name}
                    {gripFor(name)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {values.map(({ note, value }) => (
                  <tr key={note.path}>
                    <td>
                      <button className="collection-source" onClick={() => onOpen(note)}>
                        <RowIcon icon={icons[note.path]} />
                        {note.name}
                      </button>
                    </td>
                    <td>
                      <Cell value={value} onOpenLink={onOpenLink} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </li>
        )}
      </Section>
    </>
  )
}


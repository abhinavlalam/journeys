import { useRef } from 'react'
import { Live } from './Live'
import { useColumnWidths } from './columnWidths'
import { ViewerHeader } from './ViewerHeader'
import { EmptyRow, READING, RowIcon, Section, statusCount } from './rows'
import type { VaultFile } from './vaultModel'
import { PROPERTY_TYPES, type PropertyType } from './properties'

/**
 * A property's page: every value the notes give it, on a page or a line, and its
 * type, set here for the whole vault. The app's own properties have fixed types.
 *
 * A page, not a file: a file named after a property is an empty page, not the property.
 *
 * No filesystem: the values come from the one vault read, so a test
 * needs no disk. The table uses `LineTable`'s classes: rows from notes,
 * the note first, a click opens it, a `[[link]]` value is a link.
 */
export function PropertyView({
  name,
  values,
  icons,
  loading,
  type,
  appOwned,
  onType,
  onOpen,
  onOpenLink,
}: {
  name: string
  values: readonly { note: VaultFile; value: string }[]
  icons: Record<string, string>
  loading: boolean
  type: PropertyType
  /** One of `APP_PROPERTIES`: typed by the app, so the type is shown, not chosen. */
  appOwned: boolean
  onType: (type: PropertyType) => void
  onOpen: (file: VaultFile) => void
  onOpenLink: (target: string) => void
}) {
  const table = useRef<HTMLTableElement>(null)
  const { widths, gripFor } = useColumnWidths(table)
  return (
    <>
      {/* `icon::`, not `icon`: the header shows the syntax, as `#travel` does. */}
      <ViewerHeader
        name={`${name}::`}
        status={[statusCount(values.length, 'value'), appOwned ? 'the app’s own' : '']
          .filter(Boolean)
          .join(' · ')}
      >
        {/* A menu of types. The app's own properties show their
            type and cannot change it. */}
        <select
          className="settings-select header-select"
          aria-label="Type"
          value={type}
          disabled={appOwned}
          onChange={(event) => onType(event.currentTarget.value as PropertyType)}
        >
          {PROPERTY_TYPES.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
        </select>
      </ViewerHeader>
      <Section title="Values" count={values.length} startOpen>
        {values.length === 0 ? (
          <EmptyRow text={loading ? READING : 'No note carries this yet.'} />
        ) : (
          <li className="line-table-box">
            <table className="line-table" ref={table} data-sized={widths ? '' : undefined}>
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
                {values.map(({ note, value }, at) => (
                  <tr key={`${note.path}:${at}`}>
                    <td>
                      <button className="line-source" onClick={() => onOpen(note)}>
                        <RowIcon icon={icons[note.path]} />
                        {note.name}
                      </button>
                    </td>
                    <td>
                      <Live text={value} onOpenLink={onOpenLink} />
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


import { useState } from 'react'
import { AddButton, EmptyRow, GroupRow, guideAt, NameField, NoteRow, RowIcon, stepIn } from './rows'
import type { VaultFile } from './vaultModel'

/** A tracker's name: its file's, without the extension. */
export const trackerName = (file: VaultFile) => file.name.replace(/\.[^.]+$/, '')

/**
 * The trackers under Applications: a group always there, its tables one to a row, and
 * a + that makes one, asking its name and then its columns in the one field. With no
 * table yet it says so: drawn only as tables, an empty folder left nothing to find.
 */
export function TrackersGroup({
  trackers,
  openPath,
  open,
  onToggle,
  onOpen,
  onStart,
  onCreate,
  onError,
}: {
  trackers: readonly VaultFile[]
  /** The file in front, so its row is marked. */
  openPath: string | null
  open: boolean
  onToggle: () => void
  onOpen: (file: VaultFile) => void
  /** The field opens, so the other fields close. */
  onStart: () => void
  onCreate: (name: string, columns: string[]) => void
  onError: (message: string) => void
}) {
  /** What is typed: the name, then, once it is in, the columns. */
  const [asking, setAsking] = useState<{ name: string; columns: string | null } | null>(null)
  const start = () => {
    if (asking) return
    onStart()
    setAsking({ name: '', columns: null })
  }
  function submit() {
    if (!asking) return
    const name = asking.name.trim().replace(/\.csv$/i, '')
    if (asking.columns === null) {
      if (!name) return setAsking(null)
      if (trackers.some((one) => trackerName(one).toLowerCase() === name.toLowerCase())) return onError(`There is a tracker called ${name} already.`)
      return setAsking({ name, columns: '' })
    }
    const columns = asking.columns.split(',').map((one) => one.trim()).filter(Boolean)
    setAsking(null)
    // A table has a column at least: its day, when none is named.
    onCreate(name, columns.length > 0 ? columns : ['day'])
  }
  return (
    <li className="folder-row">
      <GroupRow
        depth={1}
        name="Trackers"
        open={open}
        onToggle={onToggle}
        icon={<RowIcon icon="chart" />}
        trailing={trackers.length > 0 ? <span className="row-count">{trackers.length}</span> : undefined}
        actions={
          <span className="folder-actions">
            <AddButton label="New tracker" onPress={start} />
          </span>
        }
      />
      {(open || asking) && (
        <ul className="folder-children" style={guideAt(1)}>
          {trackers.map((file) => (
            <li key={file.path} style={{ paddingLeft: stepIn(2) }}>
              <NoteRow
                icon={<RowIcon icon="list" />}
                name={trackerName(file)}
                className={file.path === openPath ? 'selected' : undefined}
                aria-label={trackerName(file)}
                aria-pressed={file.path === openPath}
                onClick={() => onOpen(file)}
              />
            </li>
          ))}
          {asking && (
            <li style={{ paddingLeft: stepIn(2) }}>
              <NameField
                // One field for both questions, as a locked note asks: remounted, it lost the keyboard.
                value={asking.columns ?? asking.name}
                placeholder={asking.columns === null ? 'Tracker name…' : 'Its columns, with commas: day, amount, what'}
                ariaLabel={asking.columns === null ? 'Tracker name' : `Columns of ${asking.name}`}
                onChange={(value) => setAsking((was) => was && (was.columns === null ? { ...was, name: value } : { ...was, columns: value }))}
                onSubmit={submit}
                onCancel={() => setAsking(null)}
                onBlur={() => setAsking(null)}
              />
            </li>
          )}
          {trackers.length === 0 && !asking && <EmptyRow depth={2} text="No trackers yet: + makes one." />}
        </ul>
      )}
    </li>
  )
}

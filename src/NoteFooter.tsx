import type { ReactNode } from 'react'
import { DEFAULT_NOTE_ICON } from './icons'
import { guideAt, NoteRow, opensNote, readable, stepIn, RowIcon, Section } from './rows'
import type { Backlink } from './links'
import { folderNoteRef, type VaultFile, type VaultFolder } from './vaultModel'

interface NoteFooterProps {
  /**
   * The tree of what is inside this note, when it is a nested one,
   * drawn by the caller with `FolderTree` so its subfolders open
   * too. Null for a plain note, which then has no Inside section.
   */
  inside: ReactNode
  /** Its direct children, for the count beside the heading. */
  insideCount: number
  backlinks: Backlink[]
  /**
   * The folders this note is reached through, outermost first.
   * Each is a note of its own, so each row opens one.
   */
  trail: VaultFolder[]
  /** Each path's icon, so a row here matches its row in the tree. */
  icons: Record<string, string>
  onOpen: (file: VaultFile) => void
}

/**
 * The end of a note: where it sits, what is inside it, and what links to
 * it. The same rows and classes as the left pane (`folder-header`,
 * `file-row`, `folder-children`, `--guide-x`). Added after the note's
 * text, not pinned under the pane: the editor grows with its text.
 */
export function NoteFooter({
  inside,
  insideCount,
  trail,
  backlinks,
  icons,
  onOpen,
}: NoteFooterProps) {
  return (
    <>
      {/* Where the note sits, first. Each step is one indent further than the one
          above, and each row carries its own `--guide-x` so the guide finds it.
          The vault itself is not a step. A note at the root says so in one row. */}
      <Section title="Path" count={trail.length} startOpen={trail.length > 0}>
        {trail.length === 0 ? (
          <li style={{ paddingLeft: stepIn(1) }}>
            <NoteRow icon={<RowIcon />} name="At the top of the vault." disabled />
          </li>
        ) : (
          trail.map((folder, depth) => {
            const note = folderNoteRef(folder)
            return (
              <Row
                key={folder.path}
                file={note}
                icon={icons[note.path]}
                depth={depth}
                onOpen={onOpen}
              />
            )
          })
        )}
      </Section>
      {inside && insideCount > 0 && (
        <Section title="Inside" count={insideCount} startOpen>
          {inside}
        </Section>
      )}
      {/* In every note, even with no backlinks, so the section is always
          in the same place. Shut when empty, so it takes one row. */}
      <Section title="Backlinks" count={backlinks.length} startOpen={backlinks.length > 0}>
        {backlinks.length === 0 ? (
          // A row, not a line of text, so its words line up with every other row's.
          <li style={{ paddingLeft: stepIn(1) }}>
            <NoteRow icon={<RowIcon />} name="Nothing links here yet." disabled />
          </li>
        ) : (
          backlinks.map(({ note, count, mentions }) => (
            <Row
              key={note.path}
              file={note}
              icon={icons[note.path]}
              count={count > 1 ? count : undefined}
              onOpen={onOpen}
            >
              {/* The lines open the note too. They are most of a
                  backlink on screen, and clicking them did nothing. */}
              <ul className="backlink-lines" onClick={() => opensNote(() => onOpen(note))}>
                {/* A quoted line reads as the note does, so a
                    link shows its name (`readable`). */}
                {mentions.map((line) => (
                  <li key={line}>{readable(line)}</li>
                ))}
              </ul>
            </Row>
          ))
        )}
      </Section>
    </>
  )
}

/**
 * A note in one of these sections: the tree's leaf row, one step in per
 * level. `--guide-x` is the folder's own indent, as the tree passes down.
 */
function Row({
  file,
  icon,
  count,
  depth = 0,
  onOpen,
  children,
}: {
  file: VaultFile
  icon: string | undefined
  count?: number
  depth?: number
  onOpen: (file: VaultFile) => void
  children?: ReactNode
}) {
  return (
    <li
      style={{ paddingLeft: stepIn(depth + 1), ...guideAt(depth) }}
    >
      <NoteRow
        icon={<RowIcon icon={icon ?? DEFAULT_NOTE_ICON} />}
        name={file.name}
        trailing={
          count !== undefined ? <span className="row-count">{count}</span> : undefined
        }
        onClick={() => onOpen(file)}
      />
      {children}
    </li>
  )
}

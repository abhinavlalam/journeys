import type { ReactNode } from 'react'
import { DEFAULT_NOTE_ICON } from './icons'
import { guideAt, NoteRow, opensNote, readable, stepIn, RowIcon, Section } from './rows'
import type { Backlink } from './links'
import { folderNoteRef, type VaultFile, type VaultFolder } from './vaultModel'

interface NoteFooterProps {
  /**
   * The tree of what is inside this note, when it is a nested one — drawn by the
   * caller with `FolderTree`, the left pane's own component, so a subfolder in
   * there expands and shows what is inside *it* too. Null for a plain note, which
   * is what takes the section off the end of it.
   */
  inside: ReactNode
  /** Its direct children, for the count beside the heading. */
  insideCount: number
  backlinks: Backlink[]
  /**
   * The folders this note is reached through, outermost first. Each is a note of
   * its own — a folder *is* a note here — so each is a row that opens one.
   */
  trail: VaultFolder[]
  /** Its own icon, per path, so a row here wears what its row in the tree wears. */
  icons: Record<string, string>
  onOpen: (file: VaultFile) => void
}

/**
 * The end of a note: what is inside it, and what links to it.
 *
 * **The left pane's rows, at the end of the text.** A section is a `folder-header`
 * with a chevron, its items are `file-row`s inside a `folder-children`, and the
 * guide lines come off the same `--guide-x` — so a list here reads as the list of
 * the same notes in the tree, because it is drawn by the same rules. The heading
 * takes the app's label format, which is what a property's name and a timestamp
 * take.
 *
 * It is *appended* to the note rather than pinned under it: the editor grows with
 * its text (see `.code-editor` in the sheet) and these follow the last line.
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
      {/* **Where the note sits, before what it holds and what points at it.** The
          three sections read outward. Each step is indented one further than the
          one above it, so the section draws the descent rather than listing it —
          and each row carries its own `--guide-x`, which is how the tree's trunk
          and elbow find a row whose depth is its own.

          The vault is **not** a step: it is where every note in the pane is, so a
          row saying so is a row that says nothing. A note at the root has no path,
          and the section says that in one row rather than naming the folder the
          whole app is already showing. */}
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
      {/* **In every note**, with or without anything in it: a note with no
          backlinks is a fact about the note, and a section that appears and
          disappears is one you cannot learn the position of. Shut when it is
          empty, so it costs one row. */}
      <Section title="Backlinks" count={backlinks.length} startOpen={backlinks.length > 0}>
        {backlinks.length === 0 ? (
          // A row, and not a line of text at that indent: a row puts its words
          // where every other row's words are, past the chevron's column and the
          // icon's. As text it sat at the indent itself, under the guide's elbow.
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
              {/* **The lines open the note too.** They are most of what a
                  backlink *is* on screen — the row above is a name and these are
                  the sentence it was written in — and a click on them did nothing,
                  which read as a backlink that needed two clicks. */}
              <ul className="backlink-lines" onClick={() => opensNote(() => onOpen(note))}>
                {/* A quotation reads as the note reads, so a link in one is its
                    name — `readable`, the same answer the collection page gives. */}
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

/** A note in one of those sections: the tree's leaf row, indented one step per
 *  level, so the guide line finds it where it finds a note that deep in the tree.
 *  `--guide-x` is the folder's own indent, which is what the tree hands down. */
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

import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { listVaultDir, listVaultEntries, vaultFileRef } from './vault'
import { noteName } from './vaultModel'
import type { VaultFile } from './vaultModel'
import { GroupRow, NameField, NoteRow, stepIn, RowIcon } from './rows'
import {
  creatable,
  createAction,
  declares,
  groupKey,
  inDir,
  views,
  type ActionKind,
  type ViewKind,
} from './actionKinds'
import { PlusIcon } from './icons'


interface ActionsPaneProps {
  vaultPath: string
  /** How deep its group rows sit: `1` under the left pane's Actions heading. The
   *  rows are `li`s for the caller's list, as `FolderTree`'s are. */
  depth: number
  /** The kinds to draw — `BUILT_IN_KINDS`, which is the whole list. */
  kinds: readonly ActionKind[]
  /** The open file, so its row reads as selected. */
  selectedPath: string | null
  onSelect: (file: VaultFile) => void
  /** Shows what a collection collects. A collection has no file to open — its row
   *  is a `--keyword` the notes carry, so the click asks the vault rather than the
   *  disk. */
  onView: (kind: ViewKind, name: string) => void
  /** The collection whose view is open, so its row reads as selected the way an
   *  open file's does. There is no path to compare. */
  /** The page that is open — a collection's or a property's — so its row is marked. */
  viewing: { kind: ViewKind; name: string } | null
  /**
   * The groups the user has **opened** — `useFolderOpenState`'s own `open` set and
   * its `toggle`, so the header's collapse-all and expand-all reach these rows for
   * free, and a group the user opened is still open next launch.
   *
   * Open rather than shut, because a group is **shut until it is opened**: five
   * groups spread out on arrival is a wall of rows nobody asked for, and it is what
   * the tree's folders do.
   */
  openGroups: ReadonlySet<string>
  onToggleGroup: (path: string, open: boolean) => void
  /** Starts naming one of a kind, from that kind's own `+`. */
  onNew: (kind: string) => void
  /** A folder this pane could not read. Silence there is an empty group over a
   *  folder with files in it, which is how two fs-scope bugs survived. */
  onError: (message: string) => void
  /** The search field's text, when it is open. Filters rows by name; the tree's
   *  own search reads note *text*, and there is no text here to read — a file's
   *  contents are what opening it is for. */
  query: string
  /** Bumped when a file has been written, which is the moment to list again.
   *  Not the name field closing: that happens *before* the write finishes, and a
   *  read racing it comes back without the new file. */
  revision: number
  /**
   * What the **declaring** kind has declared, by name and keyed by kind — rows of
   * their own before any note carries one, because declaring is how you set one up.
   * One kind declares: a collection declares a line's structure. Keyed by kind
   * rather than a bare list so a second one could, without the prop changing shape.
   */
  declared: Partial<Record<string, readonly string[]>>
  /**
   * The names the vault's notes **use**, per kind, and how many notes use each.
   *
   * A group with an entry here is the **union** of the files that define one of its
   * kind and the names in play: a property typed into a note's block turns up
   * under Properties, and a `--keyword` written on a line turns up under
   * Collections. What clicking one does is the kind's business — a property with no
   * file yet gets one, which is the `+`'s act minus the typing; a collection has no
   * file to get, so it opens the lines it collects.
   *
   * Keyed by kind rather than one list per kind, because it is one mechanism: the
   * *reading* differs (a block's keys, a line's opener) and that belongs to the
   * module that owns the syntax, not here.
   */
  used: Partial<Record<string, readonly { name: string; notes: number }[]>>
  /** The kind being named, and the name so far. Held by `App`, like the tree's
   *  inline create, because the button that starts it is in the row above. */
  naming: string | null
  typed: string
  onTyped: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}

/** What is on disk, per kind. */
type Listing = Record<string, string[]>

/**
 * The Actions section of the left pane.
 *
 * **The tree's own markup, and not one class of its own.** A group is a
 * `folder-header` with a chevron and a `folder-toggle`, its files are
 * `file-row`s inside a `folder-children`, and the guide lines come off the same
 * `--guide-x` at the same depth. Anything else would be a second sidebar to keep
 * in step with the first.
 *
 * What it does not borrow is the tree's *machinery*: nothing here is dragged,
 * renamed in place or given an icon, because none of that has been asked for.
 */
export function ActionsPane({
  vaultPath,
  depth,
  kinds,
  selectedPath,
  onSelect,
  onView,
  viewing,
  declared,
  openGroups,
  onToggleGroup,
  onNew,
  onError,
  query,
  used,
  revision,
  naming,
  typed,
  onTyped,
  onCommit,
  onCancel,
}: ActionsPaneProps) {
  const [listing, setListing] = useState<Listing>({})

  /** Answers with the listing rather than setting it, so the caller decides
   *  whether it is still wanted — a read that lands after the vault changed is the
   *  wrong answer, and the effect below is the one that knows. */
  const read = useCallback(async (): Promise<Listing> => {
    const found: Listing = {}
    // A kind with no folder has no files to list — see `ActionKind.dir`. Asking
    // for one would be a `readDir` of the vault root dressed up as its contents.
    for (const kind of kinds) {
      // A declaring kind's files are not its rows — `App` reads those for their
      // *contents*, and hands the names in as `declared`. Listing them here too
      // would be one folder read twice for two halves of one answer.
      found[kind.key] = kind.dir === null
        ? []
        : kind.entry
          ? await listVaultEntries(vaultPath, kind.dir, kind.entry)
          : await listVaultDir(vaultPath, kind.dir)
    }
    return found
  }, [vaultPath, kinds])

  /**
   * On mount, on the app's own writes (`revision`), and **on window focus** — the
   * trigger `useVaultTexts` already re-reads the notes on, and for the same reason:
   * things are written into this vault by hands other than this app's. A skill made
   * by the agent in the Terminal tab appeared on disk twenty-three seconds after
   * the app had read this list and stayed invisible until a relaunch, reported as
   * "I do not see it". The notes it wrote showed up on the next focus; the row for
   * the skill did not, because only this listing had no such trigger.
   */
  useEffect(() => {
    let live = true
    const refresh = () =>
      read()
        .then((found) => {
          if (live) setListing(found)
        })
        .catch((err: unknown) => {
          if (live) onError(`Could not list the Actions folders: ${String(err)}`)
        })
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      live = false
      window.removeEventListener('focus', refresh)
    }
  }, [read, revision])

  const needle = query.trim().toLowerCase()

  /**
   * The rows for one kind: the files it holds, and the names the notes *use*,
   * whether or not a file defines them yet.
   *
   * `file` is null for a name that is only in use. Its row is not a lesser row:
   * the count says how many notes carry it, and clicking it is how it gets a file.
   */
  function rowsFor(kind: ActionKind) {
    const rows = (listing[kind.key] ?? []).map((file) => ({
      // `noteName` takes `.md` off and leaves `settings.json` as it is, which is
      // right both times: a note is known by its name and a JSON file by its file.
      // **A skill's name is its folder's.** Every one of them is called `SKILL.md`,
      // so the file's own basename names nothing — `vaultFileRef` draws the same
      // distinction for the row it opens.
      name: noteName(kind.entry && file.endsWith(`/${kind.entry}`) ? file.slice(0, -(kind.entry.length + 1)) : file),
      file: inDir(kind, file) as string | null,
      notes: 0,
    }))
    const inPlay = [
      ...(used[kind.key] ?? []),
      // A declared collection is a collection: it has a row from the moment its
      // structure is written, with no note carrying it yet.
      ...(declares(kind) ? (declared[kind.key] ?? []).map((name) => ({ name, notes: 0 })) : []),
    ]
    if (inPlay.length === 0) return rows
    const byName = new Map(rows.map((row) => [row.name.toLowerCase(), row]))
    for (const entry of inPlay) {
      const at = entry.name.toLowerCase()
      const seen = byName.get(at)
      // `max`, because one name can arrive twice — in use *and* declared — and the
      // declared half carries no count.
      if (seen) seen.notes = Math.max(seen.notes, entry.notes)
      else byName.set(at, { name: entry.name, file: null, notes: entry.notes })
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** A name in use, given the file that defines it. The `+` asks for a name; this
   *  is the same act for a name the notes already carry. */
  async function define(kind: ActionKind, name: string) {
    const made = await createAction(vaultPath, kind, name)
    setListing(await read())
    if (made) onSelect(made)
  }

  return (
    <>
      {kinds.map((kind) => {
        const path = groupKey(kind)
        const rows = rowsFor(kind).filter(
          (row) => !needle || row.name.toLowerCase().includes(needle)
        )
        // **Shut until opened**, which is what the tree's folders do and the same
        // `open` set that remembers them — a section that opens with five groups
        // spread out is a wall of rows nobody asked for. A query opens whatever it
        // matches, or searching a collapsed pane would answer with nothing.
        const expanded = openGroups.has(path) || (needle !== '' && rows.length > 0)
        return (
          <li className="folder-row" key={kind.key} style={{ paddingLeft: stepIn(depth) }}>
            <GroupRow
              name={kind.label}
              open={expanded}
              onToggle={() => onToggleGroup(path, expanded)}
              icon={<RowIcon icon={kind.icon} />}
              actions={
                // The kind's own `+`, where the kind is — the rail's asks which one
                // and this one already knows. Config has none: those files arrive
                // with the app. In `actions` and not `trailing`, because that slot
                // is inside the toggle and a button cannot hold a button.
                creatable(kind) ? (
                  <span className="folder-actions">
                    <button
                      aria-label={`New ${kind.singular.toLowerCase()}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation()
                        onNew(kind.key)
                      }}
                    >
                      <PlusIcon />
                    </button>
                  </span>
                ) : undefined
              }
            />
            {(expanded || naming === kind.key) && (
              <ul className="folder-children" style={{ '--guide-x': stepIn(depth) } as CSSProperties}>
                {rows.map((row) => {
                  // `inDir` already made it vault-relative — see `rowsFor`.
                  const file = row.file ? vaultFileRef(vaultPath, row.file) : null
                  return (
                    // The tree's own indent for a child of a top-level row: its
                    // `folder-children` sets `--guide-x` to the parent's depth and
                    // pads each child one step past it. Measured against a nested
                    // note: both land on x=26 with the name at x=74.
                    //
                    // `file` is null for a property the notes carry that nothing
                    // defines yet: the count says how many carry it, and the click
                    // writes the file.
                    <li key={row.name} style={{ paddingLeft: stepIn(depth + 1) }}>
                      <NoteRow
                        className={
                          (
                            views(kind)
                              ? viewing?.kind === kind.key && viewing.name === row.name
                              : file !== null && file.path === selectedPath
                          )
                            ? 'selected'
                            : undefined
                        }
                        icon={<RowIcon icon={kind.icon} />}
                        name={row.name}
                        trailing={
                          row.notes > 0 ? <span className="row-count">{row.notes}</span> : undefined
                        }
                        // Three sorts of row: a viewing kind's opens its page, a
                        // file opens, and a name in use with no file yet gets one.
                        onClick={() =>
                          views(kind)
                            ? onView(kind.key, row.name)
                            : file
                              ? onSelect(file)
                              : void define(kind, row.name)
                        }
                      />
                    </li>
                  )
                })}
                {naming === kind.key && (
                  <li style={{ paddingLeft: stepIn(depth + 1) }}>
                    <NameField
                      value={typed}
                      placeholder={`${kind.singular} name…`}
                      onChange={onTyped}
                      onSubmit={onCommit}
                      onCancel={onCancel}
                      // Cancels, as the tree's create row does: a half-typed name
                      // left behind must not become a file.
                      onBlur={onCancel}
                    />
                  </li>
                )}
              </ul>
            )}
          </li>
        )
      })}
    </>
  )
}

/** One of these, where `label` names the group of them: what a menu offers and
 *  what a name field asks for. */

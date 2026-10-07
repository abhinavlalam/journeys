import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { listVaultDir, listVaultEntries, vaultFileRef } from './vault'
import { noteName } from './vaultModel'
import type { VaultFile } from './vaultModel'
import { AddButton, GroupRow, guideAt, NameField, NoteRow, stepIn, RowIcon } from './rows'
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

/** One row of a kind: a file it holds, or a name the notes use. */
interface Row {
  name: string
  file: string | null
  notes: number
}

/**
 * A row, or a head that rows nest under on `/`: `listening` for
 * `listening/podcast`. A head no row names is only a group.
 */
interface Branch {
  name: string
  head: string
  row?: Row
  children: Branch[]
}

/** A name's parts on `/`. Tags nest by this; other kinds have no `/`. */
const partsOf = (name: string) => name.split('/').filter(Boolean)

/** Rows as a tree on `/`, in the given order. */
function branches(rows: readonly Row[]): Branch[] {
  const top: Branch[] = []
  const byHead = new Map<string, Branch>()
  for (const row of rows) {
    const parts = partsOf(row.name)
    let level = top
    parts.forEach((part, at) => {
      const head = parts.slice(0, at + 1).join('/').toLowerCase()
      let branch = byHead.get(head)
      if (!branch) {
        branch = { name: part, head, children: [] }
        byHead.set(head, branch)
        level.push(branch)
      }
      if (at === parts.length - 1) branch.row = row
      level = branch.children
    })
  }
  return top
}

/** A nested group's key in the open set, under its kind's key. */
export const branchKey = (kind: ActionKind, head: string) => `${groupKey(kind)}/${head.toLowerCase()}`

/**
 * Every head that names nest under, once each (`a` and `a/b` for
 * `a/b/c`), so Expand all opens them too.
 */
export function headsOf(names: readonly string[]): string[] {
  const heads = new Set<string>()
  for (const name of names) {
    const parts = partsOf(name)
    for (let at = 1; at < parts.length; at++) heads.add(parts.slice(0, at).join('/').toLowerCase())
  }
  return [...heads]
}


interface ActionsPaneProps {
  vaultPath: string
  /**
   * How deep its group rows sit: `1` under the Actions heading.
   * The rows are `li`s for the caller's list, as in `FolderTree`.
   */
  depth: number
  /** The kinds to draw. */
  kinds: readonly ActionKind[]
  /** The open file, so its row shows as selected. */
  selectedPath: string | null
  onSelect: (file: VaultFile) => void
  /**
   * Opens a tag's or a property's page. Neither is a file; the
   * page is built from the notes.
   */
  onView: (kind: ViewKind, name: string) => void
  /** The open tag or property page, so its row is marked. */
  viewing: { kind: ViewKind; name: string } | null
  /**
   * The groups that are open, from `useFolderOpenState`, so Collapse all and Expand all
   * reach them and they stay open next launch. A group starts shut, as a folder does.
   */
  openGroups: ReadonlySet<string>
  onToggleGroup: (path: string, open: boolean) => void
  /** Starts naming a new one of a kind, from that kind's `+`. */
  onNew: (kind: string) => void
  /**
   * A folder this pane could not read. Staying quiet would show
   * an empty group over a folder with files in it.
   */
  onError: (message: string) => void
  /** The search field's text, when open. Filters rows by name. */
  query: string
  /**
   * Bumped after a file is written, which is when to list again. Not
   * when the name field closes: that is before the write finishes.
   */
  revision: number
  /**
   * What a declaring kind has declared, by kind: a tag's
   * structure gives it a row before any note uses it.
   */
  declared: Partial<Record<string, readonly string[]>>
  /**
   * The names the notes use, per kind, and how many notes use each: a property a
   * note carries appears under Properties, a `#tag` under Tags. Clicking one
   * opens its page. Each module that owns the syntax does the reading.
   */
  used: Partial<Record<string, readonly { name: string; notes: number }[]>>
  /**
   * The kind being named and the name so far. Held by `App`,
   * like the tree's inline create.
   */
  naming: string | null
  typed: string
  onTyped: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}

/** What is on disk, per kind. */
type Listing = Record<string, string[]>

/**
 * The Actions section of the left pane. It uses the tree's own markup and
 * classes (`folder-header`, `file-row`, `folder-children`, `--guide-x`), so
 * it looks the same. Nothing here drags, renames in place or takes an icon.
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

  /**
   * Returns the listing rather than setting it, so the effect
   * below can drop a read that lands after the vault changed.
   */
  const read = useCallback(async (): Promise<Listing> => {
    const found: Listing = {}
    // A kind with no folder (tags, properties) has no files to
    // list. Its rows are names from the notes.
    for (const kind of kinds) {
      found[kind.key] = kind.dir === null
        ? []
        : kind.entry
          ? await listVaultEntries(vaultPath, kind.dir, kind.entry)
          : await listVaultDir(vaultPath, kind.dir)
    }
    return found
  }, [vaultPath, kinds])

  /**
   * Listed on mount, after the app's own writes (`revision`), and on
   * window focus. Other programs write to the vault too: a skill made
   * by the agent in the terminal did not appear until a relaunch.
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
   * The rows for one kind: the files it holds, and the names the notes use
   * with or without a file. `file` is null for a name only in use; its
   * count says how many notes carry it, and clicking it makes the file.
   */
  function rowsFor(kind: ActionKind): Row[] {
    const rows: Row[] = (listing[kind.key] ?? []).map((file) => ({
      // `noteName` drops `.md` and leaves `settings.json` as is. A skill is named by
      // its folder, since every skill file is `SKILL.md`; `vaultFileRef` does the same.
      name: noteName(kind.entry && file.endsWith(`/${kind.entry}`) ? file.slice(0, -(kind.entry.length + 1)) : file),
      file: inDir(kind, file) as string | null,
      notes: 0,
    }))
    const inPlay = [
      ...(used[kind.key] ?? []),
      // A declared tag has a row as soon as its structure is
      // written, before any note uses it.
      ...(declares(kind) ? (declared[kind.key] ?? []).map((name) => ({ name, notes: 0 })) : []),
    ]
    if (inPlay.length === 0) return rows
    const byName = new Map(rows.map((row) => [row.name.toLowerCase(), row]))
    for (const entry of inPlay) {
      const at = entry.name.toLowerCase()
      const seen = byName.get(at)
      // `max`, because a name can come in twice, in use and
      // declared, and the declared one has no count.
      if (seen) seen.notes = Math.max(seen.notes, entry.notes)
      else byName.set(at, { name: entry.name, file: null, notes: entry.notes })
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * A name in use, given the file that defines it. The same as
   * the `+`, for a name the notes already carry.
   */
  async function define(kind: ActionKind, name: string) {
    const made = await createAction(vaultPath, kind, name)
    setListing(await read())
    if (made) onSelect(made)
  }

  /**
   * Three kinds of row: a page kind's row opens its page, a file
   * opens, and a name in use with no file gets one.
   */
  function press(kind: ActionKind, row: Row) {
    if (views(kind)) onView(kind.key, row.name)
    else if (row.file) onSelect(vaultFileRef(vaultPath, row.file))
    else void define(kind, row.name)
  }

  /**
   * A row, or a group of the rows under it. When the head is a row
   * too (a tag with tags under it), its name opens it, like a folder.
   */
  function drawBranch(kind: ActionKind, branch: Branch, depth: number): ReactNode {
    const { row } = branch
    const count = row && row.notes > 0 ? <span className="row-count">{row.notes}</span> : undefined
    if (branch.children.length === 0 && row) {
      // `inDir` already made it vault-relative; see `rowsFor`.
      const file = row.file ? vaultFileRef(vaultPath, row.file) : null
      const selected = views(kind)
        ? viewing?.kind === kind.key && viewing.name === row.name
        : file !== null && file.path === selectedPath
      return (
        // The tree's own indent for a child: `folder-children` sets `--guide-x`
        // to the parent's depth, and each child sits one step past it.
        <li key={branch.head} style={{ paddingLeft: stepIn(depth) }}>
          <NoteRow
            className={selected ? 'selected' : undefined}
            icon={<RowIcon icon={kind.icon} />}
            name={branch.name}
            trailing={count}
            onClick={() => press(kind, row)}
          />
        </li>
      )
    }
    const key = branchKey(kind, branch.head)
    // A search opens whatever matches, as the kind's own group does.
    const open = openGroups.has(key) || needle !== ''
    return (
      <li className="folder-row" key={branch.head}>
        <GroupRow
          depth={depth}
          name={branch.name}
          open={open}
          onToggle={() => onToggleGroup(key, open)}
          icon={<RowIcon icon={kind.icon} />}
          trailing={count}
          onOpen={row ? () => press(kind, row) : undefined}
        />
        {open && (
          <ul className="folder-children" style={guideAt(depth)}>
            {branch.children.map((child) => drawBranch(kind, child, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <>
      {kinds.map((kind) => {
        const path = groupKey(kind)
        const rows = rowsFor(kind).filter(
          (row) => !needle || row.name.toLowerCase().includes(needle)
        )
        // Shut until opened, like the tree's folders, in the same `open` set. A search
        // opens whatever matches, or searching a folded pane would find nothing.
        const expanded = openGroups.has(path) || (needle !== '' && rows.length > 0)
        return (
          <li className="folder-row" key={kind.key}>
            <GroupRow
              depth={depth}
              name={kind.label}
              open={expanded}
              onToggle={() => onToggleGroup(path, expanded)}
              icon={<RowIcon icon={kind.icon} />}
              actions={
                // The kind's own `+`. Config has none: its files come with the app. In
                // `actions`, not `trailing`, because a button cannot hold a button.
                creatable(kind) ? (
                  <span className="folder-actions">
                    <AddButton label={`New ${kind.singular.toLowerCase()}`} onPress={() => onNew(kind.key)} />
                  </span>
                ) : undefined
              }
            />
            {(expanded || naming === kind.key) && (
              <ul className="folder-children" style={guideAt(depth)}>
                {branches(rows).map((branch) => drawBranch(kind, branch, depth + 1))}
                {naming === kind.key && (
                  <li style={{ paddingLeft: stepIn(depth + 1) }}>
                    <NameField
                      value={typed}
                      placeholder={`${kind.singular} name…`}
                      onChange={onTyped}
                      onSubmit={onCommit}
                      onCancel={onCancel}
                      // Leaving cancels, as in the tree's create row,
                      // so a half-typed name never becomes a file.
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

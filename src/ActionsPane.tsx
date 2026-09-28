import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { listVaultDir, listVaultEntries, vaultFileRef } from './vault'
import { noteName } from './vaultModel'
import type { VaultFile } from './vaultModel'
import { GroupRow, guideAt, NameField, NoteRow, stepIn, RowIcon } from './rows'
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

/** One row of a kind: a file it holds, or a name the notes use. */
interface Row {
  name: string
  file: string | null
  notes: number
}

/** A row, or a head other rows nest under on `/`: `listening` for
 *  `listening/podcast`. A head no row names is only a group. */
interface Branch {
  name: string
  head: string
  row?: Row
  children: Branch[]
}

/** A name's parts on `/` — the one rule tags nest by, and harmless to a kind whose
 *  names have none. */
const partsOf = (name: string) => name.split('/').filter(Boolean)

/** Rows as a tree on `/`, in the order given. */
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

/** A nested group's key in the one open set, under its kind's own. */
export const branchKey = (kind: ActionKind, head: string) => `${groupKey(kind)}/${head.toLowerCase()}`

/** Every head names nest under, each once — `a` and `a/b` for `a/b/c` — so the
 *  section's Expand all opens them too. */
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
  /** How deep its group rows sit: `1` under the left pane's Actions heading. The
   *  rows are `li`s for the caller's list, as `FolderTree`'s are. */
  depth: number
  /** The kinds to draw — `BUILT_IN_KINDS`, which is the whole list. */
  kinds: readonly ActionKind[]
  /** The open file, so its row reads as selected. */
  selectedPath: string | null
  onSelect: (file: VaultFile) => void
  /** Shows a tag's or a property's page. Neither has a file to open — its row is a
   *  name the notes carry, so the click asks the vault rather than the disk. */
  onView: (kind: ViewKind, name: string) => void
  /** The page that is open — a tag's or a property's — so its row is marked. */
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
   * One kind declares: a tag declares its structure. Keyed by kind rather than a
   * bare list so a second one could, without the prop changing shape.
   */
  declared: Partial<Record<string, readonly string[]>>
  /**
   * The names the vault's notes **use**, per kind, and how many notes use each.
   *
   * A group with an entry here is the **union** of the files that define one of its
   * kind and the names in play: a property a note carries turns up under
   * Properties, and a `#tag` written on a line under Tags. Clicking one opens its
   * page, which is the notes asked back.
   *
   * Keyed by kind rather than one list per kind, because it is one mechanism: the
   * *reading* differs (a property's name, a tag) and that belongs to the
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
  function rowsFor(kind: ActionKind): Row[] {
    const rows: Row[] = (listing[kind.key] ?? []).map((file) => ({
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
      // A declared tag is a tag: it has a row from the moment its structure is
      // written, with no note carrying it yet.
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

  /** Three sorts of row: a viewing kind's opens its page, a file opens, and a name
   *  in use with no file yet gets one. */
  function press(kind: ActionKind, row: Row) {
    if (views(kind)) onView(kind.key, row.name)
    else if (row.file) onSelect(vaultFileRef(vaultPath, row.file))
    else void define(kind, row.name)
  }

  /** A row, or a group of the rows nesting under it — its own row too, when the
   *  head is one: a tag with tags under it opens from its name, like a folder. */
  function drawBranch(kind: ActionKind, branch: Branch, depth: number): ReactNode {
    const { row } = branch
    const count = row && row.notes > 0 ? <span className="row-count">{row.notes}</span> : undefined
    if (branch.children.length === 0 && row) {
      // `inDir` already made it vault-relative — see `rowsFor`.
      const file = row.file ? vaultFileRef(vaultPath, row.file) : null
      const selected = views(kind)
        ? viewing?.kind === kind.key && viewing.name === row.name
        : file !== null && file.path === selectedPath
      return (
        // The tree's own indent for a child row: its `folder-children` sets
        // `--guide-x` to the parent's depth and pads each child one step past it.
        // `file` is null for a name the notes carry that nothing defines yet: the
        // count says how many carry it, and the click writes the file.
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
    // A query opens what it matches, as the kind's own group does.
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
        // **Shut until opened**, which is what the tree's folders do and the same
        // `open` set that remembers them — a section that opens with five groups
        // spread out is a wall of rows nobody asked for. A query opens whatever it
        // matches, or searching a collapsed pane would answer with nothing.
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

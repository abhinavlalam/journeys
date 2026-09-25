// **The kinds of thing the Actions section holds, as data.** A kind is a fact about
// the vault's layout, not about a pane: a folder, a glyph, what a row opens, what
// the `+` makes. Five arrive with the app, and the pane, the `+` menu and
// collapse-all read this list and nothing else. No React in here, so `App` and the
// pane both import a fact rather than each other.
//
// A vault used to be able to add kinds of its own through `.config/kinds.json`. It
// was built toward a "tracks pieces of life" framework, no vault ever wrote the
// file, and it is gone: a registry nobody registers into is machinery carried for
// a future that did not arrive. If it is wanted again, the shape is in the history.

import { CONFIG_DIR, safeName, SKILL_FILE, vaultFileRef, writeVaultDirFile } from './vault'
import type { VaultFile } from './vaultModel'

/** The two pages a row can open instead of a file. Code, not data: each is a
 *  view the app draws, so a vault cannot declare one. */
export type ViewKind = 'collection' | 'property' | 'tag'

export interface ActionKind {
  key: string
  /** The group's name in the pane. */
  label: string
  /** What the `+` makes one of, and what its field asks for: "Skill name…". */
  singular: string
  /**
   * **Where a kind's files are, from the vault root** — dot folder and all, since a
   * vault's skills are Claude Code's layout (`.claude/skills`) and not this app's to
   * move. `''` is the config folder's own files; `null` is a kind with no files at
   * all, whose rows are what the notes *use*.
   */
  dir: string | null
  icon: string
  /** The kind's items are **folders** holding this file — a skill is
   *  `<name>/SKILL.md` — and a row is named for its folder. */
  entry?: string
  /** The `+` writes an entry in `collections.json` rather than a file. Only a
   *  collection does. */
  declares?: true
  /** The row opens a page of what the notes say, not a file. */
  views?: true
  /** Whether the `+` makes one. Said outright: a collection has no folder and is
   *  made, Config has a folder and is not — its files arrive with the app. */
  creatable?: true
}

export const BUILT_IN_KINDS: readonly ActionKind[] = [
  // `views`: the row opens a page of what the notes say, not a file. A collection
  // and a property both do — the second was three empty `.md`s named after
  // properties, which is the mistake the first had already corrected.
  { key: 'collection', label: 'Collections', singular: 'Collection', dir: null, icon: 'archive', declares: true, views: true, creatable: true },
  { key: 'skill', label: 'Skills', singular: 'Skill', dir: '.claude/skills', entry: SKILL_FILE, icon: 'zap', creatable: true },
  // **No folder and no `+`, the arrangement Properties has.** A tag exists because a
  // note carries `#word`, so a file named after one is an empty page named after a
  // thing — the correction collections and properties have both already had. Its
  // row opens the notes that say it.
  { key: 'tag', label: 'Tags', singular: 'Tag', dir: null, icon: 'tag', views: true },
  // No folder and no `+`: a property exists when a note carries it, and its page
  // is every note that does with the value each gives. It declared for a while —
  // `properties.json`, what a new note starts with — and that is gone with the
  // feature: a template stamped into every new note is a data-collection mechanism
  // in a journal, and no vault ever wrote the file.
  { key: 'property', label: 'Properties', singular: 'Property', dir: null, icon: 'list', views: true },
  { key: 'config', label: 'Config', singular: 'Config note', dir: CONFIG_DIR, icon: 'key' },
]

export const creatable = (kind: ActionKind) => kind.creatable === true
export const declares = (kind: ActionKind) => kind.declares === true
/** A guard, so `kind.key` is a `ViewKind` where it is true and `onView` need not
 *  accept every other key. */
export const views = (kind: ActionKind): kind is ActionKind & { key: ViewKind } => kind.views === true

/**
 * The key a group's open state is kept under — `useFolderOpenState`'s own, the
 * same hook and the same collapse-all the tree's folders use. Off the **kind** and
 * not its folder: a kind need not have one, and two that don't would otherwise
 * share a key and open together.
 */
export const groupKey = (kind: ActionKind) => `${CONFIG_DIR}/${kind.key}`

/** Where a file of this kind lives, **from the vault root**. Config's own `dir` is
 *  the folder itself, so this is what keeps a `//` out of the path. */
export const inDir = (kind: ActionKind, file: string) => (kind.dir ? `${kind.dir}/${file}` : file)

/**
 * Writes a new file of a kind and answers with it.
 *
 * Here rather than in the pane because `App` owns the name field — the `+` that
 * starts it is in the header, beside the tree's own — and this is the half that
 * touches a disk. **A kind with no folder has no file to make**: a collection's
 * structure is an entry in `collections.json` and a property is whatever the notes
 * carry; a null `dir` would otherwise splice a stray `name.md` into the vault root.
 */
export async function createAction(
  vaultPath: string,
  kind: ActionKind,
  typed: string
): Promise<VaultFile | null> {
  if (kind.dir === null) return null
  // The creators' rule, as everywhere else a name is typed: the path is spliced
  // from this, so a `/` would put the file somewhere nobody picked.
  const name = safeName(typed)
  if (!name) return null
  // A skill is a folder holding `SKILL.md`, and it is **born valid**: Claude Code
  // will not load one whose frontmatter has no `name`. Everything else is empty —
  // the name is the file's name, and what the app reads out of a tag is still being
  // settled, so writing a shape now would invent that answer.
  const file = kind.entry ? `${kind.dir}/${name}/${kind.entry}` : `${kind.dir}/${name}.md`
  const body = kind.entry ? `---\nname: ${name}\ndescription:\n---\n` : ''
  await writeVaultDirFile(vaultPath, file, body)
  return vaultFileRef(vaultPath, file)
}

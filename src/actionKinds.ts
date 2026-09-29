// The kinds of thing the Actions pane holds, as data: a folder, a glyph,
// what a row opens, what the `+` makes. The pane, the `+` menu and Collapse
// all read this list. No React here, so `App` and the pane both import it.
//
// Vaults could once add kinds through `.config/kinds.json`. No
// vault ever did, so it was removed.

import { CONFIG_DIR, safeName, SKILL_FILE, vaultFileRef, writeVaultDirFile } from './vault'
import type { VaultFile } from './vaultModel'

/**
 * The two pages a row can open instead of a file. Code, since the app draws each one.
 */
export type ViewKind = 'property' | 'tag'

export interface ActionKind {
  key: string
  /** The group's name in the pane. */
  label: string
  /** What the `+` makes, and what its field asks for: "Skill name…". */
  singular: string
  /**
   * Where a kind's files are, from the vault root. Skills keep
   * Claude Code's layout (`.claude/skills`). `null` is a kind
   * with no files, whose rows are what the notes use.
   */
  dir: string | null
  icon: string
  /**
   * Each item is a folder holding this file (a skill is
   * `<name>/SKILL.md`), and the row is named for the folder.
   */
  entry?: string
  /** The `+` writes an entry in `tags.json`, not a file. Only tags do. */
  declares?: true
  /** The row opens a page built from the notes, not a file. */
  views?: true
  /**
   * Whether the `+` makes one. Said outright: a tag has no folder and is
   * made; Config has a folder and is not, since its files come with the app.
   */
  creatable?: true
}

export const BUILT_IN_KINDS: readonly ActionKind[] = [
  { key: 'skill', label: 'Skills', singular: 'Skill', dir: '.claude/skills', entry: SKILL_FILE, icon: 'zap', creatable: true },
  // No folder, and a `+` that declares. A tag exists because a note carries `#word` or
  // `tags.json` has its structure. Its row opens a page of its lines and properties.
  { key: 'tag', label: 'Tags', singular: 'Tag', dir: null, icon: 'tag', declares: true, views: true, creatable: true },
  // No folder and no `+`: a property exists when a note carries
  // it. Its page shows its values and its type; `properties.json`
  // holds only types. New notes are never stamped with properties.
  { key: 'property', label: 'Properties', singular: 'Property', dir: null, icon: 'list', views: true },
  { key: 'config', label: 'Config', singular: 'Config note', dir: CONFIG_DIR, icon: 'key' },
]

export const creatable = (kind: ActionKind) => kind.creatable === true
export const declares = (kind: ActionKind) => kind.declares === true
/** A guard, so `kind.key` is a `ViewKind` where it is true. */
export const views = (kind: ActionKind): kind is ActionKind & { key: ViewKind } => kind.views === true

/**
 * The key a group's open state is kept under, in `useFolderOpenState` like the tree's
 * folders. From the kind, not its folder: two kinds without folders would share a key.
 */
export const groupKey = (kind: ActionKind) => `${CONFIG_DIR}/${kind.key}`

/** Where a file of this kind lives, from the vault root, without a `//`. */
export const inDir = (kind: ActionKind, file: string) => (kind.dir ? `${kind.dir}/${file}` : file)

/**
 * Writes a new file of a kind and returns it. `App` owns the name field;
 * this is the part that writes. A kind with no folder makes no file: a
 * tag is an entry in `tags.json`, and a property is what the notes carry.
 */
export async function createAction(
  vaultPath: string,
  kind: ActionKind,
  typed: string
): Promise<VaultFile | null> {
  if (kind.dir === null) return null
  // Typed names go through `safeName`, so a `/` cannot put the file somewhere else.
  const name = safeName(typed)
  if (!name) return null
  // A skill is a folder holding `SKILL.md`, with a `name` in its
  // YAML, or Claude Code will not load it.
  const file = kind.entry ? `${kind.dir}/${name}/${kind.entry}` : `${kind.dir}/${name}.md`
  const body = kind.entry ? `---\nname: ${name}\ndescription:\n---\n` : ''
  await writeVaultDirFile(vaultPath, file, body)
  return vaultFileRef(vaultPath, file)
}

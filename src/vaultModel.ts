// The vault's shapes and the rules about names. No filesystem import
// belongs here: `vault.ts` imports `@tauri-apps/plugin-fs`, so a module
// that only needs to name a note takes its types from here and stays
// testable without a disk. Nothing is re-exported through `vault.ts`.

/** A file in the vault, a note or not. `fileKind` decides its kind from the path. */
export interface VaultFile {
  /** Vault-relative, `/`-separated, with the extension: `Ideas/pingbird.md`. */
  path: string
  absolutePath: string
  /** The basename without `.md`: what the tree shows. */
  name: string
}

export interface VaultFolder {
  /** Vault-relative. The empty string for the root. */
  path: string
  absolutePath: string
  name: string
  folders: VaultFolder[]
  files: VaultFile[]
  /**
   * The folder's own note: `Areas/Areas.md` for a folder named Areas. A nested
   * note is a folder plus a same-named note inside it, so a tree node is both
   * a note and a container. Undefined until the note is first typed in.
   */
  note?: VaultFile
}

// ---------------------------------------------------------------------------
// Operations on those shapes
// ---------------------------------------------------------------------------
//
// Facts about names that never touch a disk, here so callers don't import the
// filesystem.

/**
 * Whether two vault paths are one file. macOS volumes are
 * case-insensitive, so `exists()` says yes to `Index.md` when only
 * `index.md` is on disk, and a case-only rename would collide with itself.
 * `rename(2)` is fine with it; only the collision check needs this.
 */
export function isSamePath(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase()
}

/** Whether `path` is `folder` itself or anything inside it. A prefix is not a parent: `areas-old` is not in `areas`. */
export function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`)
}

/** Where `path` is once the folder `from` is at `to`; as it was when it is not inside. */
export function movedWith(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path
}

/** The file at a vault-relative path, named as the tree names it. */
export function fileAt(vaultPath: string, path: string): VaultFile {
  return { path, absolutePath: `${vaultPath}/${path}`, name: noteName(baseName(path)) }
}

/** The folder a vault-relative path is in, `''` at the root. */
export function folderOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/')
  return cut === -1 ? '' : relativePath.slice(0, cut)
}

/**
 * A folder's own note, whether or not it is on disk. It isn't created here, or
 * browsing would fill the vault with blank files; it is written on the first edit.
 */
export function folderNoteRef(folder: VaultFolder): VaultFile {
  return folder.note ?? { path: folderNotePath(folder.path), absolutePath: folderNotePath(folder.absolutePath), name: folder.name }
}

/** The file in the vault's `.config` that holds its settings. */
export const SETTINGS_FILE = 'settings.json'

/**
 * Whether a path is a note: a markdown file. Note machinery writes
 * page properties, which would break a `.json` file, so it asks this
 * first. A locked note is not one, in either spelling: only its owner
 * writes into it (an icon once went into a `.enc.md` as plain text).
 */
export function isNote(path: string): boolean {
  return path.toLowerCase().endsWith('.md') && !isEncrypted(path)
}

/**
 * Whether a path is a locked note, in both spellings: v1 wrote
 * `Private.enc.md`, and this app writes `.enc`. The format inside is the same.
 */
export function isEncrypted(path: string): boolean {
  return /\.enc(\.md)?$/i.test(path)
}

/** The last segment of a path: a file's or folder's name, extension included. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A file's extension, or `''`. A v1 locked note's is the whole `.enc.md`. */
export function extensionOf(path: string): string {
  return /\.enc\.md$/i.exec(path)?.[0] ?? /\.[^./]+$/.exec(path)?.[0] ?? ''
}

/**
 * A folder's own note from its path alone: `Areas/Plans` is `Areas/Plans/Plans.md`.
 * `folderNoteRef` is the same rule for a folder in the tree.
 */
export function folderNotePath(folder: string): string {
  return `${folder}/${baseName(folder)}.md`
}

/**
 * What a file in the vault is, and the only place that decides. The
 * tree shows every file; this decides what the pane does with it:
 *
 * - `note`, `json`, `csv`, `text` are text and open in the editor; typing saves them.
 * - `image` and `pdf` are shown, not edited (`FileView`).
 * - `other` is a file the app has nothing to show for.
 *
 * A `.enc` is a `note`; the passphrase is asked before anything reads it.
 */
export type FileKind = 'note' | 'json' | 'csv' | 'text' | 'image' | 'pdf' | 'other'

const KINDS: [RegExp, FileKind][] = [
  [/\.(md|enc)$/i, 'note'],
  [/\.json$/i, 'json'],
  // A `.tsv` is a CSV with tabs; `csvPreview` reads the line and decides.
  [/\.(csv|tsv)$/i, 'csv'],
  // `conf`, because the app writes one (`.config/tmux.conf`) and
  // has to be able to open it.
  [/\.(txt|log|ya?ml|toml|ini|env|conf)$/i, 'text'],
  [/\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i, 'image'],
  [/\.pdf$/i, 'pdf'],
]

export function fileKind(path: string): FileKind {
  return KINDS.find(([extension]) => extension.test(path))?.[1] ?? 'other'
}

/**
 * Whether the app reads this file as text: into the editor, and
 * into the vault read that the graph, backlinks and search use.
 * A PDF read as text would be a megabyte of nonsense.
 */
export function isTextFile(path: string): boolean {
  const kind = fileKind(path)
  return kind === 'note' || kind === 'json' || kind === 'csv' || kind === 'text'
}

/**
 * A path or name with the note extension taken off: the name a
 * row, link or graph node shows. Covers every extension a note
 * has: `.md`, and a locked note's `.enc.md` or `.enc`.
 */
export function noteName(path: string): string {
  return path.replace(/(\.enc)?\.md$/i, '').replace(/\.enc$/i, '')
}

/**
 * The path a note is known by: what the tree calls it and what a link should name. A
 * nested note is `Areas/Northwind`, not the file `Areas/Northwind/Northwind.md`,
 * which has no row. The extension goes too, since a link never has one.
 */
export function knownPath(path: string): string {
  const bare = noteName(path)
  const cut = bare.lastIndexOf('/')
  if (cut === -1) return bare
  const folder = bare.slice(0, cut)
  const name = bare.slice(cut + 1)
  const parent = baseName(folder)
  return isSamePath(parent, name) ? folder : bare
}

/** Where the last `names` names of a path begin, or 0 if there aren't that many. */
function tailFrom(path: string, names: number): number {
  let at = path.length
  for (let n = 0; n < names; n++) {
    const cut = path.lastIndexOf('/', at - 1)
    if (cut === -1) return 0
    at = cut
  }
  return at + 1
}

/**
 * The part of a wikilink's inner text that is shown; the rest is
 * syntax. The editor and every page quoting a line use this, so a link
 * reads the same everywhere. A span, because the editor hides ranges.
 *
 * - `[[a/b/c]]` shows `c`: a path is how the app finds a note, not its name.
 * - `[[a/b/c|the office]]` shows `the office`.
 * - `[[a/b/c|!2]]` shows `b/c`, `!3` shows `a/b/c`, and `!` shows
 *   the whole path, for a name that needs its parent to make sense.
 *
 * The depth marker goes where an alias would: that part already says
 * what the link shows, a rename leaves it alone, and resolving ignores
 * it. Obsidian's `!` before a link means embed, which is different.
 */
export function linkLabelSpan(inner: string): { from: number; to: number } {
  const pipe = inner.indexOf('|')
  if (pipe === -1) return { from: tailFrom(inner, 1), to: inner.length }
  const depth = /^\s*!(\d*)\s*$/.exec(inner.slice(pipe + 1))
  // Anything else after the pipe is an alias, shown as written.
  if (!depth) return { from: pipe + 1, to: inner.length }
  const target = inner.slice(0, pipe)
  return { from: depth[1] ? tailFrom(target, Math.max(1, Number(depth[1]))) : 0, to: pipe }
}

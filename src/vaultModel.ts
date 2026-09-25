// The vault's domain model: the two shapes the whole app speaks.
//
// **No filesystem import of any kind belongs here** — that is the point of the
// file. `vault.ts` imports `@tauri-apps/plugin-fs` at module scope, so anything
// taking a *value* from it inherits that edge; a module that only needs to name a
// note takes its types from here and stays testable without a disk.
//
// What belongs here: a shape, or an operation on names and shapes that could not
// touch a disk if it wanted to. `vault.ts` imports from this file like any other
// consumer, and there are deliberately **no re-exports** back through it.

/**
 * A note. The vault holds `.md` files and nothing else is visible to the app, so
 * there is no `kind` to discriminate on.
 */
export interface VaultFile {
  /** Vault-relative, `/`-separated, with the extension: `Ideas/pingbird.md`. */
  path: string
  absolutePath: string
  /** The basename without `.md` — what the tree shows. */
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
   * The folder's own note — `Areas/Areas.md` for a folder named Areas.
   *
   * A nested note is a folder plus a same-named note inside it, so a tree node is
   * both a note you can open and a container that holds children. Undefined for a
   * folder that has no note yet; one is written the first time you type in it.
   */
  note?: VaultFile
}

// ---------------------------------------------------------------------------
// Operations on those shapes
// ---------------------------------------------------------------------------
//
// Here rather than in `vault.ts` for the reason at the top of this file: these are
// facts about names, they could not touch a disk if they wanted to, and every one
// of them has a caller that has no business importing the filesystem.

/**
 * Are these two vault paths one file?
 *
 * macOS volumes are case-insensitive but case-preserving, so `exists()` reports
 * true for `Index.md` while only `index.md` is on disk. Renaming a file to a
 * different casing of its own name would therefore trip an "already exists" guard
 * against itself. `rename(2)` handles the case-only rename fine — it is only the
 * guard that needs to know the two paths are one file.
 */
export function isSamePath(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase()
}

/** The folder a *vault-relative* path sits in — `''` for one at the root, which is
 *  why this cannot slice blindly: `slice(0, -1)` on `roadmap.md` is `''` by luck
 *  and on a path with no slash at all it would be wrong by construction. */
export function folderOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/')
  return cut === -1 ? '' : relativePath.slice(0, cut)
}

/**
 * A folder's own note, whether or not it is on disk yet.
 *
 * Deliberately does not create it — browsing would litter the vault with blank
 * files. The file is written on first edit instead.
 */
export function folderNoteRef(folder: VaultFolder): VaultFile {
  if (folder.note) return folder.note
  return {
    path: `${folder.path}/${folder.name}.md`,
    absolutePath: `${folder.absolutePath}/${folder.name}.md`,
    name: folder.name,
  }
}

/**
 * Whether a path names a **note** — a markdown file.
 *
 * The tree holds more than notes now: a `.json` file in the vault opens in the
 * same pane, as text. Everything that treats a file as a *note* has to ask first,
 * because the note machinery writes YAML frontmatter — an `icon:`, a `path:` — and
 * frontmatter in a JSON file is a JSON file that no longer parses.
 *
 * **An encrypted note is not one**, in either spelling. What it says is the owner's
 * alone, so no note machinery reads it or writes into it — and v1's `.enc.md` ends
 * in `.md`, which had an icon picked for one written as plain text into the
 * ciphertext.
 */
export function isNote(path: string): boolean {
  return path.toLowerCase().endsWith('.md') && !isEncrypted(path)
}

/**
 * Whether a path is an encrypted note. **Both spellings**: v1 wrote `Private.enc.md`,
 * and `.enc` is what this app asks for — a file already in a vault has to keep
 * opening, and the format inside is the same either way.
 */
export function isEncrypted(path: string): boolean {
  return /\.enc(\.md)?$/i.test(path)
}

/**
 * A path or a file name with the note extension taken off — the name the app
 * *shows*, since a row, a link and a graph node all read `Ideas` and not
 * `Ideas.md`.
 *
 * One function because it was one regex written out in eleven places, across the
 * walk, the tree, the graph, the links and the completions — and **one for every
 * extension a note wears**: `.md`, and the `.enc.md` or `.enc` of one that is
 * locked. A locked note is a note, and its row says its name.
 */
/** A file the JSON editor shows — the one file type in the vault that is not
 *  markdown, and the only reason the pane ever picks a different editor. */
/** The last segment of a path: a file's or folder's own name, extension and all. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * A folder's own note, **by path alone** — `Areas/Plans` is `Areas/Plans/Plans.md`.
 *
 * `folderNoteRef` is the same rule for a folder the tree is holding; this is for
 * the callers that have only a string, and it existed three times as the same
 * slice-and-join before it had a name.
 */
export function folderNotePath(folder: string): string {
  return `${folder}/${baseName(folder)}.md`
}

/**
 * **What a file in the vault is**, and the only place that decides.
 *
 * A vault is a folder of files somebody keeps, and not all of them are notes: a
 * PDF of a lease, the photograph of a whiteboard, a CSV an export left behind. The
 * tree shows them all — what differs is what the reading pane does with one, and
 * that is this answer:
 *
 * - `note`, `json`, `csv`, `text` are **text**, and open in the editor. Typing
 *   saves them, as it always has: a file of yours that the app shows and keeps and
 *   does not otherwise read.
 * - `image` and `pdf` are shown, not edited — `FileView` hands the webview the
 *   file's own URL.
 * - `other` is a file the app has nothing to say about, which it says.
 *
 * An `.enc` is a `note`: a locked note is a note, and the passphrase is asked for
 * before anything reads it.
 */
export type FileKind = 'note' | 'json' | 'csv' | 'text' | 'image' | 'pdf' | 'other'

const KINDS: [RegExp, FileKind][] = [
  [/\.(md|enc)$/i, 'note'],
  [/\.json$/i, 'json'],
  // A `.tsv` is a CSV whose separator is a tab — `csvPreview` reads the line and
  // decides, so one kind covers both.
  [/\.(csv|tsv)$/i, 'csv'],
  // `conf` because the app writes one itself (`.config/tmux.conf`), and a file the
  // app writes is a file it has to be able to open.
  [/\.(txt|log|ya?ml|toml|ini|env|conf)$/i, 'text'],
  [/\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i, 'image'],
  [/\.pdf$/i, 'pdf'],
]

export function fileKind(path: string): FileKind {
  return KINDS.find(([extension]) => extension.test(path))?.[1] ?? 'other'
}

/** Whether the app may read this file as text — into the editor, and into the one
 *  vault read the graph, the backlinks and the search are built from. A PDF read
 *  as text is a megabyte of nonsense in the corpus and nothing in the pane. */
export function isTextFile(path: string): boolean {
  const kind = fileKind(path)
  return kind === 'note' || kind === 'json' || kind === 'csv' || kind === 'text'
}

export function noteName(path: string): string {
  return path.replace(/(\.enc)?\.md$/i, '').replace(/\.enc$/i, '')
}

/**
 * The path a note is **known by**: what the tree calls it, and what a link should
 * name.
 *
 * A nested note is a folder plus a same-named note inside it, so `Areas/Northwind`
 * and `Areas/Northwind/Northwind.md` are one note under two spellings. The tree
 * draws the first. The second is a path the app shows nowhere — there is no row for
 * it — so writing it into a `path:` property, or offering it in the `[[` picker,
 * asks the reader to know about a file the app keeps out of sight.
 *
 * The extension goes too: a link never carries one.
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

/**
 * Where the last `names` names of a path begin — 0 if the path holds no more than
 * that many, so the count clamps to what is there rather than failing.
 */
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
 * The span of a wikilink's inner text that is **shown**; the rest is syntax.
 *
 * Three readers asked this and answered it three ways: the editor showed the name
 * alone, while a collection's page and its table showed the whole target — so one
 * link read as a name in the note and as a run of folders on the page quoting it.
 * "The page draws what the note draws", and now off one function.
 *
 * A **span** rather than a string because the editor hides ranges: it needs to know
 * where the shown text is, not what it says. Everything else slices.
 *
 * - `[[a/b/c]]` shows `c`. A path is how the app finds a note, not what it is
 *   called — `noteName` and `knownPath` already say so.
 * - `[[a/b/c|the office]]` shows `the office`. An alias is how a link gets a name.
 * - `[[a/b/c|!2]]` shows `b/c`, and `!3` shows `a/b/c`. **A name is sometimes a
 *   fragment**: `Lakeside Terminal Arrival` does not say whose, and here the folder
 *   above it is a *page* and not a directory, so what `!n` adds is the n-1 pages
 *   this one is under. `!` with no number shows every one of them.
 *
 * The marker goes in the **alias slot**, for three reasons that all point one way.
 * That slot already means "what this link shows", so a depth is the same kind of
 * fact as an alias rather than a second mechanism. A rename replaces the
 * destination *where it sits inside the link* and leaves the rest alone, so the
 * marker survives every move and rename with no code carrying it — and
 * `linkTargetAt` already reads the left of the pipe, so it is inert for resolving,
 * following and the graph. And outside the brackets it would be a second thing to
 * parse for every reader of this vault, this app's and anyone else's: a tool that
 * greps `[[...]]` would see the link and miss the marker. Obsidian's `!` prefix
 * means *embed*, which is a different act, so borrowing the spelling there would
 * invert it.
 */
export function linkLabelSpan(inner: string): { from: number; to: number } {
  const pipe = inner.indexOf('|')
  if (pipe === -1) return { from: tailFrom(inner, 1), to: inner.length }
  const depth = /^\s*!(\d*)\s*$/.exec(inner.slice(pipe + 1))
  // Anything else after the pipe is an alias, and an alias is shown verbatim.
  if (!depth) return { from: pipe + 1, to: inner.length }
  const target = inner.slice(0, pipe)
  return { from: depth[1] ? tailFrom(target, Math.max(1, Number(depth[1]))) : 0, to: pipe }
}

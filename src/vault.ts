import {
  readDir,
  readTextFile,
  writeTextFile,
  writeFile,
  exists,
  mkdir,
  rename,
  remove,
} from '@tauri-apps/plugin-fs'
import { localDateStamp } from './clock'
import { readProperty, withProperty } from './frontmatter'
import { pathKey, retargetLinks } from './links'
import type { NoteIndex, NoteMoves } from './links'
import {
  folderNotePath,
  folderOf,
  isEncrypted,
  isNote,
  isSamePath,
  knownPath,
  noteName,
} from './vaultModel'
import {
  LockedFileError,
  decryptNote,
  encryptNote,
  followUnlocked,
  passphraseFor,
  remember,
  saltOf,
} from './crypto'
import type { VaultFile, VaultFolder } from './vaultModel'

// ---------------------------------------------------------------------------
// The filesystem surface
// ---------------------------------------------------------------------------

/**
 * One entry a folder listing gives back. `plugin-fs`'s own `DirEntry` also carries
 * `isSymlink`, which nothing here reads; a value with the extra field is assignable
 * to this, so the implementation below passes its entries straight through.
 */
interface VaultDirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
}

/**
 * **The app's filesystem, as the seven calls everything above it makes.**
 *
 * Two rules, and they are separate:
 *
 * - **`vault.ts` is the only module that imports `@tauri-apps/plugin-fs`.** Every
 *   test's `vi.mock('@tauri-apps/plugin-fs')` therefore reaches everything.
 * - **`VaultFs` is what a different backend implements** — seven calls, not a
 *   module of policy. A mobile or sync backend writes these and nothing else.
 *
 * Every path is **absolute**, which is what every caller already holds.
 */
export interface VaultFs {
  /** True for a file *or* a folder. Both volumes are case-insensitive, so this is. */
  exists(path: string): Promise<boolean>
  /** Rejects when there is no file. A caller that treats "absent" as a value checks `exists` first. */
  readText(path: string): Promise<string>
  /** Truncate-and-write. Not atomic. */
  writeText(path: string, text: string): Promise<void>
  /** One level. Rejects when the folder is not there. */
  list(path: string): Promise<VaultDirEntry[]>
  /** Creates one folder; the caller walks the path down. */
  makeFolder(path: string): Promise<void>
  /** A file, or an empty folder unless `recursive`. */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  /** Move or rename, file or folder. */
  move(from: string, to: string): Promise<void>
  /** **Bytes**, for a file dragged in from outside — a PDF, a photograph. The only
   *  call here that is not text, and it exists because the dropped file arrives as
   *  bytes in the webview and a `String()` of a PDF is a broken PDF. */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
}

/**
 * The surface over the real disk, and **the only place `plugin-fs` is called**.
 *
 * Everything below this line goes through `vaultFs`, so the seven calls above are
 * enforced by the compiler rather than asserted in a comment: a function here that
 * needs an eighth cannot quietly reach past the interface, it has to widen it. The
 * previous version of this file described the boundary and then made 49 raw
 * `plugin-fs` calls of its own, so nothing forced the interface to stay sufficient
 * and three things a second backend needs were missing from it.
 */
const vaultFs: VaultFs = {
  exists,
  readText: readTextFile,
  writeText: writeTextFile,
  list: readDir,
  makeFolder: mkdir,
  remove,
  move: rename,
  writeBytes: writeFile,
}


// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

/**
 * What the last read produced, so an unchanged read hands back the *same* objects
 * rather than value-equal new ones.
 *
 * Window focus re-reads the whole vault — that is what makes a note created in
 * Finder appear without reopening — and almost every one of those reads finds
 * nothing new. Fresh objects invalidate every `useMemo` keyed on the tree and
 * re-render it all; identical ones let React's eager bailout drop the update.
 *
 * **The read itself cannot be skipped.** A directory's mtime does not move when a
 * file inside it is written in place — measured on APFS — so mtimes would miss
 * exactly the case the refresh exists for.
 */
let lastRead: { rootPath: string; root: VaultFolder } | null = null

export async function readVault(rootPath: string): Promise<VaultFolder> {
  const name = rootPath.split('/').filter(Boolean).pop() ?? rootPath
  const root = await walk(rootPath, '', name)
  if (lastRead?.rootPath === rootPath && sameFolder(lastRead.root, root)) return lastRead.root
  lastRead = { rootPath, root }
  return root
}

function sameFile(a: VaultFile, b: VaultFile): boolean {
  // absolutePath as well as path: switching between two folders of identical shape
  // would otherwise keep the old tree, pointing every read at the old disk.
  return a.path === b.path && a.absolutePath === b.absolutePath && a.name === b.name
}

/** Whole-tree value equality. Both sides are walk output, so child order matches. */
function sameFolder(a: VaultFolder, b: VaultFolder): boolean {
  if (a.path !== b.path || a.absolutePath !== b.absolutePath || a.name !== b.name) return false
  if (a.files.length !== b.files.length || a.folders.length !== b.folders.length) return false
  if (!a.note !== !b.note) return false
  if (a.note && b.note && !sameFile(a.note, b.note)) return false
  for (let i = 0; i < a.files.length; i++) if (!sameFile(a.files[i], b.files[i])) return false
  for (let i = 0; i < a.folders.length; i++) if (!sameFolder(a.folders[i], b.folders[i])) return false
  return true
}

/**
 * The files the app opens: notes, and JSON.
 *
 * A `.json` file is not a note — it carries no properties and takes no links — but
 * it is a file someone keeps *with* their notes, and the pane can show it. What
 * separates the two is `isNote`, which every piece of note machinery asks.
 * Everything else on disk stays invisible.
 */
/**
 * **Every file, not only the ones the app can edit.**
 *
 * It was `.md`, `.json` and `.enc`, and everything else on disk was invisible —
 * which made a vault holding a lease PDF, a photograph and an export two things at
 * once: a folder of notes in this app, and a folder of files in Finder. A vault is
 * the folder; the tree shows what is in it. What the *reading pane* does with one
 * is `fileKind`'s answer, and that is where the difference lives now.
 *
 * Dot-prefixed entries are still skipped by the walk below, which is what keeps
 * `.config` and `.claude` out of the tree.
 */

async function walk(absoluteDir: string, relativeDir: string, name: string): Promise<VaultFolder> {
  const entries = await vaultFs.list(absoluteDir)
  const folder: VaultFolder = {
    path: relativeDir,
    absolutePath: absoluteDir,
    name,
    folders: [],
    files: [],
  }

  // Subfolders are descended **together**. Each `list` is one IPC round trip, and
  // awaiting inside the loop made the whole tree one serial chain of them — a
  // vault of thirty folders paid thirty latencies end to end instead of one per
  // level. The sort below is what makes the finish order not matter.
  const descend: Promise<VaultFolder>[] = []

  for (const entry of entries) {
    // Dot-prefixed entries are skipped, which is why `safeNewName` refuses a
    // leading dot: a `.plan.md` would be written and then be invisible here.
    if (entry.name.startsWith('.')) continue
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    const absolutePath = `${absoluteDir}/${entry.name}`

    if (entry.isFile) {
      folder.files.push({
        path: relativePath,
        absolutePath,
        // Only `.md` is stripped: `data.json` shows as `data.json`, which is what
        // tells it apart from a note called `data` in the same folder — and a
        // `plan.pdf` from a note called `plan`.
        name: noteName(entry.name),
      })
    } else if (entry.isDirectory) {
      descend.push(walk(absolutePath, relativePath, entry.name))
    }
  }

  folder.folders = await Promise.all(descend)

  // Lift `Areas/Areas.md` out of the file list and onto the folder itself, so it
  // renders as the folder's own row rather than as a child of it.
  const noteIndex = folder.files.findIndex((f) => f.name === name)
  if (noteIndex !== -1) {
    folder.note = folder.files[noteIndex]
    folder.files.splice(noteIndex, 1)
  }

  folder.folders.sort((a, b) => a.name.localeCompare(b.name))
  folder.files.sort((a, b) => a.name.localeCompare(b.name))

  return folder
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The directory an *absolute* path sits in. */
function parentOf(absolutePath: string): string {
  return absolutePath.slice(0, absolutePath.lastIndexOf('/'))
}

/** Collapses `.` and `..` so a containment check cannot be walked past.
 *  Textual, and that is enough: nothing in the app creates a symlink. */
function resolveDots(absolutePath: string): string {
  const out: string[] = []
  for (const segment of absolutePath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return `/${out.join('/')}`
}

/**
 * A rename changes a name and never a location: the destination has to resolve
 * inside the entry's own parent directory.
 *
 * Stated independently of the name, because a guard that enumerates what a name may
 * hold is one character behind the next surprise. `renameFile` splices its
 * destination out of the typed text, so `../../../Desktop/pwned` renamed a note
 * clean out of the vault — `fs:allow-rename` is scoped `**` and the `exists()` collision guard ran on
 * the escaped path, so neither layer said a word.
 */
function assertStaysPut(oldAbsolute: string, newAbsolute: string, name: string): void {
  if (isSamePath(parentOf(resolveDots(oldAbsolute)), parentOf(resolveDots(newAbsolute)))) return
  throw new Error(`"${name}" would move out of its folder — a rename only changes a name.`)
}

/** True when `candidateParent` is the folder itself or anywhere inside it. */
export function isSelfOrDescendant(folderPath: string, candidateParent: string): boolean {
  return candidateParent === folderPath || candidateParent.startsWith(`${folderPath}/`)
}

// ---------------------------------------------------------------------------
// Reading and writing one note
// ---------------------------------------------------------------------------

/**
 * A file's text, **decrypted if it is one of those.**
 *
 * The whole of what makes an encrypted note openable is here and in the write
 * below: everything above this — the buffer, the editor, the autosave, the focus
 * re-read, the search — is handed plain text and never learns the difference.
 *
 * A file nobody has unlocked yet throws `LockedFileError`, which is not a failure
 * but a question: `App` catches it and asks for the passphrase.
 */
export async function readVaultFile(file: VaultFile): Promise<string> {
  const raw = await vaultFs.readText(file.absolutePath)
  if (!isEncrypted(file.path)) return raw
  const passphrase = passphraseFor(file.path)
  if (passphrase === null) throw new LockedFileError(file.path)
  return decryptNote(raw, passphrase)
}

/**
 * `raw` onto disk, **encrypted if the file is one of those** — with the file's own
 * salt, so the derived key stays cached across saves and typing does not pay
 * 600,000 PBKDF2 rounds a keystroke. The IV is fresh every time, which is the half
 * that must never repeat.
 *
 * A locked file with no passphrase is not written at all. There is nothing honest
 * to write: plain text into a `.enc` file is the one outcome that cannot be undone.
 */
export async function writeVaultFile(file: VaultFile, raw: string): Promise<void> {
  if (!isEncrypted(file.path)) return vaultFs.writeText(file.absolutePath, raw)
  const passphrase = passphraseFor(file.path)
  if (passphrase === null) throw new LockedFileError(file.path)
  const existing = await vaultFs.readText(file.absolutePath).catch(() => '')
  const sealed = await encryptNote(raw, passphrase, saltOf(existing))
  return vaultFs.writeText(file.absolutePath, sealed)
}

/**
 * Tries a passphrase against an encrypted file, and remembers it if it opens.
 *
 * The proof is a decryption: AES-GCM authenticates, so "it decrypted" and "this is
 * the passphrase" are the same statement. Throws `WrongPassphraseError` for a bad
 * one and `DamagedFileError` for a file that is not intact — two different answers,
 * because only one of them is worth retyping for.
 */
export async function unlockFile(file: VaultFile, passphrase: string): Promise<void> {
  const raw = await vaultFs.readText(file.absolutePath)
  await decryptNote(raw, passphrase)
  remember(file.path, passphrase)
}

export function fileExists(file: VaultFile): Promise<boolean> {
  return vaultFs.exists(file.absolutePath)
}

/**
 * One frontmatter property on one note, written as plain text.
 *
 * The transform is `frontmatter.ts`'s and is pure; this is the half that touches a
 * disk, through `vaultFs` like everything else here. There was a `readNoteProperty`
 * beside it, and it went when `App` started reading each note once and asking
 * `readProperty` for both properties it wants: two reads of a file to get two lines
 * of its first block.
 *
 * A note that is not on disk yet is the ordinary case and not an error — a folder
 * note is written lazily (CLAUDE.md) — so writing one creates it with nothing but
 * the block.
 */
/** The property that records where a note sits, from the vault root down. */
const PATH_PROPERTY = 'path'

/**
 * Write a note's own path into it, and into every note under it when it is a
 * folder that moved.
 *
 * The point of the property is that it travels with the file: open the note in any
 * editor and it says where it belongs, so a note that turns up on its own can be
 * put back. Which means the app has to keep it true — a note whose `path:` is a
 * place it no longer is would be worse than no property at all.
 *
 * The value is the vault-relative path without `.md`, which is what a `[[wikilink]]`
 * to it would say.
 *
 * Only notes **on disk** are written: a folder note is written on the first
 * keystroke (CLAUDE.md), and this must not be the thing that creates one.
 */
export async function writePathProperty(files: readonly VaultFile[]): Promise<void> {
  for (const file of files) {
    // `writeNoteProperty` refuses a non-note anyway; skipping here is what keeps a
    // move of a JSON file from reading and rewriting it for nothing.
    if (!isNote(file.path)) continue
    if (!(await vaultFs.exists(file.absolutePath))) continue
    // `knownPath`, not the file's own: a nested note's file is
    // `Areas/Northwind/Northwind.md`, and the note is `Areas/Northwind`. The
    // doubled form named a page the tree never shows.
    await writeNoteProperty(file, PATH_PROPERTY, knownPath(file.path))
  }
}

/**
 * The icon the folder a note sits in wears, from that folder's **own note** — or
 * null for a note at the top of the vault, a folder with no note yet, or one that
 * carries no icon.
 *
 * Read from disk rather than looked up in the corpus, and that is the point: the
 * corpus is one read of the vault that lands a moment after launch, so a note made
 * in the first second of a session inherited nothing. A file this app is about to
 * write into is a file it can afford to read.
 */
export async function folderIcon(vaultPath: string, notePath: string): Promise<string | null> {
  const folder = folderOf(notePath)
  if (!folder) return null
  const own = `${vaultPath}/${folderNotePath(folder)}`
  if (!(await vaultFs.exists(own))) return null
  return readProperty(await vaultFs.readText(own).catch(() => ''), 'icon')
}

export async function writeNoteProperty(
  file: VaultFile,
  key: string,
  value: string | null
): Promise<void> {
  // Frontmatter belongs to notes. A `.json` file in the tree opens in the same
  // pane, and an `icon:` block written into it is a file that no longer parses, so
  // this refuses rather than corrupts. The rows that offer icons hide them for a
  // non-note anyway; this is the half that cannot be forgotten.
  if (!isNote(file.path)) return
  let raw = ''
  try {
    raw = await vaultFs.readText(file.absolutePath)
  } catch {
    // Not written yet. Setting a property is what brings it into being.
  }
  await vaultFs.writeText(file.absolutePath, withProperty(raw, key, value))
}

// ---------------------------------------------------------------------------
// The vault's own configuration
// ---------------------------------------------------------------------------
//
// **A vault carries its settings.** `.config/` at the root of the folder is where
// this app's options for *this* vault live, so a vault is self-describing: copy the
// folder to another machine and the theme, the typography, the shortcuts and the
// daily-notes folder go with it. `localStorage` still holds the last applied set,
// which is what dresses the window before a vault is open.
//
// Two functions over *named files* rather than one per kind of setting, because
// themes and an env file are meant to land here beside `settings.json` and each
// would otherwise arrive with a new pair of its own.
//
// The leading dot is what keeps it out of the tree: `walk` skips dot-prefixed
// entries, so `.config` is invisible to the app that wrote it. That is also why
// `safeName` refuses a leading dot for a name the user types — a note called
// `.plan` would be written and then never seen again.

export const CONFIG_DIR = '.config'

/** The file every skill folder holds — Claude Code's layout, `<name>/SKILL.md`. */
export const SKILL_FILE = 'SKILL.md'

/** The text of one file in the vault's `.config`, or null when it is not there —
 *  which is the ordinary case for a vault this app has not opened before. */
export async function readConfigFile(vaultPath: string, name: string): Promise<string | null> {
  const path = `${vaultPath}/${CONFIG_DIR}/${name}`
  if (!(await vaultFs.exists(path))) return null
  return vaultFs.readText(path).catch(() => null)
}

/**
 * Writes one file into the vault's `.config`, creating every folder above it.
 *
 * `name` may be a path — `actions/skills/summarise.md` — because the section that
 * writes those keeps its two kinds in two folders. `makeFolder` is one level, so
 * the walk down is here.
 */
export async function writeConfigFile(
  vaultPath: string,
  name: string,
  text: string
): Promise<void> {
  return writeVaultDirFile(vaultPath, `${CONFIG_DIR}/${name}`, text)
}

/** The name the tmux config is kept under, beside `settings.json`. */
const TMUX_FILE = 'tmux.conf'

/**
 * The tmux config a Terminal tab's server reads, **written once and then the
 * user's.** It is in the vault because that is where this app keeps what dresses
 * it, and `readConfigFile`/`writeConfigFile` already take a file name for exactly
 * this; it is inspectable and editable there, and a hand edit survives, which is
 * the bargain `settings.json` makes.
 *
 * Every line is load-bearing:
 *
 * - `status off` — a status bar is tmux's chrome, and this pane is meant to read as
 *   a terminal in this app rather than as a multiplexer someone opened.
 * - `mouse off` — **deliberately**, so the wheel and the scrollback stay xterm.js's.
 *   With the mouse on, tmux takes the wheel into its own copy mode and the pane's
 *   scrolling, which took three measured fixes to get right, would be bypassed.
 * - `prefix None` with `C-b` unbound — `C-b` is *back one character* to every
 *   readline shell, and a multiplexer eating it silently is the kind of thing that
 *   reads as this app being broken. There is no prefix at all: the app drives the
 *   session, so nothing here needs a key of its own.
 * - `destroy-unattached off` — the default, stated, because it is the feature: a
 *   session with no client is a session that is still there.
 * - `default-terminal` and the `Tc` override — the same truecolour the pane sets on
 *   the PTY, or a TUI takes its no-colour path through tmux instead.
 */
const TMUX_CONF = `# Written by Journeys when a Terminal tab first opened.
# Yours to edit: this file is read once, when the session server starts, and is
# never rewritten. It applies only to Journeys' own tmux server (socket
# "journeys") and never to tmux you run yourself.

# Read as a terminal in this app, not as a multiplexer someone opened.
set -g status off

# The wheel and the scrollback are the pane's (xterm.js). With the mouse on, tmux
# takes the wheel into its copy mode and the pane's own scrolling is bypassed.
set -g mouse off

# C-b is "back one character" to every readline shell. Nothing here needs a key of
# its own, so there is no prefix at all.
unbind C-b
set -g prefix None

# The feature, stated: a session with no client is a session that is still there.
set -g destroy-unattached off

# The same truecolour the pane sets on the PTY, or a TUI takes its no-colour path.
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"

set -g history-limit 50000
set -g escape-time 10
`

/**
 * Write the tmux config if the vault has none, and leave a hand-edited one alone.
 *
 * Answers quietly either way: this runs on the way to opening a terminal, and a
 * vault that cannot be written is a problem the terminal itself will report rather
 * than something to refuse a shell over.
 */
export async function ensureTmuxConfig(vaultPath: string): Promise<void> {
  if ((await readConfigFile(vaultPath, TMUX_FILE)) !== null) return
  await writeConfigFile(vaultPath, TMUX_FILE, TMUX_CONF)
}

/** The same, at a **vault-relative** path — for a kind whose folder is not under
 *  `.config`. Every folder on the way is made, because a skill's is a folder the
 *  vault may not have yet. */
export async function writeVaultDirFile(
  vaultPath: string,
  path: string,
  text: string
): Promise<void> {
  const parts = path.split('/')
  let dir = vaultPath
  for (const part of parts.slice(0, -1)) {
    dir = `${dir}/${part}`
    if (!(await vaultFs.exists(dir))) await vaultFs.makeFolder(dir)
  }
  await vaultFs.writeText(`${dir}/${parts[parts.length - 1]}`, text)
}

/**
 * The file names in one folder under `.config`, sorted, or `[]` when the folder is
 * not there — which is the ordinary case until the first file is written.
 *
 * Files only. Nothing in `.config` nests further than the section that writes it,
 * and a folder in a list of files would be a thing with no row to draw.
 */
/**
 * The files in a **vault-relative** folder, dot-prefixed ones included.
 *
 * `.config` is not the only hidden folder that matters any more: a vault's skills
 * live in `.claude/skills`, which is Claude Code's layout and not this app's to
 * move. So a kind says where its files are from the vault root, and this lists
 * them. Every `fs:` scope in the capability has to name such a folder literally —
 * `**` does not match a component starting with a dot, and the failure is silence
 * rather than an error. `capability.test.ts` insists on it.
 */
export async function listVaultDir(vaultPath: string, dir: string): Promise<string[]> {
  // No trailing slash: `dir` may be the dot folder itself, and `exists` on
  // `…/.config/` answered false.
  const path = `${vaultPath}/${dir}`
  if (!(await vaultFs.exists(path))) return []
  // **No `.catch`.** A folder that is not there answered `[]` above; the only thing
  // left for a catch to hide is a scope that does not reach — which is how the
  // `.config` refusal went unnoticed twice, both times as an empty group over a
  // folder with files in it. The caller reports it.
  const entries = await vaultFs.list(path)
  return entries
    .filter((entry) => entry.isFile && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * The folders in a vault-relative folder that hold `entry`, as `<folder>/<entry>`.
 *
 * **A skill is a folder, not a file** — `.claude/skills/youtube-transcript/SKILL.md`
 * is the shape Claude Code loads, so listing files there finds nothing, which is
 * exactly what the Skills section showed: empty, against a vault with a skill in it.
 */
export async function listVaultEntries(
  vaultPath: string,
  dir: string,
  entry: string
): Promise<string[]> {
  const path = `${vaultPath}/${dir}`
  if (!(await vaultFs.exists(path))) return []
  const found = await vaultFs.list(path)
  const names: string[] = []
  for (const one of found) {
    if (one.isFile || one.name.startsWith('.')) continue
    if (await vaultFs.exists(`${path}/${one.name}/${entry}`)) names.push(`${one.name}/${entry}`)
  }
  return names.sort((a, b) => a.localeCompare(b))
}

/** A file under `.config` as something the pane can open. It is outside the tree —
 *  `walk` skips dot-prefixed entries — so nothing else in the app will hand one
 *  over, and this is the only place they are named. */
/**
 * A file at a vault-relative path as something the pane can open. Outside the tree
 * — `walk` skips dot-prefixed entries — so nothing else in the app hands one over.
 *
 * A skill's name is its **folder's**: every one of them is called `SKILL.md`, so
 * the file's own basename names nothing.
 */
export function vaultFileRef(vaultPath: string, path: string): VaultFile {
  const parts = path.split('/')
  const base = parts[parts.length - 1]
  const shown = base.toUpperCase() === SKILL_FILE.toUpperCase() && parts.length > 1 ? parts[parts.length - 2] : base
  return {
    path,
    absolutePath: `${vaultPath}/${path}`,
    name: noteName(shown),
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Keeps the name as typed, minus characters a path cannot hold. */
export function safeName(name: string): string {
  return name.trim().replace(/[/\\:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '').trim()
}

/**
 * The one rule for what a created or renamed name may be.
 *
 * A leading dot is **refused** rather than folded, because `walk` skips every
 * dot-prefixed entry: `.plan.md` would be written, opened in the editor, and then
 * be invisible to the tree — lost from inside the app, with no way back but Finder.
 * Folding the dot away would be renaming a name that was asked for.
 *
 * `safeName` alone is not enough (it keeps the dot), and a second copy of this is
 * how the callers come to disagree.
 */
export function safeNewName(name: string): string {
  const base = safeName(name)
  if (!base) throw new Error('Name required.')
  if (base.startsWith('.')) {
    throw new Error(`"${base}" starts with a dot, so it could not be shown — pick another name.`)
  }
  return base
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * Every folder in a vault-relative path, created where it is missing. Answers the
 * path as the disk now spells it.
 *
 * `makeFolder` does one level, so this walks down, and each segment goes through
 * `safeNewName` — a parent can arrive from a `[[wikilink]]`, which is text the user
 * typed rather than a node in the tree.
 *
 * A folder made here is a **nested note with nothing in it yet**. A folder *is* a
 * note (CLAUDE.md) and its own `.md` is written on the first keystroke, so this
 * writes no file: `[[Landmark Plaza/Northwind Office]]` is a note in a place, not
 * two notes.
 */
export async function ensureFolder(vaultPath: string, relativePath: string): Promise<string> {
  let at = ''
  for (const segment of relativePath.split('/').filter(Boolean)) {
    at = at ? `${at}/${safeNewName(segment)}` : safeNewName(segment)
    const absolute = `${vaultPath}/${at}`
    if (!(await vaultFs.exists(absolute))) await vaultFs.makeFolder(absolute)
  }
  return at
}

/**
 * A note, and the folders above it.
 *
 * `parentPath` may name folders that are not there: a wikilink is written before
 * the place it points at exists, and `[[Landmark Plaza/Northwind Office]]` says
 * where the note goes as much as what it is called. Creating them here rather than
 * at the caller is what keeps "the parent must exist" from being a rule each of the
 * three callers has to remember separately.
 *
 * `name` is one segment either way — a `/` in it is folded, because that is a name
 * with a slash in it and not a path.
 */
/**
 * **A file dragged in from outside**, copied into `parentPath` under its own name.
 *
 * Copied and not moved: dragging out of Finder into an app means a copy, and the
 * file the user dragged is still where they left it. The name is held to the same
 * rule a typed one is — `safeNewName`, so a `../` in a file's name cannot put it
 * outside the vault — and **an existing file is not overwritten**: the answer says
 * which arrived and which were already there, and the caller says so. Silently
 * replacing somebody's file with a same-named one is the one outcome nobody would
 * have asked for.
 *
 * The bytes come from the drop, because that is the only form the webview has them
 * in: a `File` from a drag has no path this side of the process.
 */
export async function importFile(
  vaultPath: string,
  parentPath: string,
  name: string,
  bytes: Uint8Array
): Promise<VaultFile | null> {
  const fileName = safeNewName(name)
  if (!fileName) return null
  const parent = parentPath ? await ensureFolder(vaultPath, parentPath) : ''
  const relativePath = parent ? `${parent}/${fileName}` : fileName
  const absolutePath = `${vaultPath}/${relativePath}`
  if (await vaultFs.exists(absolutePath)) return null
  await vaultFs.writeBytes(absolutePath, bytes)
  return { path: relativePath, absolutePath, name: noteName(fileName) }
}

export async function createNote(
  vaultPath: string,
  parentPath: string,
  name: string
): Promise<VaultFile> {
  const fileName = `${safeNewName(noteName(name))}.md`
  const parent = parentPath ? await ensureFolder(vaultPath, parentPath) : ''
  const relativePath = parent ? `${parent}/${fileName}` : fileName
  const absolutePath = `${vaultPath}/${relativePath}`

  if (await vaultFs.exists(absolutePath)) throw new Error(`"${fileName}" already exists.`)

  await vaultFs.writeText(absolutePath, '')
  return { path: relativePath, absolutePath, name: noteName(fileName) }
}

/**
 * A locked note, at the top of the vault, **sealed from its first byte**: a plain
 * copy synced even once stays readable in the history, so there is no moment when
 * this note is plain text on disk — and no way to lock a note that already is. The
 * passphrase is remembered for the window, so the note opens without asking.
 */
export async function createLockedNote(
  vaultPath: string,
  name: string,
  passphrase: string
): Promise<VaultFile> {
  const base = safeNewName(noteName(name))
  // A name is one note, locked or not.
  for (const taken of [`${base}.enc`, `${base}.md`]) {
    if (await vaultFs.exists(`${vaultPath}/${taken}`)) throw new Error(`"${taken}" already exists.`)
  }
  const file = { path: `${base}.enc`, absolutePath: `${vaultPath}/${base}.enc`, name: base }
  await vaultFs.writeText(file.absolutePath, await encryptNote('', passphrase))
  remember(file.path, passphrase)
  return file
}

/** Where the daily notes live, vault-relative, when the caller does not say.
 *  Exported because `settings.ts` defaults `dailyFolder` to it: two copies of the
 *  name would have to be kept in step by hand. */
export const DAILY_FOLDER = 'Daily'

/**
 * Today's daily note, created — folder included — if it is not there yet.
 *
 * `folder` is a **single** vault-relative segment: the `makeFolder` below is not
 * recursive, so `a/b` would not be created. `settings.ts`'s `validateDailyFolder`
 * is what holds the setting to that, through `safeNewName` above — this function
 * does not re-check, because a second copy of the rule is how the two come to
 * disagree.
 *
 * `Daily/` is a **plain folder**, deliberately without a `Daily/Daily.md`: a folder
 * note is what makes a tree node openable, and this one is a container of dated
 * notes rather than a note that happens to hold children.
 *
 * Unlike a folder note this file *is* written empty, so an unedited daily note
 * still exists tomorrow — which is the point of pressing the shortcut.
 */
export async function ensureDailyNote(
  vaultPath: string,
  folder = DAILY_FOLDER,
  day = localDateStamp()
): Promise<{ file: VaultFile; created: boolean }> {
  const folderAbsolute = `${vaultPath}/${folder}`
  if (!(await vaultFs.exists(folderAbsolute))) await vaultFs.makeFolder(folderAbsolute)

  const relativePath = `${folder}/${day}.md`
  const absolutePath = `${vaultPath}/${relativePath}`
  const file = { path: relativePath, absolutePath, name: day }
  // Only a day that did not exist a moment ago: opening today's page for the
  // second time must not write anything into it. **The caller is told which it
  // was**, because what a new note is given — its `path:`, a folder's icon — is
  // given once, and ⌘⇧O is one of the three ways a note comes into being.
  const created = !(await vaultFs.exists(absolutePath))
  if (created) await vaultFs.writeText(absolutePath, '')
  return { file, created }
}

// ---------------------------------------------------------------------------
// Moving, renaming, deleting
// ---------------------------------------------------------------------------

/**
 * Move `from` to `to` unless something else is already there. Answers whether
 * anything moved.
 *
 * **A case-only change is not a collision**, and that is the whole reason this is
 * one function rather than four copies. macOS is case-insensitive, so `exists()`
 * says yes to the destination when only the spelling changes — and refusing that
 * would refuse exactly the rename such a volume needs, leaving `Trip` holding
 * `trip.md`. An identical path is a no-op and not an error: nothing to do is not a
 * failure.
 */
async function moveUnlessTaken(from: string, to: string, taken: string): Promise<boolean> {
  if (to === from) return false
  if (!isSamePath(to, from) && (await vaultFs.exists(to))) throw new Error(taken)
  await vaultFs.move(from, to)
  return true
}

/**
 * The folded name a rename lands on, or null when it is not a change.
 *
 * Compared **both as typed and as folded**, because `safeNewName` can turn a typed
 * name into the one the file already has — and a rename to the same name is a
 * no-op the filesystem would otherwise be asked to perform.
 */
function renamedTo(current: string, typed: string): string | null {
  const wanted = typed.trim()
  if (!wanted || wanted === current) return null
  const folded = safeNewName(wanted)
  return folded === current ? null : folded
}

export async function moveFile(
  file: VaultFile,
  vaultPath: string,
  newParentPath: string
): Promise<VaultFile> {
  const fileName = file.absolutePath.split('/').pop() ?? ''
  const newRelativePath = newParentPath ? `${newParentPath}/${fileName}` : fileName
  const newAbsolutePath = `${vaultPath}/${newRelativePath}`

  const moved = await moveUnlessTaken(
    file.absolutePath,
    newAbsolutePath,
    `"${fileName}" already exists in that folder.`
  )
  if (!moved) return file
  followUnlocked(file.path, newRelativePath)
  return { ...file, path: newRelativePath, absolutePath: newAbsolutePath }
}

/**
 * A page becomes a nested page: `Ideas.md` → `Ideas/Ideas.md`.
 *
 * That pairing is what a nested note *is* (CLAUDE.md), so this is a folder and one
 * move — the note's own bytes are never read, let alone rewritten, and every link
 * to it still resolves, because `[[Ideas]]` is matched on the name.
 *
 * The name comes off the file rather than out of `VaultFile.name`: the folder and
 * the note inside it have to be spelled the same way the file already is, down to
 * its case, or the pair stops being a pair on a case-sensitive volume.
 */
export async function convertToNested(file: VaultFile, vaultPath: string): Promise<VaultFile> {
  const fileName = file.absolutePath.split('/').pop() ?? ''
  const name = noteName(fileName)
  const parent = folderOf(file.path)
  const folderRelative = parent ? `${parent}/${name}` : name

  if (await vaultFs.exists(`${vaultPath}/${folderRelative}`)) {
    throw new Error(`"${name}" is already a nested note.`)
  }
  await vaultFs.makeFolder(`${vaultPath}/${folderRelative}`)

  const relativePath = `${folderRelative}/${fileName}`
  const absolutePath = `${vaultPath}/${relativePath}`
  await vaultFs.move(file.absolutePath, absolutePath)
  return { ...file, path: relativePath, absolutePath }
}

export async function moveFolder(
  folder: VaultFolder,
  vaultPath: string,
  newParentPath: string
): Promise<VaultFolder> {
  // Moving a folder into itself or one of its own children would relocate the
  // destination along with the source — rename(2) would either fail or orphan it.
  if (isSelfOrDescendant(folder.path, newParentPath)) {
    throw new Error(`Can't move "${folder.name}" inside itself.`)
  }

  const currentParent = folderOf(folder.path)
  if (currentParent === newParentPath) return folder

  const newRelativePath = newParentPath ? `${newParentPath}/${folder.name}` : folder.name
  const newAbsolutePath = `${vaultPath}/${newRelativePath}`

  const moved = await moveUnlessTaken(
    folder.absolutePath,
    newAbsolutePath,
    `"${folder.name}" already exists in that folder.`
  )
  if (!moved) return folder
  return { ...folder, path: newRelativePath, absolutePath: newAbsolutePath }
}

export async function renameFile(file: VaultFile, newName: string): Promise<VaultFile> {
  // `safeNewName` and not `safeName` alone: the destination is spliced from this
  // name, so an unfolded `/` moves the note into a folder nobody picked, an
  // unfolded `..` out of the vault, and a leading dot renames it into something
  // `walk` skips.
  const trimmed = renamedTo(file.name, newName)
  if (trimmed === null) return file
  // The file's *own* extension, not `.md`: renaming `data.json` used to hand back
  // `data.md`, a JSON file the app would then read as a note.
  const extension = /\.[A-Za-z0-9]+$/.exec(file.path)?.[0] ?? '.md'
  const fileName = trimmed.toLowerCase().endsWith(extension.toLowerCase())
    ? trimmed
    : `${trimmed}${extension}`
  const parentDir = folderOf(file.path)
  const newRelativePath = parentDir ? `${parentDir}/${fileName}` : fileName
  const newAbsolutePath = `${parentOf(file.absolutePath)}/${fileName}`
  assertStaysPut(file.absolutePath, newAbsolutePath, fileName)

  const moved = await moveUnlessTaken(
    file.absolutePath,
    newAbsolutePath,
    `"${fileName}" already exists.`
  )
  if (!moved) return file
  followUnlocked(file.path, newRelativePath)
  return {
    path: newRelativePath,
    absolutePath: newAbsolutePath,
    name: noteName(fileName),
  }
}

export async function renameFolder(folder: VaultFolder, newName: string): Promise<VaultFolder> {
  const trimmed = renamedTo(folder.name, newName)
  if (trimmed === null) return folder
  const parentDir = folderOf(folder.path)
  const newRelativePath = parentDir ? `${parentDir}/${trimmed}` : trimmed
  const newAbsolutePath = `${parentOf(folder.absolutePath)}/${trimmed}`
  assertStaysPut(folder.absolutePath, newAbsolutePath, trimmed)

  const moved = await moveUnlessTaken(
    folder.absolutePath,
    newAbsolutePath,
    `"${trimmed}" already exists.`
  )
  if (!moved) return folder

  // The folder note is matched by name, so it has to follow the folder's rename or
  // the folder comes back with no note and a stray orphan inside it.
  if (folder.note) {
    const movedNote = `${newAbsolutePath}/${folder.name}.md`
    const renamedNote = `${newAbsolutePath}/${trimmed}.md`
    // A case-only rename makes these one file on a case-insensitive volume — see
    // `moveUnlessTaken` for why that must not read as a collision.
    const oneFile = isSamePath(movedNote, renamedNote)
    // Not `moveUnlessTaken`: a note already sitting under the new name is a reason
    // to leave it alone, not to fail a folder rename that has already happened.
    if ((await vaultFs.exists(movedNote)) && (oneFile || !(await vaultFs.exists(renamedNote)))) {
      await vaultFs.move(movedNote, renamedNote)
    }
  }

  return { ...folder, path: newRelativePath, absolutePath: newAbsolutePath, name: trimmed }
}

/**
 * Rewrites every link in the vault that pointed at a note that has moved.
 *
 * **A rename takes its backlinks with it**, or every link into that note becomes a
 * link to a note waiting to be created — which is what `[[Roadmap]]` means once
 * `Roadmap.md` is called something else.
 *
 * `before` is the vault's notes and `index` its index **as they were**, because
 * that is what still resolves `[[Roadmap]]`: after the rename there is no note of
 * that name. Each note is read from where it is *now* — every note but the moved
 * ones is where it was, and the moved ones are in `moves` — and written back only
 * when a link in it actually changed, so nothing rewrites bytes nobody touched.
 *
 * Answers with the paths it could not read, and **an encrypted note is not one of
 * them**: `isNote` leaves it out, locked or not, because nothing but its owner
 * writes into one — and saying so after every rename was a banner about a
 * permanent condition nobody could act on. What is left in the answer is a note
 * that exists and still could not be read: a permissions error, a sync
 * placeholder, a real failure. A note
 * simply **not on disk** is not one either — a folder note is written lazily
 * (CLAUDE.md) and `collectNotes` names it either way, which had every vault with
 * an unwritten folder note reporting one after every rename.
 */
export async function retargetVaultLinks(
  before: readonly VaultFile[],
  moves: NoteMoves,
  index: NoteIndex
): Promise<string[]> {
  const skipped: string[] = []
  for (const was of before) {
    const now = moves.get(pathKey(was.path)) ?? was
    // `isNote`, because links are note machinery: a JSON file in the tree holds
    // none, and reading one to search it for `[[…]]` is work with no answer.
    if (!isNote(now.path)) continue
    if (!(await vaultFs.exists(now.absolutePath))) continue
    const text = await readVaultFile(now).catch(() => {
      skipped.push(now.path)
      return null
    })
    if (text === null) continue
    const next = retargetLinks(text, was.path, moves, index)
    if (next !== text) await writeVaultFile(now, next)
  }
  return skipped
}

export function deleteFile(file: VaultFile): Promise<void> {
  return vaultFs.remove(file.absolutePath)
}

export function deleteFolder(folder: VaultFolder): Promise<void> {
  return vaultFs.remove(folder.absolutePath, { recursive: true })
}

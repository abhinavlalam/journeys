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
import { APP_PROPERTIES, readProperty, withProperty } from './properties'
import { pathKey, retargetLinks } from './links'
import type { NoteIndex, NoteMoves } from './links'
import {
  extensionOf,
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
 * One entry of a folder listing. `plugin-fs`'s `DirEntry` also has
 * `isSymlink`, which nothing reads, so its entries pass straight through.
 */
interface VaultDirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
}

/**
 * The app's filesystem: the eight calls everything above it makes.
 *
 * `vault.ts` is the only module that imports `@tauri-apps/plugin-fs`, so a
 * test's `vi.mock` of it reaches everything. Another backend (mobile, sync)
 * implements these eight calls and nothing else. Every path is absolute.
 */
export interface VaultFs {
  /** True for a file or a folder. Both volumes are case-insensitive, so this is too. */
  exists(path: string): Promise<boolean>
  /**
   * Rejects when there is no file. A caller that treats absent
   * as a value checks `exists` first.
   */
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
  /**
   * Bytes, for a file dragged in from outside, such as a PDF or a photo.
   * The dropped file arrives as bytes, and `String()` of a PDF breaks it.
   */
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
}

/**
 * The surface over the real disk, and the only place `plugin-fs`
 * is called. Everything below goes through `vaultFs`, so a
 * function that needs a ninth call has to widen the interface.
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
 * The last read's tree, so an unchanged read returns the same objects and React skips
 * the re-render. Window focus reads the whole vault, and most reads find nothing new.
 *
 * The read can't be skipped: on APFS a folder's mtime doesn't
 * change when a file inside it is written in place.
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
  // Compare `absolutePath` too: two vaults of the same shape
  // would otherwise keep the old tree.
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
 * Every file, not only the ones the app edits: the tree shows what is in the
 * folder, and `fileKind` decides how each one opens. The walk skips
 * dot-prefixed entries, which keeps `.config` and `.claude` out of the tree.
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

  // Subfolders are read in parallel: each listing is one IPC
  // round trip. The sort below makes the finish order irrelevant.
  const descend: Promise<VaultFolder>[] = []

  for (const entry of entries) {
    // Dot-prefixed entries are skipped, so `safeNewName` refuses a
    // leading dot: a `.plan.md` would be written and never shown.
    if (entry.name.startsWith('.')) continue
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    const absolutePath = `${absoluteDir}/${entry.name}`

    if (entry.isFile) {
      folder.files.push({
        path: relativePath,
        absolutePath,
        // Only `.md` is stripped, so `data.json` and `plan.pdf`
        // can't be mistaken for notes called `data` and `plan`.
        name: noteName(entry.name),
      })
    } else if (entry.isDirectory) {
      descend.push(walk(absolutePath, relativePath, entry.name))
    }
  }

  folder.folders = await Promise.all(descend)

  // Move `Areas/Areas.md` onto its folder, so it is the folder's
  // own row rather than a child.
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

/**
 * Collapses `.` and `..` so a containment check can't be walked
 * past. Textual, which is enough: the app creates no symlinks.
 */
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
 * A rename changes a name, never a location: the destination must be inside
 * the entry's own parent. Checked on the resolved path rather than the
 * name's characters: `../../Desktop/x` once renamed a note out of the vault.
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
 * A file's text, decrypted if it is locked. Everything above this sees plain text. A
 * file nobody has unlocked throws `LockedFileError`, and `App` asks for the passphrase.
 */
export async function readVaultFile(file: VaultFile): Promise<string> {
  const raw = await vaultFs.readText(file.absolutePath)
  if (!isEncrypted(file.path)) return raw
  const passphrase = passphraseFor(file.path)
  if (passphrase === null) throw new LockedFileError(file.path)
  return decryptNote(raw, passphrase)
}

/**
 * Writes `raw`, encrypted if the file is locked. It reuses the
 * file's salt, so the derived key stays cached and typing doesn't
 * pay for PBKDF2 on every save; the IV is new every time.
 *
 * A locked file with no passphrase is not written: plain text in
 * a `.enc` file can't be undone.
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
 * Copies what is on disk for `file` to `name (other).ext`, the sync's
 * rule for two sides of one change (`other_path` in `sync.rs`). It
 * copies the bytes, so a locked note's copy stays encrypted. An existing
 * copy is never overwritten; the next free `(other N)` is used.
 */
export async function keepOther(file: VaultFile): Promise<VaultFile> {
  const root = file.absolutePath.slice(0, file.absolutePath.length - file.path.length - 1)
  const ext = extensionOf(file.path)
  const stem = file.path.slice(0, file.path.length - ext.length)
  let other = vaultFileRef(root, `${stem} (other)${ext}`)
  for (let n = 2; await vaultFs.exists(other.absolutePath); n++) other = vaultFileRef(root, `${stem} (other ${n})${ext}`)
  await vaultFs.writeText(other.absolutePath, await vaultFs.readText(file.absolutePath))
  return other
}

/**
 * Tries a passphrase on a locked file and remembers it if it works.
 * Throws `WrongPassphraseError` for a wrong one and `DamagedFileError`
 * for a damaged file, since only the first is worth retyping.
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
 * Writes a note's `path::`, and every note's under a moved
 * folder. The property travels with the file, so the app has to
 * keep it true. The value is the vault path without `.md`.
 *
 * Only notes on disk are written: a folder note is created by
 * its first keystroke, not by this. Returns the notes that exist
 * but couldn't be read; a failed write still throws.
 */
export async function writePathProperty(files: readonly VaultFile[]): Promise<string[]> {
  const unread: string[] = []
  for (const file of files) {
    // Only notes: a JSON file that moved isn't read and rewritten.
    if (!isNote(file.path)) continue
    if (!(await vaultFs.exists(file.absolutePath))) continue
    const raw = await vaultFs.readText(file.absolutePath).catch(() => null)
    if (raw === null) {
      unread.push(file.path)
      continue
    }
    // `knownPath`: a nested note is `Areas/Northwind`, not the
    // file `Areas/Northwind/Northwind.md`.
    await vaultFs.writeText(file.absolutePath, withProperty(raw, APP_PROPERTIES.path, knownPath(file.path)))
  }
  return unread
}

/**
 * The icon of the folder a note is in, from the folder's own note, or
 * null. Read from disk, not the corpus: the corpus arrives a moment after
 * launch, so a note made in the first second would inherit nothing.
 */
export async function folderIcon(vaultPath: string, notePath: string): Promise<string | null> {
  const folder = folderOf(notePath)
  if (!folder) return null
  const own = `${vaultPath}/${folderNotePath(folder)}`
  if (!(await vaultFs.exists(own))) return null
  return readProperty(await vaultFs.readText(own).catch(() => ''), APP_PROPERTIES.icon)
}

/**
 * Writes one page property into a note. A note not on disk yet is created with
 * just the property, since folder notes are written lazily. One that exists
 * but can't be read throws: treated as missing, it was once overwritten.
 */
export async function writeNoteProperty(
  file: VaultFile,
  key: string,
  value: string | null
): Promise<void> {
  // Only notes get properties: an `icon::` line written into a `.json` file breaks it.
  if (!isNote(file.path)) return
  const raw = (await vaultFs.exists(file.absolutePath)) ? await vaultFs.readText(file.absolutePath) : ''
  await vaultFs.writeText(file.absolutePath, withProperty(raw, key, value))
}

// ---------------------------------------------------------------------------
// The vault's own configuration
// ---------------------------------------------------------------------------
//
// A vault carries its settings in `.config/`, so copying the folder takes the theme,
// type, shortcuts and daily folder with it. `localStorage` keeps the last applied set
// for the window before a vault opens. The walk skips dot folders, so `.config` stays
// out of the tree.

export const CONFIG_DIR = '.config'

/** The file every skill folder holds — Claude Code's layout, `<name>/SKILL.md`. */
export const SKILL_FILE = 'SKILL.md'

/**
 * The text of a file in the vault's `.config`, or null when it isn't there (normal
 * for a new vault). One that exists but can't be read throws: callers write a file
 * they find missing, and returning null had them overwrite an unreadable one.
 */
export async function readConfigFile(vaultPath: string, name: string): Promise<string | null> {
  const path = `${vaultPath}/${CONFIG_DIR}/${name}`
  if (!(await vaultFs.exists(path))) return null
  return vaultFs.readText(path)
}

/**
 * Writes a file into the vault's `.config`, creating the folders
 * above it. `name` may be a path.
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
 * The tmux config for the terminal's server. Written once, then the user's to edit.
 *
 * - `status off`: no status bar, so the pane looks like a terminal, not tmux.
 * - `mouse off`: the wheel and scrollback stay xterm's; tmux's
 *   copy mode would take them.
 * - `prefix None`, `C-b` unbound: `C-b` is back one character in
 *   readline, and the app drives the session, so no prefix is needed.
 * - `destroy-unattached off`: a session with no client stays alive, which is the point.
 * - `default-terminal` and `Tc`: the same truecolour the pane gives the PTY.
 */
const TMUX_CONF = `# Written by Journeys when a Terminal tab first opened.
# Yours to edit: this file is read once, when the session server starts, and is
# never rewritten. It applies only to Journeys' own tmux server for this vault,
# on a socket of its own, and never to tmux you run yourself.

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
 * Writes the tmux config if the vault has none, and leaves an edited
 * one alone. Quiet either way: the terminal reports its own problems.
 */
export async function ensureTmuxConfig(vaultPath: string): Promise<void> {
  if ((await readConfigFile(vaultPath, TMUX_FILE)) !== null) return
  await writeConfigFile(vaultPath, TMUX_FILE, TMUX_CONF)
}

/**
 * The same, at a vault-relative path, for a kind whose folder
 * isn't under `.config`. Creates every folder on the way.
 */
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
 * The files in a vault-relative folder, dot-prefixed ones included (skills live in
 * `.claude/skills`). Every `fs:` scope must name such a folder literally: `**`
 * doesn't match a dot folder, and fails silently. `capability.test.ts` checks this.
 */
export async function listVaultDir(vaultPath: string, dir: string): Promise<string[]> {
  // No trailing slash: `exists` on `…/.config/` returned false.
  const path = `${vaultPath}/${dir}`
  if (!(await vaultFs.exists(path))) return []
  // No `.catch`: a missing folder already returned `[]`, so a catch
  // would only hide a scope that doesn't reach. The caller reports it.
  const entries = await vaultFs.list(path)
  return entries
    .filter((entry) => entry.isFile && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * The folders in a vault-relative folder that hold `entry`, as `<folder>/<entry>`. A
 * skill is a folder (`.claude/skills/<name>/SKILL.md`), so listing files finds nothing.
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

/**
 * A file at a vault-relative path, as something the pane can open.
 * These are outside the tree, since the walk skips dot folders. A skill
 * is named after its folder, because every one is called `SKILL.md`.
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
 * The rule for a created or renamed name. A leading dot is refused, not removed: the
 * walk skips dot entries, so `.plan.md` would be written and then vanish from the tree.
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
 * Creates every missing folder in a vault-relative path, and returns
 * the path as the disk spells it. Each segment goes through
 * `safeNewName`, because a parent can come from a typed `[[link]]`.
 *
 * A folder made here is a nested note with nothing in it: its
 * `.md` is written on the first keystroke, so no file is made.
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
 * Copies a file dragged in from outside into `parentPath`, under its own name.
 * The name follows the rule for a typed one, so `../` can't escape the vault.
 * An existing file is never overwritten; the result says which were already
 * there. The bytes come from the drop, since a dragged `File` has no path here.
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

/** Where a file from the phone is kept when the settings don't say (`filesFolder`). */
export const FILES_FOLDER = 'Files'

/**
 * Where a file kept from the phone goes in `folder`: under its own name, or with
 * ` 2`, ` 3`… before the extension when that is taken, so nothing is refused and
 * nothing is written over.
 */
async function freeFile(vaultPath: string, folder: string, name: string): Promise<VaultFile> {
  const parent = await ensureFolder(vaultPath, folder)
  const base = safeName(name).replace(/^\.+/, '') || 'shared'
  const extension = extensionOf(base)
  for (let n = 1; ; n++) {
    const fileName = n === 1 ? base : `${base.slice(0, base.length - extension.length)} ${n}${extension}`
    const path = `${parent}/${fileName}`
    if (!(await vaultFs.exists(`${vaultPath}/${path}`))) return { path, absolutePath: `${vaultPath}/${path}`, name: noteName(fileName) }
  }
}

/**
 * A shared file's copy (`from`, in the app's own files) moved into `folder`. A
 * move, as the app's files and the vault are on one disk, so a large video is not
 * read through the page.
 */
export async function keepShared(vaultPath: string, folder: string, name: string, from: string): Promise<VaultFile> {
  const file = await freeFile(vaultPath, folder, name)
  await vaultFs.move(from, file.absolutePath)
  return file
}

/** A file picked on the phone, written into `folder` from its bytes. */
export async function keepFile(vaultPath: string, folder: string, name: string, bytes: Uint8Array): Promise<VaultFile> {
  const file = await freeFile(vaultPath, folder, name)
  await vaultFs.writeBytes(file.absolutePath, bytes)
  return file
}

/**
 * Creates a note and any missing folders above it: a `[[link]]` can name
 * a place before it exists. `name` is one segment; a `/` in it is folded.
 */
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
 * Creates a locked note at the top of the vault, encrypted from its first
 * byte: a plain copy synced once stays readable in history. The
 * passphrase is kept for the window, so the note opens without asking.
 */
export async function createLockedNote(
  vaultPath: string,
  name: string,
  passphrase: string
): Promise<VaultFile> {
  const base = safeNewName(noteName(name))
  // A name is one note, locked or not.
  for (const taken of [`${base}.enc`, `${base}.enc.md`, `${base}.md`]) {
    if (await vaultFs.exists(`${vaultPath}/${taken}`)) throw new Error(`"${taken}" already exists.`)
  }
  const file = { path: `${base}.enc`, absolutePath: `${vaultPath}/${base}.enc`, name: base }
  await vaultFs.writeText(file.absolutePath, await encryptNote('', passphrase))
  remember(file.path, passphrase)
  return file
}

/**
 * Where daily notes live when the caller doesn't say. Exported
 * so `settings.ts` uses the same default.
 */
export const DAILY_FOLDER = 'Daily'

/**
 * Today's daily note, created with its folder if missing. `folder` is one
 * segment, because `makeFolder` isn't recursive; `validateFolder` in
 * `settings.ts` enforces that. `Daily/` is a plain folder with no `Daily.md`.
 * The note is written empty, so it exists even if nothing is typed.
 */
export async function ensureDailyNote(
  vaultPath: string,
  folder = DAILY_FOLDER,
  day = localDateStamp()
): Promise<{ file: VaultFile; created: boolean }> {
  const folderAbsolute = `${vaultPath}/${folder}`
  if (!(await vaultFs.exists(folderAbsolute))) await vaultFs.makeFolder(folderAbsolute)

  const file = dailyNoteFile(vaultPath, folder, day)
  // Only a new day is written. The caller is told whether it was
  // created, because a new note's icon is given once.
  const created = !(await vaultFs.exists(file.absolutePath))
  if (created) await vaultFs.writeText(file.absolutePath, '')
  return { file, created }
}

/** A day's note, whether or not it is written yet. */
export function dailyNoteFile(vaultPath: string, folder: string, day = localDateStamp()): VaultFile {
  const path = `${folder}/${day}.md`
  return { path, absolutePath: `${vaultPath}/${path}`, name: day }
}

// ---------------------------------------------------------------------------
// Moving, renaming, deleting
// ---------------------------------------------------------------------------

/**
 * Moves `from` to `to` unless something else is there, and says whether
 * it moved. A case-only rename is not a collision, though macOS says
 * the destination exists. The same path is a no-op, not an error.
 */
async function moveUnlessTaken(from: string, to: string, taken: string): Promise<boolean> {
  if (to === from) return false
  if (!isSamePath(to, from) && (await vaultFs.exists(to))) throw new Error(taken)
  await vaultFs.move(from, to)
  return true
}

/**
 * The folded name a rename lands on, or null if nothing changes. Compared as typed and
 * as folded, since `safeNewName` can fold a name into the one the file already has.
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
 * Turns a note into a nested note: `Ideas.md` becomes `Ideas/Ideas.md`. One
 * folder and one move: the note's bytes are never rewritten, and links still
 * resolve by name. The name comes from the file, so the folder matches its case.
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
  // A folder can't move into itself or into one of its children.
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
  followUnlocked(folder.path, newRelativePath)
  return { ...folder, path: newRelativePath, absolutePath: newAbsolutePath }
}

export async function renameFile(file: VaultFile, newName: string): Promise<VaultFile> {
  // `safeNewName`, not `safeName`: the destination is built from this name,
  // so a `/`, `..` or leading dot would send the note somewhere unintended.
  const trimmed = renamedTo(file.name, newName)
  if (trimmed === null) return file
  // Keep the file's whole extension: renaming `data.json` once produced `data.md`,
  // and a locked `x.enc.md` kept only `.md`, a plain note holding ciphertext.
  const extension = extensionOf(file.path)
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
  followUnlocked(folder.path, newRelativePath)

  // The folder note is matched by name, so it follows the folder's rename.
  if (folder.note) {
    const movedNote = `${newAbsolutePath}/${folder.name}.md`
    const renamedNote = `${newAbsolutePath}/${trimmed}.md`
    // On a case-insensitive volume, a case-only rename makes
    // these one file (see `moveUnlessTaken`).
    const oneFile = isSamePath(movedNote, renamedNote)
    // Not `moveUnlessTaken`: a note already under the new name is
    // left alone, rather than failing a rename that already happened.
    if ((await vaultFs.exists(movedNote)) && (oneFile || !(await vaultFs.exists(renamedNote)))) {
      await vaultFs.move(movedNote, renamedNote)
    }
  }

  return { ...folder, path: newRelativePath, absolutePath: newAbsolutePath, name: trimmed }
}

/**
 * Rewrites every link that pointed at a moved note, so a rename keeps its
 * backlinks. `before` and `index` are the vault as it was, since they
 * resolve the old names. A note is rewritten only if a link in it changed.
 *
 * Returns the notes that exist but couldn't be read. Locked
 * notes and notes not yet on disk are skipped and not reported.
 */
export async function retargetVaultLinks(
  before: readonly VaultFile[],
  moves: NoteMoves,
  index: NoteIndex
): Promise<string[]> {
  const skipped: string[] = []
  for (const was of before) {
    const now = moves.get(pathKey(was.path)) ?? was
    // Only notes hold links; a JSON file isn't searched.
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

// Links between notes: `[[wikilinks]]`, which the picker writes and
// Obsidian vaults are full of, and markdown links, which are read but no
// longer written. The two forms resolve differently (see `resolveTarget`).
//
// Pure: no filesystem, no React. Note text is the input, so the caller
// decides when to read the vault, and a test of this file mocks nothing.

import { maskCode } from './prose'
import { splitPageProperties } from './properties'
import {
  folderNoteRef,
  folderOf,
  isNote,
  isSamePath,
  isTextFile,
  knownPath,
  noteName,
} from './vaultModel'
import type { VaultFile, VaultFolder } from './vaultModel'

// ---------------------------------------------------------------------------
// Parsing one note
// ---------------------------------------------------------------------------

/** One inline link found in a note — a markdown link or a `[[wikilink]]`. */
interface NoteLink {
  /**
   * The link text. A markdown label has its backslash escapes
   * resolved; a wikilink's is verbatim, since `[[…]]` has no escapes.
   * With no alias it is the target as typed, anchor included.
   */
  label: string
  /**
   * The destination exactly as written: still percent-encoded for a markdown
   * link, the part left of `|` for a wikilink, anchor included. Kept
   * verbatim so it can be found and rewritten; `resolveTarget` decodes it.
   */
  target: string
  /** Offset of `target` in the note, frontmatter included: where a rename rewrites it. */
  targetAt: number
  /**
   * True for `[[a]]`, false for `[a](b)`. It tells `resolveTarget`
   * to look a bare target up by name across the vault, which is
   * right for a wikilink and wrong for a markdown path.
   */
  wiki: boolean
  /**
   * Offset of the `[`, frontmatter included. An embed's `!` sits at `start
   * - 1`, outside the span, so replacing `[start, end)` keeps it an embed.
   */
  start: number
  /** Offset one past the closing `)` or `]]`. */
  end: number
}

/**
 * CommonMark's cap on a label, 999 characters. It also keeps a
 * failed scan over a long run of `[` linear rather than quadratic.
 */
const MAX_LABEL = 1000
/** Same bound, same reason, for the `(...)` after a label. */
const MAX_TARGET = 2000

/** Every ASCII punctuation character, which is exactly what `\` may escape. */
const ESCAPED_PUNCT = /\\([!-/:-@[-`{-~])/g

/** True when the character at `i` is preceded by an odd number of backslashes. */
function isEscaped(text: string, i: number): boolean {
  let slashes = 0
  while (i - slashes > 0 && text[i - slashes - 1] === '\\') slashes++
  return slashes % 2 === 1
}

/** The index of the `]` closing the label that opens at `open`, or -1. */
function labelEnd(text: string, open: number): number {
  let depth = 0
  const stop = Math.min(text.length, open + MAX_LABEL)
  for (let i = open; i < stop; i++) {
    const c = text[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Reads `(target "title")` from the `(` and returns the destination as a range:
 * the scan runs over code-masked text, so the caller slices the real note.
 */
function readTarget(
  text: string,
  paren: number
): { from: number; to: number; end: number } | null {
  const stop = Math.min(text.length, paren + MAX_TARGET)
  let i = paren + 1
  const space = () => {
    while (i < stop && (text[i] === ' ' || text[i] === '\t')) i++
  }
  space()

  let from: number
  let to: number
  if (text[i] === '<') {
    // `[label](<my file.md>)` is legal, and is how a destination
    // holds a space unencoded.
    const close = i + 1 + text.slice(i + 1, stop).search(/(?<!\\)>/)
    if (close < i + 1 || text.slice(i, close).includes('\n')) return null
    from = i + 1
    to = close
    i = close + 1
  } else {
    from = i
    let depth = 0
    while (i < stop) {
      const c = text[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === ' ' || c === '\t' || c === '\n') break
      if (c === '(') depth++
      else if (c === ')') {
        if (depth === 0) break
        depth--
      }
      i++
    }
    to = i
  }

  space()
  const quote = text[i]
  if (quote === '"' || quote === "'" || quote === '(') {
    const closer = quote === '(' ? ')' : quote
    let j = i + 1
    while (j < stop && !(text[j] === closer && !isEscaped(text, j))) j++
    if (j >= stop) return null
    i = j + 1
    space()
  }

  if (text[i] !== ')') return null
  return { from, to, end: i + 1 }
}

/**
 * Reads `[[target#anchor|alias]]` from the first `[`, as offsets: `bar`
 * is the `|` or -1, `to` is the first `]`, `end` is one past the second.
 *
 * A `[` or a newline inside ends the attempt, so a stray `[[` can't swallow
 * a paragraph, `[[a[[b]]` is one link to `b`, and the scan stays linear.
 */
function readWikiLink(
  text: string,
  open: number
): { bar: number; to: number; end: number } | null {
  if (text[open + 1] !== '[') return null
  const stop = Math.min(text.length, open + 2 + MAX_LABEL)
  let bar = -1
  for (let i = open + 2; i < stop; i++) {
    const c = text[i]
    if (c === '[' || c === '\n') return null
    if (c === ']') return text[i + 1] === ']' ? { bar, to: i, end: i + 2 } : null
    if (c === '|' && bar === -1) bar = i
  }
  return null
}

/**
 * Every inline link in a note that could point at another note.
 *
 * Skipped: images (`![alt](x.png)`), links in code or frontmatter, an escaped
 * `\[`, and external destinations (any scheme, `//host`, or empty). Wikilinks
 * count in every form, `![[a]]` embeds included, since an embed is a reference to
 * the note; `![[picture.png]]` drops out as external. `[[]]` is not a link.
 * Reference links (`[label][ref]`) aren't parsed: nothing writes them.
 */
export function parseNoteLinks(text: string): NoteLink[] {
  const { prefix, body } = splitPageProperties(text)
  const masked = maskCode(body)
  const links: NoteLink[] = []

  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '[' || isEscaped(masked, i)) continue

    // Before the image skip, so `![[a]]` is a link and `![a](b)` isn't,
    // and before the markdown attempt, so `[[a]]` isn't read as a label.
    const wiki = readWikiLink(masked, i)
    if (wiki) {
      const target = body.slice(i + 2, wiki.bar === -1 ? wiki.to : wiki.bar)
      // No `isExternalTarget` check: a wikilink can't point outside
      // the vault, and `Q3: plan` would read as a URL scheme.
      if (target.trim()) {
        links.push({
          label: body.slice(wiki.bar === -1 ? i + 2 : wiki.bar + 1, wiki.to),
          target,
          targetAt: prefix.length + i + 2,
          wiki: true,
          start: prefix.length + i,
          end: prefix.length + wiki.end,
        })
      }
      i = wiki.end - 1
      continue
    }

    // An image's `!` sits one character before an otherwise identical link.
    if (i > 0 && masked[i - 1] === '!' && !isEscaped(masked, i - 1)) continue
    const close = labelEnd(masked, i)
    if (close === -1 || masked[close + 1] !== '(') continue
    const read = readTarget(masked, close + 1)
    if (!read) continue
    const target = body.slice(read.from, read.to)
    if (!isExternalTarget(target)) {
      links.push({
        label: body.slice(i + 1, close).replace(ESCAPED_PUNCT, '$1'),
        target,
        targetAt: prefix.length + read.from,
        wiki: false,
        start: prefix.length + i,
        end: prefix.length + read.end,
      })
    }
    i = read.end - 1
  }

  return links
}

/**
 * Whether a destination points outside the vault by its syntax: any scheme, `//host`,
 * or empty. Whether an internal path is a note is `resolveTarget`'s question.
 */
export function isExternalTarget(target: string): boolean {
  const t = target.trim()
  if (!t) return true
  if (t.startsWith('//')) return true
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(t)
}

// ---------------------------------------------------------------------------
// Resolving a target against the vault
// ---------------------------------------------------------------------------

/**
 * The normal form a path is keyed and compared by: no trailing
 * slash, no `.md`, lowercased. It matches `isSamePath` exactly,
 * so two paths share a key when that calls them one file.
 */
export function pathKey(path: string): string {
  return noteName(path.replace(/\/+$/, '')).toLowerCase()
}

/**
 * The normal form a note name is keyed by, for a wikilink's vault-wide
 * lookup: the last segment of `pathKey`. So `Ideas`, `Ideas/` and
 * `Ideas/Ideas.md` all name `ideas`, and a folder note is one candidate,
 * not two. A non-`.md` extension is kept: `picture.png` isn't a note name.
 */
function nameKey(path: string): string {
  const key = pathKey(path)
  return key.slice(key.lastIndexOf('/') + 1)
}

/** Collapses `.` and `..`; null when the path walks out of the vault. */
function normalizeVaultPath(path: string): string | null {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(segment)
  }
  return out.join('/')
}

/** The first `#` or `?` that is not backslash-escaped ends the path part. */
function cutAnchor(target: string): string {
  for (let i = 0; i < target.length; i++) {
    if ((target[i] === '#' || target[i] === '?') && !isEscaped(target, i)) return target.slice(0, i)
  }
  return target
}

/**
 * Decodes `Notes/Q3%20plan.md` to `Notes/Q3 plan.md`, leaving a
 * malformed escape as typed. The whole-string decode is tried
 * first, since it is the only way to get multi-byte escapes right.
 */
function decodeTarget(target: string): string {
  const literal = target.replace(ESCAPED_PUNCT, '$1')
  try {
    return decodeURIComponent(literal)
  } catch {
    return literal.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run)
      } catch {
        return run
      }
    })
  }
}

/** Every note in the vault, folder notes included, in tree order. */
export function collectNotes(root: VaultFolder): VaultFile[] {
  const out: VaultFile[] = []
  const walk = (folder: VaultFolder) => {
    // A folder is a note even before its file is written, since the tree
    // opens it either way; `folderNoteRef` says where that file is or would
    // be. The root is not a note, so it only adds a note already on disk.
    if (folder.path) out.push(folderNoteRef(folder))
    else if (folder.note) out.push(folder.note)
    out.push(...folder.files)
    folder.folders.forEach(walk)
  }
  walk(root)
  return out.filter((file) => isTextFile(file.path))
}

/**
 * The folders a note is reached through, outermost first: `Areas`, then
 * `Areas/Plans` for `Areas/Plans/Q3.md`. Uses `knownPath`, so a nested note's
 * trail stops at its parent, and only folders the tree draws are included.
 */
export function trailTo(root: VaultFolder | null, path: string): VaultFolder[] {
  const parts = knownPath(path).split('/')
  const found: VaultFolder[] = []
  for (let depth = 1; depth < parts.length; depth++) {
    const folder = folderAt(root, parts.slice(0, depth).join('/'))
    if (folder) found.push(folder)
  }
  return found
}

/**
 * The folder at `path` in this tree, or null. After a move the returned folder
 * object doesn't describe its children (see `mutate`), so look them up here.
 */
export function folderAt(root: VaultFolder | null, path: string): VaultFolder | null {
  if (!root) return null
  if (isSamePath(root.path, path)) return root
  for (const child of root.folders) {
    const found = folderAt(child, path)
    if (found) return found
  }
  return null
}

/**
 * Every note in a folder that is on disk, the folder's own note included. A
 * folder note not written yet is skipped, so a bulk write doesn't create
 * it. `collectNotes` includes it, which is right for links and wrong here.
 */
export function existingNotesIn(folder: VaultFolder): VaultFile[] {
  const out: VaultFile[] = []
  const walk = (f: VaultFolder) => {
    if (f.note) out.push(f.note)
    out.push(...f.files)
    f.folders.forEach(walk)
  }
  walk(folder)
  return out
}

/** Every folder path in the vault. Not the root, which can't be shut. */
export function collectFolders(root: VaultFolder): string[] {
  const out: string[] = []
  const walk = (folder: VaultFolder) => {
    if (folder.path) out.push(folder.path)
    folder.folders.forEach(walk)
  }
  walk(root)
  return out
}

/** Notes in lookup form. Build it once per vault read, not once per link. */
export interface NoteIndex {
  /** As given: tree order, which the picker lists when nothing is typed. */
  notes: VaultFile[]
  byKey: Map<string, VaultFile>
  /**
   * Every note with one `nameKey`, best candidate first. Only a
   * bare-name wikilink resolves through this. A list, because the
   * pick depends on where the link was written (see `resolveTarget`).
   */
  byName: Map<string, VaultFile[]>
}

export function buildNoteIndex(notes: VaultFile[]): NoteIndex {
  const byKey = new Map<string, VaultFile>()
  for (const note of notes) byKey.set(pathKey(note.path), note)
  // `Ideas` and `Ideas/Ideas.md` are one note, or a folder note's backlinks
  // would split by spelling. The alias never displaces a real note at that path.
  for (const note of notes) {
    const cut = note.path.lastIndexOf('/')
    if (cut === -1) continue
    const dir = note.path.slice(0, cut)
    if (!isSamePath(dir.slice(dir.lastIndexOf('/') + 1), note.name)) continue
    if (!byKey.has(pathKey(dir))) byKey.set(pathKey(dir), note)
  }

  // Built from `notes`, one entry per note: `byKey` holds a
  // folder note under two paths and would list it twice.
  const byName = new Map<string, VaultFile[]>()
  for (const note of notes) {
    const list = byName.get(nameKey(note.path))
    if (list) list.push(note)
    else byName.set(nameKey(note.path), [note])
  }
  // Fewest path segments first (Obsidian's shortest path), then the path, so
  // the order never depends on read order and the graph is the same every time.
  for (const list of byName.values()) {
    if (list.length > 1) {
      list.sort(
        (a, b) =>
          a.path.split('/').length - b.path.split('/').length ||
          (pathKey(a.path) < pathKey(b.path) ? -1 : 1)
      )
    }
  }

  return { notes, byKey, byName }
}

/**
 * What a destination points at:
 *
 * - `note`: an existing note. `note.path` is the vault's
 *   spelling, so links differing only in case agree.
 * - `new`: an internal link with no note yet. `path` is where it would go,
 *   vault-relative with `.md`. A dangling link is allowed: link now, create later.
 * - `external`: not in the vault. A scheme, `//host`, empty, a
 *   path outside the vault, or a non-`.md` file.
 */
type ResolvedTarget =
  /**
   * Not a note. `target` is as written, so a caller can hand it
   * to the OS or say why it can't open it.
   */
  | { kind: 'external'; target: string }
  | { kind: 'note'; note: VaultFile }
  | { kind: 'new'; path: string }

/**
 * A wikilink's target ends at the first `#`, so `[[Plan#Q3]]`
 * and `[[Plan#^b7f]]` point at `Plan`. No decoding, escapes or
 * `?`: `[[What now?]]` names a note called `What now?`.
 */
function cutWikiAnchor(target: string): string {
  const cut = target.indexOf('#')
  return cut === -1 ? target : target.slice(0, cut)
}

/**
 * `[[Query Layer/DML Files]]` when `Query Layer` is a note elsewhere: the head
 * resolves by name, and the rest hangs off its `knownPath`. Without this,
 * following the link created `Query Layer/DML Files.md` at the root. Tried after
 * the literal readings, so it only changes where an unresolved link is created.
 */
function underNamedNote(written: string, index: NoteIndex): string | null {
  const cut = written.indexOf('/')
  if (cut <= 0) return null
  const found = index.byName.get(nameKey(written.slice(0, cut)))
  return found?.[0] ? `${knownPath(found[0].path)}${written.slice(cut)}` : null
}

/**
 * Where a destination points, read from the note at `fromPath`. Pass the
 * whole `NoteLink`: a bare string is read as a markdown destination.
 *
 * A markdown destination is a path: tried from the vault root first,
 * then from the note's own folder, and the root wins when both resolve.
 * A leading `/` means the root only; `./` and `../` mean the note's
 * folder only. A markdown bare name is not searched across the vault.
 *
 * A wikilink's target is a name, looked up across the vault. A target with a `/`
 * is a path and follows the path rule. When a name matches two notes, the one in
 * the linking note's folder wins, then the shortest path (see `buildNoteIndex`).
 */
export function resolveTarget(
  link: string | NoteLink,
  fromPath: string,
  index: NoteIndex
): ResolvedTarget {
  const wiki = typeof link !== 'string' && link.wiki
  const target = typeof link === 'string' ? link : link.target
  // Only a markdown destination is checked: a wikilink can't
  // point outside, and `Q3: plan` would read as a URL scheme.
  if (!wiki && isExternalTarget(target)) return { kind: 'external', target: target.trim() }
  const written = wiki ? cutWikiAnchor(target).trim() : decodeTarget(cutAnchor(target.trim()))

  // `[x](#a-heading)` and `[[#a-heading]]` link into the note they are in.
  if (!written) {
    const self = index.byKey.get(pathKey(fromPath))
    return self ? { kind: 'note', note: self } : { kind: 'new', path: fromPath }
  }

  const dir = folderOf(fromPath)

  if (wiki && !written.includes('/')) {
    const found = index.byName.get(nameKey(written))
    if (found) {
      return { kind: 'note', note: found.find((n) => isSamePath(folderOf(n.path), dir)) ?? found[0] }
    }
    // No note of that name. A path lookup can't find one either, so this only
    // gets classified, as the root-relative `new` the picker would create.
  }

  const rooted = written.startsWith('/')
  const relative = /^\.\.?(\/|$)/.test(written)
  // What a link naming a note plus a child means, when nothing literal resolves.
  const named = wiki && !rooted && !relative ? underNamedNote(written, index) : null

  /** The text read literally, one reading per form it can take. */
  function literalReadings(): string[] {
    // `/Areas/Plans` is from the vault root, wherever it is written.
    if (rooted) return [written.slice(1)]
    // `./Plans` and `../Plans` are from this note's folder only.
    if (relative) return [`${dir}/${written}`]
    // A bare `Areas/Plans` is either: from the root, or beside this note.
    return [written, `${dir}/${written}`]
  }

  const candidates = [...literalReadings(), ...(named ? [named] : [])]
    .map(normalizeVaultPath)
    .filter((path): path is string => !!path)

  for (const candidate of candidates) {
    const note = index.byKey.get(pathKey(candidate))
    if (note) return { kind: 'note', note }
  }

  // The literal readings decide what resolves; the named one
  // decides what is created, so a link naming an existing note
  // doesn't create its child at the root (see `underNamedNote`).
  const path = (named ? normalizeVaultPath(named) : null) ?? candidates[0]
  if (!path) return { kind: 'external', target: written }
  const note = isNote(path)
  // `assets/plan.png` is a file the app doesn't open, not a note to create.
  // An extension starts with a letter, so `Meeting 2026.09.03` stays a name.
  if (!note && /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(path.slice(path.lastIndexOf('/') + 1))) {
    return { kind: 'external', target: written }
  }
  return { kind: 'new', path: note ? path : `${path}.md` }
}


// ---------------------------------------------------------------------------
// Following a note that has moved
// ---------------------------------------------------------------------------

/**
 * Where each moved note went, keyed by `pathKey` of where it
 * was. A map, because a folder rename moves every note under it.
 */
export type NoteMoves = ReadonlyMap<string, VaultFile>

/**
 * The destination to write in place of `link`'s after its note moved. The form is kept:
 * a bare name stays a bare name and a path stays a path, and any `#anchor` is kept.
 *
 * A markdown destination takes the note's new path, with `.md` if it had one, and
 * spaces percent-encoded if the old one encoded them. A relative destination (`./x`,
 * `../x`) comes back root-relative, since the holding note may have moved too.
 */
function retarget(link: NoteLink, to: VaultFile): string {
  const cut = link.target.indexOf('#')
  const base = cut === -1 ? link.target : link.target.slice(0, cut)
  const anchor = cut === -1 ? '' : link.target.slice(cut)

  if (link.wiki) {
    return (base.includes('/') ? knownPath(to.path) : to.name) + anchor
  }

  const rooted = base.trim().startsWith('/')
  const keepsExtension = /\.md$/i.test(base.trim())
  const path = keepsExtension ? to.path : noteName(to.path)
  const encoded = base.includes(' ') ? path : path.replace(/ /g, '%20')
  return `${rooted ? '/' : ''}${encoded}${anchor}`
}

/**
 * `text` with every link to a moved note pointed at where it is now. `index` and
 * `fromPath` are from before the move, since that is what still resolves the old name.
 *
 * A link is rewritten because it resolves to a moved note, not because its
 * text matches a name. Only the destination changes; alias, label, anchor
 * and brackets stay. Works right to left, so earlier offsets stay valid.
 */
export function retargetLinks(
  text: string,
  fromPath: string,
  moves: NoteMoves,
  index: NoteIndex
): string {
  let out = text
  for (const link of parseNoteLinks(text).reverse()) {
    const resolved = resolveTarget(link, fromPath, index)
    if (resolved.kind !== 'note') continue
    const to = moves.get(pathKey(resolved.note.path))
    if (!to) continue
    out = out.slice(0, link.targetAt) + retarget(link, to) + out.slice(link.targetAt + link.target.length)
  }
  return out
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

/** One note that links here, and the lines it links from. */
export interface Backlink {
  /** The note the mentions are in. */
  note: VaultFile
  /** How many links there are, which isn't `mentions.length`. */
  count: number
  /**
   * The lines the links are on, trimmed, one per line: two links to the same note on
   * one line is one line to read. Never empty; `count` says how many links they hold.
   */
  mentions: string[]
}

/**
 * Keyed by `pathKey` of the target, so `Ideas`, `ideas/ideas.md` and
 * `Ideas/Ideas.md` share an entry (read it with `backlinksTo`). Targets with no
 * note yet are keyed too, so their links are there when the note is created.
 */
export type BacklinkIndex = Map<string, Backlink[]>

/**
 * The folder whose own note is the note at `path`, or null for a plain note. This
 * answers what is inside a note: the end of the note draws the folder with
 * `FolderTree`, like the left pane. A folder note not written yet still answers.
 */
export function folderWithNote(root: VaultFolder | null, path: string): VaultFolder | null {
  return root ? searchForNote(root, path) : null
}

/**
 * Every leaf note the tree is showing, in the order it draws them, and nothing inside
 * a closed folder. It is the order a ⇧-click range runs in, so it covers what is
 * visible, not what exists. Folder rows aren't included; only notes can be picked.
 */
export function visibleFiles(
  folder: VaultFolder | null,
  open: ReadonlySet<string>
): VaultFile[] {
  if (!folder) return []
  const found: VaultFile[] = []
  for (const sub of folder.folders) {
    if (open.has(sub.path)) found.push(...visibleFiles(sub, open))
  }
  found.push(...folder.files)
  return found
}

/**
 * Every child a folder's row would draw: subfolders by their own note, then
 * files. The folder's own note isn't one; `walk` moves it onto the folder.
 */
export function childrenOf(folder: VaultFolder): VaultFile[] {
  return [...folder.folders.map(folderNoteRef), ...folder.files]
}

function searchForNote(folder: VaultFolder, path: string): VaultFolder | null {
  if (folder.path && isSamePath(folderNoteRef(folder).path, path)) return folder
  for (const sub of folder.folders) {
    const found = searchForNote(sub, path)
    if (found) return found
  }
  return null
}

/**
 * Which notes link to which. Takes text as input and never reads
 * the disk, so it stays pure. A note doesn't backlink to itself.
 */
export function buildBacklinkIndex(
  notes: Iterable<{ note: VaultFile; text: string }>,
  index: NoteIndex
): BacklinkIndex {
  const out: BacklinkIndex = new Map()
  for (const { note, text } of notes) {
    const line = lineFinder(text)
    for (const link of parseNoteLinks(text)) {
      const resolved = resolveTarget(link, note.path, index)
      if (resolved.kind === 'external') continue
      const path = resolved.kind === 'note' ? resolved.note.path : resolved.path
      if (isSamePath(path, note.path)) continue
      const key = pathKey(path)
      const list = out.get(key) ?? []
      if (!list.length) out.set(key, list)
      let source = list.find((entry) => isSamePath(entry.note.path, note.path))
      if (!source) {
        source = { note, count: 0, mentions: [] }
        list.push(source)
      }
      mention(source, line(link.start))
    }
  }
  // Sorted so the section is the same whatever order the notes were read in.
  for (const list of out.values()) list.sort((a, b) => a.note.path.localeCompare(b.note.path))
  return out
}

/** The notes linking to one note. Pass the note's own path, `.md` included. */
export function backlinksTo(backlinks: BacklinkIndex, notePath: string): Backlink[] {
  return backlinks.get(pathKey(notePath)) ?? []
}

/** Counts a link, and keeps its line unless that line is already listed. */
function mention(entry: Backlink, text: string) {
  entry.count += 1
  const line = text.trim()
  if (line && !entry.mentions.includes(line)) entry.mentions.push(line)
}

/**
 * The line an offset falls on, by binary search over line
 * starts. Built once per note, not once per link.
 */
function lineFinder(text: string): (at: number) => string {
  // Split on `\n` only: a CRLF's `\r` stays on the line, and `mention` trims it.
  const lines = text.split('\n')
  let offset = 0
  const starts = lines.map((line) => {
    const start = offset
    offset += line.length + 1
    return start
  })
  return (at) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= at) lo = mid
      else hi = mid - 1
    }
    return lines[lo] ?? ''
  }
}

// ---------------------------------------------------------------------------
// Matching, for the `[[` picker
// ---------------------------------------------------------------------------

interface NoteMatch {
  note: VaultFile
  score: number
}

/** exact, then prefix, then the start of a word inside, then anywhere. */
function tier(haystack: string, query: string): number {
  const h = haystack.toLowerCase()
  if (h === query) return 4
  if (h.startsWith(query)) return 3
  const at = h.indexOf(query)
  if (at === -1) return 0
  return /[ \-_/.]/.test(h[at - 1] ?? '') ? 2 : 1
}

/**
 * Notes matching what is typed after `[[`, best first.
 *
 * The score is `tier(name) * 5 + tier(path)`, where a tier is exact 4,
 * prefix 3, word start 2, anywhere 1, none 0. So any hit on the name
 * beats a hit on the path alone, and the path term lets `notes/road` find
 * a note by its folder. Ties go to the shorter name, then the path. No
 * fuzzy matching: it is harder to predict than typing one more letter.
 */
export function matchNotes(query: string, notes: VaultFile[], limit = 20): NoteMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return notes.slice(0, limit).map((note) => ({ note, score: 0 }))
  return notes
    .map((note) => ({ note, score: tier(note.name, q) * 5 + tier(pathKey(note.path), q) }))
    .filter((match) => match.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.note.name.length - b.note.name.length ||
        a.note.path.localeCompare(b.note.path)
    )
    .slice(0, limit)
}

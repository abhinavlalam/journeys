// Links between notes: **`[[wikilinks]]`**, which is what the picker writes and what
// a vault brought over from Obsidian is almost entirely made of, and **standard
// markdown links**, which this app reads but no longer writes.
//
// Reading is deliberately wider than writing, and it was the other way round once:
// a parser blind to `[[wikilinks]]` leaves the graph and the backlinks of such a
// vault empty, which is a bug this module shipped. The two forms differ in **how a
// target resolves**, not only in syntax — see `resolveTarget`.
//
// This module is **pure**: no filesystem, no React. It takes note text as input, so
// the caller decides when to pay for reading the vault. Nothing here imports
// `vault.ts`: what it needed from there — `folderNoteRef`, `isSamePath`,
// `splitFrontmatter`
// at module scope, so a test of this file still needs that seam mocked — see
// `links.test.ts`.

import { splitFrontmatter } from './frontmatter'
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
   * The link text. A markdown label has its backslash escapes resolved, so
   * `[a \[b\]](x)` labels `a [b]`; a wikilink's is **verbatim**, because `[[…]]`
   * has no escape syntax and a note really can be called `a\b`. With no alias the
   * label is the target as typed, anchor included: `[[Plan#Q3]]` labels `Plan#Q3`.
   */
  label: string
  /**
   * The destination **exactly as written** — for a markdown link still
   * percent-encoded, for a wikilink the left of the `|` and nothing else, both
   * still carrying any `#anchor`. Kept verbatim so a caller can find this text
   * again and rewrite it; `resolveTarget` is what decodes it.
   */
  target: string
  /**
   * True for `[[a]]`, false for `[a](b)`. **Not cosmetic**: it is what tells
   * `resolveTarget` to look a bare target up by *name* across the vault, which is
   * a wikilink's whole semantics and would be wrong for a markdown path.
   */
  wiki: boolean
  /**
   * Offset of the `[` in the string handed to `parseNoteLinks`, frontmatter
   * included. The `!` of an embed, `![[a]]`, sits at `start - 1` — outside the
   * span, so replacing `[start, end)` leaves the embed an embed.
   */
  start: number
  /** Offset one past the closing `)` or `]]`. */
  end: number
}

/**
 * CommonMark caps a link label at 999 characters. Honoured here for a second
 * reason: a failed label scan restarts one character along, so an unbounded scan
 * turns a run of 20,000 `[` into a quadratic walk. The cap makes the worst case
 * linear in the text.
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

function blank(run: string): string {
  return run.replace(/[^\n]/g, ' ')
}

/**
 * Replaces every code region with spaces, **keeping the string's length** so offsets
 * into it are still offsets into the original.
 *
 * Without this, every markdown link in every code sample in the vault becomes a
 * backlink. Handles fences of three or more backticks or tildes, indented up to
 * three spaces, closed by a run at least as long — and unclosed fences, which run to
 * the end of the note.
 *
 * A four-space-indented code block is deliberately *not* masked: in these notes a
 * deeply nested list item is far more common than an indented code sample, and
 * masking those would silently drop real links.
 */
function maskCode(text: string): string {
  const lines = text.split('\n')
  let out = ''
  let fence: { char: string; len: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const nl = i < lines.length - 1 ? '\n' : ''
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null
      out += blank(line) + nl
      continue
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    // An info string may not hold a backtick, so ``` `js` ``` is an inline span.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], len: open[1].length }
      out += blank(line) + nl
      continue
    }
    out += line + nl
  }

  return maskInlineCode(out)
}

/**
 * Masks inline code spans. A run of N backticks is closed by the next run of
 * *exactly* N — and a run with no such closer is literal text, not an opener, so an
 * unpaired backtick cannot swallow the rest of the note. A blank line ends the
 * search: it ends the paragraph, so the backticks are literal.
 */
function maskInlineCode(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] !== '`') {
      out += text[i++]
      continue
    }
    let open = i
    while (text[open] === '`') open++
    const len = open - i
    const para = text.slice(open).search(/\n[ \t]*\n/)
    const limit = para === -1 ? text.length : open + para
    let j = open
    let end = -1
    while (j < limit) {
      if (text[j] !== '`') {
        j++
        continue
      }
      let run = j
      while (text[run] === '`') run++
      if (run - j === len) {
        end = run
        break
      }
      j = run
    }
    if (end === -1) {
      out += text.slice(i, open)
      i = open
      continue
    }
    out += blank(text.slice(i, end))
    i = end
  }
  return out
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
 * Reads `(target "title")` starting at the `(`, and reports the destination as a
 * *range* rather than a string: the scan runs over code-masked text, so the caller
 * slices the same span out of the real note.
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
    // `[label](<my file.md>)` — legal, and how a destination holds a space unencoded.
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
 * Reads `[[target#anchor|alias]]` starting at the first `[`, as offsets into the
 * text: `bar` is the `|` or -1, `to` is the first `]`, `end` is one past the second.
 *
 * A bracket or a newline inside **ends the attempt** rather than nesting or running
 * on. That is the defence against a stray `[[` swallowing a paragraph, it is why
 * `[[a[[b]]` is one link to `b` — the outer attempt dies on the inner `[`, and the
 * scan reaches the inner `[[` a character later — and it is also what keeps the cost
 * linear: a failed attempt restarts one character along, but an attempt from a `[[`
 * stops at the next `[`, so the total work is the sum of the gaps between brackets.
 * `MAX_LABEL` is therefore belt-and-braces here, bounding one runaway scan rather
 * than a quadratic walk; it is deliberately the same bound as a markdown label's.
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
 * Every inline link in one note that could point at another note.
 *
 * Skipped: images (`![alt](x.png)`), links inside fenced or inline code, anything in
 * frontmatter, an escaped `\[`, and external destinations — a scheme (`https:`,
 * `mailto:`, anything), a protocol-relative `//host/x`, or nothing at all.
 *
 * `[[a]]`, `[[a|b]]`, `[[a#h]]` and `[[a#h|b]]` are links too, and so is the embed
 * `![[a]]`: Obsidian transcludes the note there and counts it in its own graph, and
 * a transclusion is a stronger reference to that note than a link, not a weaker one.
 * An `![[picture.png]]` still drops out, because `resolveTarget` calls a non-`.md`
 * destination external. **The two `!` forms therefore differ**, deliberately:
 * `![alt](x)` is how markdown writes a *picture*, which is an asset and not a
 * reference to a note, so it stays skipped. `[[]]` names nothing and is not a link.
 *
 * Reference links (`[label][ref]` with a `[ref]: …` definition) are **not** parsed:
 * nothing writes them here and no vault this has met uses them, so a definition
 * table would be code with no caller.
 */
export function parseNoteLinks(text: string): NoteLink[] {
  const { prefix, body } = splitFrontmatter(text)
  const masked = maskCode(body)
  const links: NoteLink[] = []

  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '[' || isEscaped(masked, i)) continue

    // Tried **before** the image skip below, which is what makes `![[a]]` a link
    // while `![a](b)` is not, and before the markdown attempt, so `[[a]]` is not
    // read as a markdown label. A `[[a]]` sitting *inside* a markdown label is not
    // reached: the outer link wins the position and the scan resumes past it.
    const wiki = readWikiLink(masked, i)
    if (wiki) {
      const target = body.slice(i + 2, wiki.bar === -1 ? wiki.to : wiki.bar)
      // No `isExternalTarget`: a wikilink cannot point outside the vault, and a
      // name like `Q3: plan` would read as a URL scheme if it were asked.
      if (target.trim()) {
        links.push({
          label: body.slice(wiki.bar === -1 ? i + 2 : wiki.bar + 1, wiki.to),
          target,
          wiki: true,
          start: prefix.length + i,
          end: prefix.length + wiki.end,
        })
      }
      i = wiki.end - 1
      continue
    }

    // The `!` of an image sits one character before an otherwise identical pattern.
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
 * Is this destination pointing outside the vault *by syntax alone*?
 *
 * Any scheme counts, not a list of known ones: `https:`, `mailto:`, `obsidian:`,
 * `C:/…`. A protocol-relative `//example.com/x` counts. So does an empty
 * destination, which names nothing to open. Whether an internal-looking path is a
 * *note* is `resolveTarget`'s question, not this one.
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
 * The one normal form a path is keyed and compared by: no trailing slash, no `.md`,
 * lowercased.
 *
 * Lowercasing by hand, in one place, because a `Map` needs a normal form and
 * `isSamePath` cannot give one — it is a comparison. The two agree exactly:
 * `isSamePath` *is* `a === b || a.toLowerCase() === b.toLowerCase()`, so two paths
 * share a key here precisely when it calls them one file. Comparisons elsewhere in
 * this module go through it.
 */
export function pathKey(path: string): string {
  return noteName(path.replace(/\/+$/, '')).toLowerCase()
}

/**
 * The normal form a **name** is keyed by, for the vault-wide lookup a wikilink's
 * bare target needs. It is exactly the last segment of `pathKey` — same trailing
 * slash and `.md` stripped, same lowercasing, so case-insensitivity carries over
 * from the volume for free — which is what makes `Ideas`, `Ideas/`, `ideas/ideas`
 * and `Ideas/Ideas.md` all name `ideas`, and a folder note therefore one candidate
 * and not two. A non-`.md` extension is *kept*: `picture.png` is not a note name.
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
 * `Notes/Q3%20plan.md` → `Notes/Q3 plan.md`, and a malformed escape survives.
 *
 * `decodeURIComponent('%zz')` throws, so the whole-string decode is tried first (it
 * is the only way to get a multi-byte `%C3%A9` right) and a failure falls back to
 * decoding each run of escapes that can be decoded, leaving the rest as typed.
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
    // A folder *is* a note (CLAUDE.md), and it is one before its file is written on
    // the first keystroke — the tree opens it either way, so a link to it resolves
    // either way. `folderNoteRef` is what says where that file is or would be. The
    // root is a vault, not a note, so it contributes only a note already on disk.
    if (folder.path) out.push(folderNoteRef(folder))
    else if (folder.note) out.push(folder.note)
    out.push(...folder.files)
    folder.folders.forEach(walk)
  }
  walk(root)
  return out.filter((file) => isTextFile(file.path))
}

/**
 * Every note inside a folder that is *on disk*, the folder's own note included.
 *
 * A folder note is written on the first keystroke (CLAUDE.md), so one that does not
 * exist yet is skipped rather than named: writing a property into it would create
 * the file that browsing a folder is supposed to leave alone. `collectNotes` names
 * it either way, which is right for resolving a link and wrong for a bulk write.
 */
/**
 * The folders a note is **reached through**, outermost first: `Areas` then
 * `Areas/Plans` for `Areas/Plans/Q3.md`.
 *
 * Off `knownPath`, and that is what makes a **nested** note's trail stop at its
 * parent — `Areas/Plans/Plans.md` is known as `Areas/Plans`, so the folder the note
 * *is* does not appear in the path to itself. Reading the tree rather than
 * splitting the string alone, because each step has to be a folder the app draws a
 * row for; one it does not hold is skipped rather than guessed at.
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
 * The folder at `path` in this tree, or null.
 *
 * For reading a folder back out of a walk after it has moved: the object an
 * operation hands back describes the folder itself and not what is under it — see
 * `mutate` — so anything that needs its children looks it up here instead.
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

/** Every folder path in the vault. The root is not one of them: it has no chevron,
    and nothing can shut it. */
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
  /** As handed in: tree order, which is what the picker lists when nothing is typed. */
  notes: VaultFile[]
  byKey: Map<string, VaultFile>
  /**
   * Every note of one `nameKey`, best candidate first — what a bare-name
   * **wikilink** resolves through, and nothing else. A list and not a single note
   * because the pick depends on where the link was written: see `resolveTarget`.
   */
  byName: Map<string, VaultFile[]>
}

export function buildNoteIndex(notes: VaultFile[]): NoteIndex {
  const byKey = new Map<string, VaultFile>()
  for (const note of notes) byKey.set(pathKey(note.path), note)
  // `Ideas` and `Ideas/Ideas.md` are **one link**, not two, or every folder note's
  // backlinks split down the middle by how each author happened to spell it. The
  // alias is added second and never displaces a real note sitting at that path.
  for (const note of notes) {
    const cut = note.path.lastIndexOf('/')
    if (cut === -1) continue
    const dir = note.path.slice(0, cut)
    if (!isSamePath(dir.slice(dir.lastIndexOf('/') + 1), note.name)) continue
    if (!byKey.has(pathKey(dir))) byKey.set(pathKey(dir), note)
  }

  // Built from `notes`, which is one entry per note: `byKey` holds a folder note
  // under two paths (CLAUDE.md's first trap) and walking it would list that one note
  // twice. `nameKey` gives both spellings the same key, so `[[Ideas]]` finds
  // `Ideas/Ideas.md` — the single note the tree opens — either way.
  const byName = new Map<string, VaultFile[]>()
  for (const note of notes) {
    const list = byName.get(nameKey(note.path))
    if (list) list.push(note)
    else byName.set(nameKey(note.path), [note])
  }
  // Fewest path segments first — Obsidian's "shortest path wins" — and then the path
  // itself, which makes the order **total**: the pick can never depend on which
  // order the vault happened to be read in, and the graph is the same on every open.
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
 * The three states a destination can be in — and they are three, not two, because a
 * dangling link is a feature: link it now, create the note later.
 *
 * - `note` — an existing note. `note.path` is the vault's own spelling of it, so
 *   two links that differ in case or in folder-note form agree here.
 * - `new` — an internal link with no note behind it. `path` is where that note
 *   would go, vault-relative and with `.md`, ready for "create it?".
 * - `external` — not a link into the vault: a scheme, a protocol-relative host, an
 *   empty destination, a path that walks out of the vault, or a non-`.md` file.
 */
type ResolvedTarget =
  /** Not a note. `target` is what was written, so a caller can hand it to the OS —
   *  a URL, a mail address — or say why it cannot. */
  | { kind: 'external'; target: string }
  | { kind: 'note'; note: VaultFile }
  | { kind: 'new'; path: string }

/**
 * A wikilink's target ends at the first `#`: `[[Plan#Q3]]` and the block reference
 * `[[Plan#^b7f]]` both point at `Plan`. Unlike a markdown destination there is no
 * percent-decoding, no backslash escape, and **no `?`** — `[[What now?]]` names a
 * note called `What now?`, and a `%20` inside `[[…]]` is those three characters.
 */
function cutWikiAnchor(target: string): string {
  const cut = target.indexOf('#')
  return cut === -1 ? target : target.slice(0, cut)
}

/**
 * Where one destination points, read from the note at `fromPath`. Pass the whole
 * `NoteLink` — a bare string is read as a markdown destination, which is right for
 * an `href` taken off the document and wrong for a wikilink.
 *
 * **A markdown destination is a path.** It is tried root-relative *first*, then
 * relative to the containing note's own folder. The app only ever writes
 * root-relative links, so its own links can never be captured by a same-named
 * neighbour of whatever note they happen to sit in; a hand-written relative link
 * still works, because the second attempt catches it. When both would resolve — the
 * genuinely ambiguous case — **root-relative wins**, silently. A leading `/` means
 * root-relative only; a leading `./` or `../` means note-relative only.
 *
 * A markdown bare name is *not* searched for across the vault. That would make every
 * note name a potential ambiguity with every other, and the picker writes full paths.
 *
 * **A wikilink's target is a name**, and that is the whole of its semantics:
 * `[[Project Aurora]]` means "the note called that, wherever it lives", so it *is*
 * looked up across the vault — the one thing the paragraph above refuses a markdown
 * link. A target holding a `/` is the path it looks like and takes the path rule
 * instead, so `[[Notes/Roadmap]]` works too. Where a name matches **two** notes, the
 * one in the linking note's own folder wins and otherwise the shortest path does;
 * `buildNoteIndex` holds the tie-break and documents it.
 *
 * Either way the answer is one of the same three states, so a wikilink to a name
 * with no note is a dangling link like any other.
 */
/**
 * `[[Query Layer/DML Files]]` when `Query Layer` is a note somewhere else.
 *
 * **A path link's head is a name too.** A slash used to send the whole thing
 * straight to the root-relative reading — the by-name lookup above is guarded on
 * *not* containing one — so a link naming a note plus a child resolved to nothing
 * and then **created** the child at the top of the vault, folder and all. Reported
 * from the running app: `Areas/Northwind/Query Layer.md` already existed, and
 * following `[[Query Layer/DML Files]]` made `Query Layer/DML Files.md` at the
 * root — two things with one name, and the folder sitting beside `Areas`.
 *
 * A note's children live in a folder beside it, so the head resolves by name and the
 * rest hangs off its `knownPath`. Offered **after** the literal readings, so nothing
 * that resolves today changes meaning; what it changes is where an unresolved one is
 * created.
 */
function underNamedNote(written: string, index: NoteIndex): string | null {
  const cut = written.indexOf('/')
  if (cut <= 0) return null
  const found = index.byName.get(nameKey(written.slice(0, cut)))
  return found?.[0] ? `${knownPath(found[0].path)}${written.slice(cut)}` : null
}

export function resolveTarget(
  link: string | NoteLink,
  fromPath: string,
  index: NoteIndex
): ResolvedTarget {
  const wiki = typeof link !== 'string' && link.wiki
  const target = typeof link === 'string' ? link : link.target
  // Only a markdown destination is asked. A wikilink cannot point outside the vault
  // by syntax, and asking would misread a name: `Q3: plan` reads as a URL scheme.
  if (!wiki && isExternalTarget(target)) return { kind: 'external', target: target.trim() }
  const written = wiki ? cutWikiAnchor(target).trim() : decodeTarget(cutAnchor(target.trim()))

  // `[x](#a-heading)`, and `[[#a-heading]]`, link into the note holding them.
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
    // Nothing of that name. A path lookup cannot find one either — every note is in
    // `byName` under its own basename — so this falls through only to be classified,
    // and lands on the root-relative `new` that the picker and `App` would create.
  }

  const rooted = written.startsWith('/')
  const relative = /^\.\.?(\/|$)/.test(written)
  // Where a link naming a note plus a child *means*, when nothing literal resolves.
  const named = wiki && !rooted && !relative ? underNamedNote(written, index) : null

  /** What the text says, read literally — one reading per form it can take. */
  function literalReadings(): string[] {
    // `/Areas/Plans` is from the vault root, whatever note it is written in.
    if (rooted) return [written.slice(1)]
    // `./Plans` and `../Plans` are from this note's own folder, and only there.
    if (relative) return [`${dir}/${written}`]
    // A bare `Areas/Plans` is either: from the root as written, or beside this note.
    return [written, `${dir}/${written}`]
  }

  const candidates = [...literalReadings(), ...(named ? [named] : [])]
    .map(normalizeVaultPath)
    .filter((path): path is string => !!path)

  for (const candidate of candidates) {
    const note = index.byKey.get(pathKey(candidate))
    if (note) return { kind: 'note', note }
  }

  // **The literal readings decide what resolves; the named one decides what is
  // made.** Nothing matched, so the order above no longer matters — what matters is
  // that a link naming an existing note does not create its child at the root. See
  // `underNamedNote`.
  const path = (named ? normalizeVaultPath(named) : null) ?? candidates[0]
  if (!path) return { kind: 'external', target: written }
  const note = isNote(path)
  // `assets/plan.png` is a file this app does not open, not a note to be created.
  // An extension must start with a letter, so `Meeting 2026.09.03` stays a name.
  if (!note && /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(path.slice(path.lastIndexOf('/') + 1))) {
    return { kind: 'external', target: written }
  }
  return { kind: 'new', path: note ? path : `${path}.md` }
}


// ---------------------------------------------------------------------------
// Following a note that has moved
// ---------------------------------------------------------------------------

/**
 * Where a note has gone, keyed by `pathKey` of where it was.
 *
 * A map rather than one pair, because a *folder* rename moves every note under it
 * and a link to any of them has to follow. A file rename is the one-entry case.
 */
export type NoteMoves = ReadonlyMap<string, VaultFile>

/**
 * The destination to write in place of `link`'s, now that its note has moved.
 *
 * **The form is kept, only the name changes.** A wikilink written as a bare name
 * stays a bare name and a wikilink written as a path stays a path, because both are
 * how someone chose to refer to the note — `[[Northwind]]` and
 * `[[Areas/Northwind]]` are the same link and not the same text. Any `#anchor`
 * comes along untouched: the heading it names is inside the note, which is not what
 * moved.
 *
 * A markdown destination is a real path to a real file, so it takes the note's own
 * path, with `.md` if it had one. Spaces are percent-encoded when the destination
 * that was there had none written literally, which is the encoding that was in use.
 * A destination written **relative** (`./x`, `../x`) comes back root-relative: a
 * relative path has to be recomputed against wherever the *holding* note now is,
 * and in a folder rename that has moved too.
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
 * `text` with every link that pointed at a moved note pointing at where it is now.
 *
 * `index` is the index as it was **before** the move, and `fromPath` where the
 * holding note was, because that is what makes `[[Old Name]]` still resolve: after
 * the rename there is no note of that name, and the link would read as one waiting
 * to be created.
 *
 * A link is rewritten because it **resolves** to a moved note, not because its text
 * matches a name. So `[[Plan]]` in a folder holding its own `Plan` is left alone
 * when the `Plan` that moved was another one, and a link written as a path follows
 * a note whose *name* never changed. Nothing else in the line is touched: the alias,
 * the label, the anchor and the brackets are all the user's — the destination is
 * replaced where it sits inside the link, which is why `[Plan](Plan.md)` rewrites
 * the second `Plan` and not the first.
 *
 * Right to left, so the offsets `parseNoteLinks` gave are still good as the text
 * under them changes.
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
    const raw = out.slice(link.start, link.end)
    // The destination's own occurrence: first in `[[target|label]]`, last in
    // `[label](target)`, where a label equal to the target would otherwise win.
    const at = link.wiki ? raw.indexOf(link.target) : raw.lastIndexOf(link.target)
    if (at === -1) continue
    const next = raw.slice(0, at) + retarget(link, to) + raw.slice(at + link.target.length)
    out = out.slice(0, link.start) + next + out.slice(link.end)
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
  /** How many links there are, which is *not* `mentions.length` — see below. */
  count: number
  /**
   * The lines they are written on, trimmed, one entry per line rather than per
   * link: two links to the same note on one line is one thing to read, not two.
   * Never empty, and `count` is what says how many links those lines hold.
   */
  mentions: string[]
}

/**
 * Keyed by `pathKey` of the target's path, so `Ideas`, `ideas/ideas.md` and
 * `Ideas/Ideas.md` all land on one entry. Read it with `backlinksTo`.
 *
 * Targets with **no note behind them** are keyed too: the links into a note exist
 * before the note does, and are there the moment it is created.
 */
export type BacklinkIndex = Map<string, Backlink[]>

/**
 * Which notes link to which.
 *
 * Takes text as **input** and never reads a disk: reading every note in a vault is
 * the expensive part, so the caller decides when to pay for it and this stays a
 * pure function over what it is given.
 *
 * A note does **not** backlink to itself. The section answers "what else points
 * here", and a note is not news to itself; a self link is still a real link that
 * `parseNoteLinks` reports and `resolveTarget` resolves.
 */
/**
 * The folder whose own note is the note at `path`, or null.
 *
 * A nested note *is* a folder plus a same-named note inside it (CLAUDE.md), so this
 * is how "what is inside this note" is answered: with the folder, which the section
 * at the end of the note then draws with `FolderTree` — the same component the left
 * pane uses, so a subfolder in there expands and shows what is inside *it* too.
 *
 * Null for a plain note. A folder note nobody has typed in still answers, because
 * the row and its children are there whether or not the file is.
 */
export function folderWithNote(root: VaultFolder | null, path: string): VaultFolder | null {
  return root ? searchForNote(root, path) : null
}

/** Every child a row of this folder would draw: subfolders by their own note, then
 *  the files. The folder's own note is not one of them — `walk` lifts it off the
 *  file list and onto the folder. */
/**
 * Every leaf note the tree is **showing**, in the order it draws them: a folder's
 * subfolders first and then its own files, which is `FolderTree`'s own order, and
 * nothing inside a folder that is shut.
 *
 * It exists for one thing — the order a ⇧-click's range runs in — and that is why
 * it answers what is *visible* rather than what exists: a range covers the rows
 * between two clicks, and a note hidden inside a shut folder was never between
 * them. A folder's own row is not in it, because picking is leaf notes for now.
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
  // Sorted so the section renders the same way whatever order the notes were read in.
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
 * The line an offset falls on, by binary search over the line starts.
 *
 * Built once per note rather than per link: a note with fifty links would
 * otherwise walk its own text fifty times.
 */
function lineFinder(text: string): (at: number) => string {
  const lines = text.split(/\r?\n/)
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
 * Notes matching what has been typed after `[[`, best first.
 *
 * **The ranking**, and it is deliberately plain: `tier(name) * 5 + tier(path)`.
 * Each tier is exact 4, whole-name prefix 3, word-start inside 2, anywhere else 1,
 * no hit 0 — so any hit on the *name* outranks every hit on the path alone
 * (5 > 4), and within the name an exact match beats a prefix beats a mid-word hit.
 * The path term is what lets `notes/road` find a note by where it lives. Ties go to
 * the shorter name — the tighter match — and then to the path, so the order never
 * depends on input order.
 *
 * No fuzzy subsequence scoring: it needs tuning to feel right, would want a library
 * this project is not taking on, and makes the list harder to predict than typing
 * one more character.
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

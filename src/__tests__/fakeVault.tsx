/**
 * A fake disk that the **real** `vault.ts` runs on top of.
 *
 * The reason it exists is that a fixture written beside the assertion it has to
 * satisfy is narrower than the world in every direction the assertion does not
 * look. A hand-built `VaultFolder` literal gets shaped until the assertion is
 * clean; several real bugs have lived in exactly that gap. So this mocks
 * `@tauri-apps/plugin-fs` and runs the real `walk`, the real `isSamePath` and the
 * real rename guards over an in-memory map.
 *
 * Usage, in a test file (the paths are relative to the *test*, which is why the
 * factories are functions rather than objects):
 *
 *     import { disk, editorModule, fsModule, resetFakeVault } from './fakeVault'
 *     vi.mock('@tauri-apps/plugin-fs', () => fsModule())
 *     vi.mock('../Editor', () => editorModule())
 *     beforeEach(() => { resetFakeVault() })
 */
import { vi } from 'vitest'


// ---------------------------------------------------------------------------
// The disk
// ---------------------------------------------------------------------------

/**
 * Case-insensitive, case-preserving — both volumes this app runs on are, and
 * CLAUDE.md records several bugs that only exist because of it (`exists("Index.md")`
 * answering true for `index.md`, a case-only rename tripping its own guard). A
 * case-sensitive fake disk is a fake disk that cannot reproduce any of them, so
 * every lookup here is by lowercased path and every *listing* gives back the name
 * as it was first written.
 */
interface FakeDir {
  path: string
  /** lowercased name → the name as written. */
  files: Map<string, string>
  dirs: Map<string, string>
}

const dirs = new Map<string, FakeDir>()
const files = new Map<string, { path: string; text: string }>()

/** Paths whose bytes cannot be read, though the entry is listed. See `disk.corrupt`. */
const corrupted = new Set<string>()
/** Path prefixes every write/mkdir under is refused, with this message. */
const forbidden: { prefix: string; message: string }[] = []

const key = (path: string) => path.toLowerCase()
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const under = (path: string, root: string) =>
  key(path) === key(root) || key(path).startsWith(`${key(root)}/`)

function refusal(path: string): string | null {
  const hit = forbidden.find((f) => under(path, f.prefix) || key(path).startsWith(key(f.prefix)))
  return hit ? hit.message : null
}

function ensureDir(path: string): FakeDir {
  const existing = dirs.get(key(path))
  if (existing) return existing
  const dir: FakeDir = { path, files: new Map(), dirs: new Map() }
  dirs.set(key(path), dir)
  const parent = parentOf(path)
  if (parent !== '/' && parent !== path) ensureDir(parent).dirs.set(key(baseOf(path)), baseOf(path))
  return dir
}

function writeFile(path: string, text: string) {
  ensureDir(parentOf(path)).files.set(key(baseOf(path)), baseOf(path))
  // Case-preserving: a write through a differently-cased path lands on the file
  // that is already there and does not rename it, which is what APFS does.
  const already = files.get(key(path))
  files.set(key(path), { path: already?.path ?? path, text })
}

function removeFile(path: string) {
  dirs.get(key(parentOf(path)))?.files.delete(key(baseOf(path)))
  files.delete(key(path))
  corrupted.delete(key(path))
}

function removeDir(path: string) {
  for (const f of [...files.values()]) if (under(f.path, path)) removeFile(f.path)
  for (const d of [...dirs.values()]) if (under(d.path, path)) dirs.delete(key(d.path))
  dirs.get(key(parentOf(path)))?.dirs.delete(key(baseOf(path)))
}

export const disk = {
  /** Writes a file, creating every folder above it. Absolute paths throughout. */
  write(path: string, text: string) {
    writeFile(path, text)
  },
  /** The bytes, or undefined — including for a file that exists but cannot be read. */
  read(path: string): string | undefined {
    return files.get(key(path))?.text
  },
  /** Every file path on the disk, sorted. */
  paths(): string[] {
    return [...files.values()].map((f) => f.path).sort()
  },
  /** Every folder path on the disk, sorted. */
  folders(): string[] {
    return [...dirs.values()].map((d) => d.path).sort()
  },
  has(path: string): boolean {
    return files.has(key(path)) || dirs.has(key(path))
  },
  mkdir(path: string) {
    ensureDir(path)
  },
  delete(path: string) {
    if (files.has(key(path))) removeFile(path)
    else removeDir(path)
  },
  /**
   * Listed by `readDir` and refused by `readTextFile` — an ordinary file that has
   * not materialised locally, which a `Map` mock cannot express because there
   * `exists` denies it too.
   */
  corrupt(path: string) {
    corrupted.add(key(path))
  },
  /** Every write and mkdir under this prefix is refused, as an fs scope would. */
  forbid(prefix: string, message = `forbidden path: ${prefix}`) {
    forbidden.push({ prefix, message })
  },
  clear() {
    dirs.clear()
    files.clear()
    corrupted.clear()
    forbidden.length = 0
  },
}

// ---------------------------------------------------------------------------
// The default vault: shaped by the app, not by any assertion
// ---------------------------------------------------------------------------

/**
 * The shape a folder of notes has after a little use: two notes at the top level,
 * a subfolder, a nested folder note, one note carrying frontmatter, and one note
 * whose last block is a list.
 *
 * Deliberately more than any one assertion needs. The frontmatter note is here so
 * that "the prefix is preserved and invisible" is a fact a test can trip over
 * rather than a rule nobody exercises, and the list-terminated note is the shape
 * that made *opening* a note rewrite it.
 */
const DEFAULT_VAULT: Record<string, string> = {
  'roadmap.md': ['# Roadmap', '', 'The plan, such as it is.', ''].join('\n'),
  'inbox.md': ['# Inbox', '', 'Things not yet filed anywhere.', ''].join('\n'),
  'Ideas/Ideas.md': ['# Ideas', '', 'Things worth trying.', ''].join('\n'),
  'Ideas/pingbird.md': [
    '---',
    'status: draft',
    '---',
    '',
    '# Pingbird',
    '',
    'What the messenger app got right.',
    '',
  ].join('\n'),
  'standup.md': ['Standup notes', '', '- shipped the tree', '- reviewed the editor', ''].join('\n'),
}

/** Lays the default vault down under `root`. Add to or overwrite it per test. */
function seedDefaultVault(root = '/v') {
  ensureDir(`${root}/Ideas`)
  for (const [path, text] of Object.entries(DEFAULT_VAULT)) writeFile(`${root}/${path}`, text)
}

// ---------------------------------------------------------------------------
// The `@tauri-apps/plugin-fs` seam
// ---------------------------------------------------------------------------

function enoent(path: string): Error {
  return new Error(`no such file or directory: ${path}`)
}

const fsSpies = {
  readDir: vi.fn(async (path: string) => {
    const dir = dirs.get(key(path))
    if (!dir) throw enoent(path)
    return [
      ...[...dir.files.values()].map((name) => ({
        name,
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      })),
      ...[...dir.dirs.values()].map((name) => ({
        name,
        isFile: false,
        isDirectory: true,
        isSymlink: false,
      })),
    ]
  }),
  readTextFile: vi.fn(async (path: string) => {
    if (corrupted.has(key(path))) throw new Error(`could not be read: ${path}`)
    const found = files.get(key(path))
    if (!found) throw enoent(path)
    return found.text
  }),
  writeTextFile: vi.fn(async (path: string, text: string) => {
    const no = refusal(path)
    if (no) throw new Error(no)
    writeFile(path, text)
  }),
  exists: vi.fn(async (path: string) => files.has(key(path)) || dirs.has(key(path))),
  /** Bytes, for a file dragged in from outside. The fake keeps text, so they are
   *  decoded on the way in — every test that writes bytes writes text it can read
   *  back, and what is being tested is *where* the file landed. */
  writeFile: vi.fn(async (path: string, bytes: Uint8Array) => {
    const no = refusal(path)
    if (no) throw new Error(no)
    writeFile(path, new TextDecoder().decode(bytes))
  }),
  mkdir: vi.fn(async (path: string) => {
    const no = refusal(path)
    if (no) throw new Error(no)
    ensureDir(path)
  }),
  rename: vi.fn(async (from: string, to: string) => {
    const no = refusal(to)
    if (no) throw new Error(no)
    if (files.has(key(from))) {
      const text = files.get(key(from))!.text
      removeFile(from)
      writeFile(to, text)
      return
    }
    if (!dirs.has(key(from))) throw enoent(from)
    const moving = [...files.values()].filter((f) => under(f.path, from))
    const inner = [...dirs.values()].filter((d) => under(d.path, from)).map((d) => d.path)
    removeDir(from)
    ensureDir(to)
    for (const path of inner) ensureDir(`${to}${path.slice(from.length)}`)
    for (const f of moving) writeFile(`${to}${f.path.slice(from.length)}`, f.text)
  }),
  remove: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
    if (files.has(key(path))) {
      removeFile(path)
      return
    }
    const dir = dirs.get(key(path))
    if (!dir) throw enoent(path)
    if (!options?.recursive && (dir.files.size > 0 || dir.dirs.size > 0)) {
      throw new Error(`directory not empty: ${path}`)
    }
    removeDir(path)
  }),
}

/** The factory for `vi.mock('@tauri-apps/plugin-fs', () => fsModule())`. */
export function fsModule() {
  return { ...fsSpies }
}

// ---------------------------------------------------------------------------
// The bits of the app that surround a vault
// ---------------------------------------------------------------------------

/**
 * The factory for `vi.mock('../MarkdownEditor', () => markdownEditorModule())`.
 *
 * There is one note view, so there is one stub. A textarea: `onChange` is the same
 * callback the real component calls from CodeMirror's update listener, and
 * CodeMirror needs a layout jsdom does not have. What the real editor does on
 * mount has its own file, `openNote.test.tsx`, which mounts it for real.
 *
 * `getByTestId('editor')` is what a test asks for, and the class and accessible
 * name are the real component's own — so a test that leans on either is still
 * describing the app.
 */
export function markdownEditorModule() {
  return {
    MarkdownEditor: ({
      initialMarkdown,
      onChange,
    }: {
      initialMarkdown: string
      onChange: (markdown: string) => void
    }) => (
      <textarea
        data-testid="editor"
        className="markdown-editor"
        aria-label="Markdown source"
        defaultValue={initialMarkdown}
        onChange={(e) => onChange(e.target.value)}
      />
    ),
  }
}

const stored = new Map<string, string>()

/**
 * Node 26 ships a gated `localStorage` global that shadows jsdom's, so it is
 * replaced outright rather than relied on.
 */
function installLocalStorage(): Map<string, string> {
  stored.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => stored.set(k, v),
      removeItem: (k: string) => stored.delete(k),
      clear: () => stored.clear(),
    },
  })
  return stored
}

/** The folder the app reopens on launch. */
export function rememberVault(vaultPath: string) {
  localStorage.setItem('journeys:vault', vaultPath)
}

/**
 * One call in `beforeEach`: an empty disk carrying the default vault, no recorded
 * calls, and a fresh localStorage.
 */
export function resetFakeVault(options: { root?: string; seed?: boolean } = {}) {
  const { root = '/v', seed = true } = options
  disk.clear()
  for (const spy of Object.values(fsSpies)) spy.mockClear()
  ensureDir(root)
  if (seed) seedDefaultVault(root)
  installLocalStorage()
}

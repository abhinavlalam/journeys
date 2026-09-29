/**
 * A fake disk under the real `vault.ts`.
 *
 * A fixture written next to its assertion gets shaped until the assertion passes,
 * and real bugs lived in that gap. So this mocks `@tauri-apps/plugin-fs` and runs
 * the real `walk`, `isSamePath` and rename guards over an in-memory map.
 *
 * In a test file (the paths are relative to the test, so the factories are functions):
 *
 * import { disk, fsModule, markdownEditorModule, resetFakeVault } from './fakeVault'
 * vi.mock('@tauri-apps/plugin-fs', () => fsModule()) vi.mock('../MarkdownEditor', ()
 * => markdownEditorModule()) beforeEach(() => { resetFakeVault() })
 */
import { render, screen, waitFor } from '@testing-library/react'
import { expect, vi } from 'vitest'
import type { VaultFile } from '../vaultModel'


// ---------------------------------------------------------------------------
// The disk
// ---------------------------------------------------------------------------

/**
 * Case-insensitive and case-preserving, like the volumes the app runs
 * on; several bugs only exist because of that (`exists("Index.md")` true
 * for `index.md`, a case-only rename tripping its own guard). Lookups
 * are by lower-cased path, and listings give the name as first written.
 */
interface FakeDir {
  path: string
  /** Lower-cased name → the name as written. */
  files: Map<string, string>
  dirs: Map<string, string>
}

const dirs = new Map<string, FakeDir>()
const files = new Map<string, { path: string; text: string }>()

/** Paths that are listed but cannot be read. See `disk.corrupt`. */
const corrupted = new Set<string>()
/** Path prefixes where every write and mkdir is refused, with this message. */
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
  // Case-preserving: a write through a differently cased path
  // lands on the existing file without renaming it, as APFS does.
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
  /** The bytes, or undefined, including for a file that exists but cannot be read. */
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
   * Listed by `readDir` and refused by `readTextFile`: a file
   * not yet downloaded, which a plain `Map` mock cannot express.
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
 * A folder after a little use: two top-level notes, a subfolder, a
 * nested folder note, a note with properties, and a note ending in a
 * list. More than any one test needs, so tests trip over real shapes:
 * the list-ending note is the shape that made opening a note rewrite it.
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

/** Lays the default vault under `root`. Add to or overwrite it per test. */
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
  /**
   * Bytes, for a file dragged in from outside. The fake keeps text,
   * so they are decoded; what is tested is where the file landed.
   */
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
 * The factory for `vi.mock('../MarkdownEditor', () => markdownEditorModule())`. A
 * textarea: `onChange` is the callback the real component calls, and CodeMirror
 * needs layout jsdom lacks. What the real editor does on mount is in
 * `openNote.test.tsx`. Tests ask for `getByTestId('editor')`; the class and
 * accessible name are the real component's.
 */
export function markdownEditorModule() {
  return {
    MarkdownEditor: ({
      initialMarkdown,
      onChange,
      shown = true,
      line,
      insertTimeCombo,
    }: {
      initialMarkdown: string
      onChange: (markdown: string) => void
      shown?: boolean
      insertTimeCombo?: string | null
      line?: { onEnter: (text: string) => void; onEscape: () => void; onLeave?: (text: string) => void }
    }) =>
      // A one-line editor keeps the real one's Enter, Escape and leaving.
      line ? (
        <input
          data-testid="line-editor"
          data-time-key={insertTimeCombo ?? ''}
          aria-label="Markdown source"
          defaultValue={initialMarkdown}
          onKeyDown={(e) => (e.key === 'Enter' ? line.onEnter(e.currentTarget.value) : e.key === 'Escape' && line.onEscape())}
          onBlur={(e) => line.onLeave?.(e.currentTarget.value)}
        />
      ) : (
        // A hidden tab keeps its editor mounted; "the editor" is the one shown.
        <textarea
          data-testid={shown ? 'editor' : 'hidden-editor'}
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
 * Node 26 ships a gated `localStorage` global that hides
 * jsdom's, so it is replaced outright.
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
 * One call in `beforeEach`: an empty disk with the default
 * vault, no recorded calls, and a fresh localStorage.
 */
export function resetFakeVault(options: { root?: string; seed?: boolean } = {}) {
  const { root = '/v', seed = true } = options
  disk.clear()
  for (const spy of Object.values(fsSpies)) spy.mockClear()
  ensureDir(root)
  if (seed) seedDefaultVault(root)
  installLocalStorage()
}

/**
 * The app over the fake vault, once its first note is in the tree.
 * `settings`, when given, is written into the vault's settings file first.
 */
export async function openApp(settings?: Record<string, unknown>) {
  if (settings) disk.write('/v/.config/settings.json', JSON.stringify(settings))
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

/** A note in the fake vault, by path. */
export const vaultFile = (path: string): VaultFile => ({
  path,
  absolutePath: `/v/${path}`,
  name: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
})

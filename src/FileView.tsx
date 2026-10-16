import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { BufferSet } from './useBuffers'
import { ViewerHeader, ViewSwitch } from './ViewerHeader'
import { fileUrl } from './assets'
import { fileKind } from './vaultModel'
import type { VaultFile } from './vaultModel'
import { onAndroid } from './platform'
import { useWindowEvent } from './useWindowEvent'
import { sameStamp, vaultFileBytes, vaultFileStamp, type FileStamp } from './vault'
import { loadTwins } from './wordFonts'

/**
 * A file the pane shows rather than edits: a PDF, an image, a Word document, or
 * anything else.
 *
 * The webview reads it. `fileUrl` gives it the file's URL through
 * Tauri's asset protocol, so a 40 MB PDF streams rather than
 * passing through IPC, and the engine's own PDF reader draws it.
 *
 * Nothing here writes: no buffer, no autosave, no editor. That is why this
 * is its own tab kind: a buffer over a PDF is a file the first key corrupts.
 */
/** The editor is two megabytes, fetched the first time a document is edited. */
const WordEditor = lazy(() => import('./WordEditor'))

/** A Word document's two ways of being shown: its pages, read only, or edited in place. */
const WORD_VIEWS = ['pages', 'edit'] as const

export function FileView({
  id,
  file,
  shown,
  buffers,
  say,
  onReveal,
}: {
  id: number
  file: VaultFile
  shown: boolean
  buffers: Pick<BufferSet, 'register' | 'unregister'>
  say: (message: string) => void
  onReveal: (absolute: string) => void
}) {
  const kind = fileKind(file.path)
  const url = fileUrl(file.absolutePath)
  const [wordView, setWordView] = useState<(typeof WORD_VIEWS)[number]>('pages')
  const flushWord = useRef<(() => Promise<void>) | null>(null)
  // The pages are drawn from the file, so what was edited is written first; a save that
  // fails has said so, and the editor stays.
  const showWord = async (next: (typeof WORD_VIEWS)[number]) => {
    if (next === 'pages' && flushWord.current) await flushWord.current().then(() => setWordView(next), () => {})
    else setWordView(next)
  }
  return (
    <>
      {/* No rename: this title is the file's name on disk, extension and all. */}
      <ViewerHeader name={file.name}>
        {/* The phone has the pages alone: the editor's toolbar is wider than its screen. */}
        {kind === 'docx' && !onAndroid && <ViewSwitch views={WORD_VIEWS} view={wordView} onView={(next) => void showWord(next)} />}
      </ViewerHeader>
      {kind === 'image' ? (
        <div className="file-view">
          <img className="file-image" src={url} alt={file.name} />
        </div>
      ) : kind === 'pdf' ? (
        // A frame, so the engine's PDF reader brings its own
        // scrolling, zoom and search.
        <iframe className="file-frame" src={url} title={file.name} />
      ) : kind === 'docx' && wordView === 'edit' ? (
        <Suspense fallback={<p className="viewer-empty">Opening the editor…</p>}>
          <WordEditor id={id} file={file} shown={shown} buffers={buffers} say={say} flushRef={flushWord} />
        </Suspense>
      ) : kind === 'docx' ? (
        <WordPages file={file} shown={shown} />
      ) : (
        <div className="file-view">
          <p className="viewer-empty">
            {file.name} is not a kind of file this app shows.
            {!onAndroid && (
              <button className="file-reveal" onClick={() => onReveal(file.absolutePath)}>
                Reveal in Finder
              </button>
            )}
          </p>
        </div>
      )}
    </>
  )
}

/** Each document's styles carry its own prefix: two open at once shared `.docx p.Normal`. */
let documents = 0

/**
 * What a browser draws apart from Word, put right in the document's own styles. Word's
 * bullet is the Symbol font's private U+F0B7, which the Mac's Symbol has not got, so
 * another font drew whatever it keeps there. And a list item's marker ends in a tab to
 * its text's indent, which a browser draws as a space, so its wrapped lines did not line
 * up with its first: the marker is as wide as the item's hanging indent instead.
 */
function asWord(css: string) {
  const hanging = [...css.matchAll(/(p\.[\w-]+-num-[\d-]+) \{[^}]*text-indent: -([\d.]+pt)/g)]
  return [css.replaceAll('\uF0B7', '•'), ...hanging.map(([, item, width]) => `${item}:before { display: inline-block; min-width: ${width}; text-indent: 0 }`)].join('\n')
}

/**
 * A Word document drawn as its pages (`docx-preview`), read only: the vault's agent
 * edits the file, and the pane draws it again when its stamp has changed, on a return
 * to the window or to its tab. The old pages stay until the new ones are drawn, and a
 * document that cannot be read is said over them and tried again next time.
 */
function WordPages({ file, shown }: { file: VaultFile; shown: boolean }) {
  const pages = useRef<HTMLDivElement>(null)
  const drawn = useRef<FileStamp | null>(null)
  const generation = useRef(0)
  const [prefix] = useState(() => `word-${++documents}`)
  const [failed, setFailed] = useState<string | null>(null)

  async function look() {
    const mine = ++generation.current
    try {
      const stamp = await vaultFileStamp(file)
      if (drawn.current && sameStamp(stamp, drawn.current)) return
      const [{ parseAsync, renderDocument }] = await Promise.all([import('docx-preview'), loadTwins()])
      // Images as data, so nothing is left to revoke when the pages are drawn again.
      // `experimental` measures each tab to its stop once drawn; a tab was one space wide.
      const options = { className: prefix, inWrapper: false, useBase64URL: true, experimental: true }
      const nodes = await renderDocument(await parseAsync(await vaultFileBytes(file), options), options)
      if (mine !== generation.current || !pages.current) return
      for (const node of nodes) if (node.nodeName === 'STYLE') node.textContent = asWord(node.textContent!)
      pages.current.replaceChildren(...nodes)
      drawn.current = stamp
      setFailed(null)
    } catch (err: unknown) {
      if (mine === generation.current) setFailed(`${file.name} could not be read: ${String(err)}`)
    }
  }

  useEffect(() => {
    if (shown) void look()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, file.absolutePath])
  useWindowEvent('focus', () => shown && void look())

  return (
    <>
      {failed && <p className="word-failed">{failed}</p>}
      <div ref={pages} className="word-pages" />
    </>
  )
}

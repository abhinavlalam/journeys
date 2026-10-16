import { useEffect, useRef, useState } from 'react'
import { ViewerHeader } from './ViewerHeader'
import { fileUrl } from './assets'
import { fileKind } from './vaultModel'
import type { VaultFile } from './vaultModel'
import { onAndroid } from './platform'
import { useWindowEvent } from './useWindowEvent'
import { sameStamp, vaultFileBytes, vaultFileStamp, type FileStamp } from './vault'
import carlito from '@fontsource/carlito/files/carlito-latin-400-normal.woff2'
import carlitoBold from '@fontsource/carlito/files/carlito-latin-700-normal.woff2'
import carlitoItalic from '@fontsource/carlito/files/carlito-latin-400-italic.woff2'
import carlitoBoldItalic from '@fontsource/carlito/files/carlito-latin-700-italic.woff2'
import caladea from '@fontsource/caladea/files/caladea-latin-400-normal.woff2'
import caladeaBold from '@fontsource/caladea/files/caladea-latin-700-normal.woff2'
import caladeaItalic from '@fontsource/caladea/files/caladea-latin-400-italic.woff2'
import caladeaBoldItalic from '@fontsource/caladea/files/caladea-latin-700-italic.woff2'

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
export function FileView({ file, shown, onReveal }: { file: VaultFile; shown: boolean; onReveal: (absolute: string) => void }) {
  const kind = fileKind(file.path)
  const url = fileUrl(file.absolutePath)
  return (
    <>
      {/* No rename: this title is the file's name on disk, extension and all. */}
      <ViewerHeader name={file.name} />
      {kind === 'image' ? (
        <div className="file-view">
          <img className="file-image" src={url} alt={file.name} />
        </div>
      ) : kind === 'pdf' ? (
        // A frame, so the engine's PDF reader brings its own
        // scrolling, zoom and search.
        <iframe className="file-frame" src={url} title={file.name} />
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
 * Word's own faces, which a Mac without Office has not got, each by its metric twin,
 * drawn to the same widths, so a line breaks where Word breaks it: in a fallback, a
 * document in Calibri was drawn in Times, and each line spaced out to the margin wrapped.
 */
const TWINS: [string, string[]][] = [
  ['Calibri', [carlito, carlitoBold, carlitoItalic, carlitoBoldItalic]],
  ['Cambria', [caladea, caladeaBold, caladeaItalic, caladeaBoldItalic]],
]
const FACES = [
  { weight: '400', style: 'normal', name: '' },
  { weight: '700', style: 'normal', name: ' Bold' },
  { weight: '400', style: 'italic', name: ' Italic' },
  { weight: '700', style: 'italic', name: ' Bold Italic' },
]
let twins: Promise<unknown> | null = null

/**
 * Loaded before the first document is drawn, since its tabs are measured once, in the
 * face there then. The real one is taken when it is installed. A face that does not load
 * leaves the fallback, and is tried again next time: the document is still drawn.
 */
function loadTwins() {
  twins ??= (async () => {
    const faces = TWINS.flatMap(([family, urls]) =>
      FACES.map(({ name, ...face }, at) => new FontFace(family, `local('${family}${name}'), url(${urls[at]})`, face))
    )
    for (const face of faces) document.fonts.add(face)
    await Promise.all(faces.map((face) => face.load()))
  })().catch(() => {
    twins = null
  })
  return twins
}

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

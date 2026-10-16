import { useEffect, useRef, useState } from 'react'
import { ViewerHeader } from './ViewerHeader'
import { fileUrl } from './assets'
import { fileKind } from './vaultModel'
import type { VaultFile } from './vaultModel'
import { onAndroid } from './platform'
import { useWindowEvent } from './useWindowEvent'
import { sameStamp, vaultFileBytes, vaultFileStamp, type FileStamp } from './vault'

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
      const { parseAsync, renderDocument } = await import('docx-preview')
      // Images as data, so nothing is left to revoke when the pages are drawn again.
      const options = { className: prefix, inWrapper: false, useBase64URL: true }
      const nodes = await renderDocument(await parseAsync(await vaultFileBytes(file), options), options)
      if (mine !== generation.current || !pages.current) return
      // Word's bullet is the Symbol font's private U+F0B7, which the Mac's Symbol has not
      // got, so another font drew whatever it keeps there.
      for (const node of nodes) if (node.nodeName === 'STYLE') node.textContent = node.textContent!.replaceAll('\uF0B7', '•')
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

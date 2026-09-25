import { ViewerHeader } from './ViewerHeader'
import { fileUrl } from './assets'
import { fileKind } from './vaultModel'
import type { VaultFile } from './vaultModel'
import { onAndroid } from './platform'

/**
 * A file the pane **shows** rather than edits: a PDF, an image, or something it
 * has nothing to say about.
 *
 * The webview does the reading. `fileUrl` hands it the file's own URL through
 * Tauri's asset protocol, so a 40 MB PDF is streamed by the thing that knows how
 * to stream it rather than carried through IPC and into a data URI — and a PDF is
 * rendered by the engine's own reader, which is the one every other Mac app shows
 * you too.
 *
 * **Nothing here writes.** There is no buffer, no autosave and no editor: the tab
 * is a view of bytes on disk, and the file is exactly as it was when it is closed.
 * That is also why these are their own tab kind — a note tab owns a buffer, and a
 * buffer over a PDF is a file corrupted by the first keystroke.
 */
export function FileView({ file, onReveal }: { file: VaultFile; onReveal: (absolute: string) => void }) {
  const kind = fileKind(file.path)
  const url = fileUrl(file.absolutePath)
  return (
    <>
      {/* No rename: a name is a note's title here, and this file's name is its
          name on disk, extension and all. */}
      <ViewerHeader name={file.name} />
      {kind === 'image' ? (
        <div className="file-view">
          <img className="file-image" src={url} alt={file.name} />
        </div>
      ) : kind === 'pdf' ? (
        // A frame, because the engine's PDF reader is a document viewer with its
        // own scrolling, zoom and search — and reimplementing those over a canvas
        // is a library and a year of edge cases.
        <iframe className="file-frame" src={url} title={file.name} />
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

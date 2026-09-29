import { ViewerHeader } from './ViewerHeader'
import { fileUrl } from './assets'
import { fileKind } from './vaultModel'
import type { VaultFile } from './vaultModel'
import { onAndroid } from './platform'

/**
 * A file the pane shows rather than edits: a PDF, an image, or anything else.
 *
 * The webview reads it. `fileUrl` gives it the file's URL through
 * Tauri's asset protocol, so a 40 MB PDF streams rather than
 * passing through IPC, and the engine's own PDF reader draws it.
 *
 * Nothing here writes: no buffer, no autosave, no editor. That is why this
 * is its own tab kind: a buffer over a PDF is a file the first key corrupts.
 */
export function FileView({ file, onReveal }: { file: VaultFile; onReveal: (absolute: string) => void }) {
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

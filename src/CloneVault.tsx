import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { appDataDir } from '@tauri-apps/api/path'
import { onAndroid } from './platform'
import { syncClone, syncSetToken } from './sync'

/**
 * The welcome screen's other door: a vault that already lives in a repository —
 * the phone's case, and a new Mac's. The address and the token, then a folder to
 * put it in; the repository's name becomes the folder, inside the one picked. The
 * token goes to the keychain first, keyed by the address, which is where the
 * clone and every round after it look for it.
 *
 * **On Android there is no folder to pick**: an app reaches its own storage and
 * little else, so the vault goes there, and this is the only door, open from the
 * start.
 */
export function CloneVault({ onOpened, onError }: { onOpened: (path: string) => void; onError: (message: string) => void }) {
  const [asking, setAsking] = useState(onAndroid)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [working, setWorking] = useState(false)

  if (!asking) {
    return (
      <button className="welcome-secondary" onClick={() => setAsking(true)}>
        Open from GitHub…
      </button>
    )
  }

  async function download() {
    const address = url.trim()
    const parent = onAndroid ? await appDataDir() : await open({ directory: true, multiple: false, title: 'Where to keep the vault' })
    if (typeof parent !== 'string') return
    const name = address.replace(/\/+$/, '').replace(/\.git$/, '').split('/').pop() || 'Vault'
    setWorking(true)
    try {
      if (token.trim()) await syncSetToken(address, token.trim())
      const into = `${parent}/${name}`
      await syncClone(address, into)
      onOpened(into)
    } catch (err) {
      onError(String(err))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="welcome-clone">
      <input
        className="welcome-input"
        type="text"
        aria-label="Repository address"
        placeholder="https://github.com/you/journal"
        value={url}
        onChange={(e) => setUrl(e.currentTarget.value)}
      />
      <input
        className="welcome-input"
        type="password"
        aria-label="Token"
        placeholder="Token, for a private repository"
        value={token}
        onChange={(e) => setToken(e.currentTarget.value)}
      />
      <button className="primary" disabled={working || !/^https?:\/\//i.test(url.trim())} onClick={() => void download()}>
        {working ? 'Downloading…' : onAndroid ? 'Download' : 'Choose a folder and download'}
      </button>
    </div>
  )
}

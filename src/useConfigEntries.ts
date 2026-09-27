import { useEffect, useState } from 'react'
import { readEntries, withEntry, type Entries } from './configEntries'
import { readConfigFile, writeConfigFile } from './vault'

/** A file of entries in the vault's `.config` (see `configEntries.ts`), read on
 *  opening the vault and on every window focus, and written one entry at a time. */
export function useConfigEntries(vaultPath: string | null, file: string, onError: (message: string) => void) {
  const [entries, setEntries] = useState<Entries>({})

  useEffect(() => {
    // Another vault's entries are not this one's.
    setEntries({})
    if (!vaultPath) return
    let live = true
    const load = () =>
      void readConfigFile(vaultPath, file).then(
        (text) => {
          if (live) setEntries((text === null ? {} : readEntries(text)) ?? {})
        },
        (err: unknown) => {
          if (live) onError(`Could not read ${file}: ${String(err)}`)
        }
      )
    load()
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath, file])

  /** Merges `fields` into `name`'s entry, reading the file as it is now. */
  async function write(name: string, fields: Record<string, unknown>) {
    if (!vaultPath) return
    let text: string | null
    try {
      text = await readConfigFile(vaultPath, file)
    } catch (err) {
      onError(`Could not read ${file}, so it was left alone: ${String(err)}`)
      return
    }
    const next = withEntry(text ?? '', name, fields)
    if (next === null) {
      onError(`${file} could not be read as JSON, so it was left alone.`)
      return
    }
    try {
      await writeConfigFile(vaultPath, file, next)
    } catch (err) {
      onError(String(err))
      return
    }
    setEntries((current) => ({ ...current, [name]: { ...current[name], ...fields } }))
  }

  return { entries, write }
}

import { useEffect, useRef, useState } from 'react'
import { readEntries, withEntry, type Entries } from './configEntries'
import { readConfigFile, writeConfigFile } from './vault'

/**
 * A file of entries in `.config` (see `configEntries.ts`), read on vault
 * open and on every window focus, and written one entry at a time.
 */
export function useConfigEntries(vaultPath: string | null, file: string, onError: (message: string) => void) {
  const [entries, setEntries] = useState<Entries>({})
  /** The text last found not to be JSON, so it is said once and not on every focus. */
  const broken = useRef<string | null>(null)
  /**
   * The text last read: the same text keeps the same entries, or every return to the
   * window built the graph and the property lists again from types that had not changed.
   */
  const last = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    // Another vault's entries are not this one's.
    setEntries({})
    last.current = undefined
    if (!vaultPath) return
    let live = true
    const load = () =>
      void readConfigFile(vaultPath, file).then(
        (text) => {
          if (!live || text === last.current) return
          last.current = text
          const read = text === null ? {} : readEntries(text)
          // Said, not shown as no entries at all.
          if (!read && text !== broken.current) onError(`${file} could not be read as JSON, so it was left alone.`)
          broken.current = read ? null : text
          setEntries(read ?? {})
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
      onError(`Could not write ${file}: ${String(err)}`)
      return
    }
    // What is on disk now, so a pull that puts the old text back is read.
    last.current = next
    setEntries((current) => ({ ...current, [name]: { ...current[name], ...fields } }))
  }

  return { entries, write }
}

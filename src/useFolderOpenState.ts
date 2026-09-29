import { useCallback, useEffect, useState } from 'react'

/**
 * Which folders are open, by path, saved per vault. Shut by default.
 *
 * This set is the only answer: a folder is open because it is in here. It was once
 * three sources (this set, a set of folders shut by hand, and a flag for the selected
 * note's branch), so clicking a second folder could shut the first. Now revealing a
 * note writes its folders into the set (`reveal`), and they stay open until shut.
 */
const OPEN_KEY = 'journeys:folders-open'

/**
 * What is stored, or `seed` when nothing is: a new vault's
 * sections start open, and folders start shut.
 */
function loadOpen(vaultPath: string, seed: readonly string[]): Set<string> {
  try {
    const raw = localStorage.getItem(`${OPEN_KEY}:${vaultPath}`)
    return new Set(raw ? (JSON.parse(raw) as string[]) : seed)
  } catch {
    return new Set(seed)
  }
}

function saveOpen(vaultPath: string, open: Set<string>) {
  try {
    localStorage.setItem(`${OPEN_KEY}:${vaultPath}`, JSON.stringify([...open]))
  } catch {
    // Losing the tree's open state is not worth an error.
  }
}

export function useFolderOpenState(vaultPath: string | null, seed: readonly string[] = []) {
  const [open, setOpen] = useState<Set<string>>(() =>
    vaultPath ? loadOpen(vaultPath, seed) : new Set()
  )

  useEffect(() => {
    setOpen(vaultPath ? loadOpen(vaultPath, seed) : new Set())
    // `seed` is a module constant at the one call site that passes one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath])

  /** Every change goes through here, so the store and the state agree. */
  const write = useCallback(
    (change: (current: Set<string>) => Set<string>) => {
      setOpen((current) => {
        const next = change(new Set(current))
        if (vaultPath) saveOpen(vaultPath, next)
        return next
      })
    },
    [vaultPath]
  )

  const toggle = useCallback(
    (path: string, isOpen: boolean) => {
      write((next) => {
        if (isOpen) next.delete(path)
        else next.add(path)
        return next
      })
    },
    [write]
  )

  /**
   * Opens every folder above `path`, so its row is on screen. Not `path` itself:
   * a folder note's path is its folder, and opening that note already toggles it.
   */
  const reveal = useCallback(
    (path: string) => {
      const parts = path.split('/').filter(Boolean)
      parts.pop()
      if (parts.length === 0) return
      write((next) => {
        for (let depth = 1; depth <= parts.length; depth++) {
          next.add(parts.slice(0, depth).join('/'))
        }
        return next
      })
    },
    [write]
  )

  /**
   * Opens or shuts every one of `paths` and touches nothing else. Replacing the whole
   * set made Expand all in Notes shut the Actions groups, and the other way round.
   */
  const setAll = useCallback(
    (paths: string[], isOpen: boolean) => {
      write((current) => {
        for (const path of paths) if (isOpen) current.add(path)
        else current.delete(path)
        return current
      })
    },
    [write]
  )

  return { open, toggle, reveal, setAll }
}

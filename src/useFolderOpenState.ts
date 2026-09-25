import { useCallback, useEffect, useState } from 'react'

/**
 * Which folders are open, keyed by path and persisted per vault.
 *
 * Every folder used to default to expanded and reset on restart: 1500 notes in 30
 * folders mounted 1,621 buttons at once, and the tree you left was never the tree
 * you came back to. Collapsed is the default now, and **this set is the whole
 * truth**: a folder is open because it is in here, and for no other reason.
 *
 * It used to be three sources — this set, a `closed` set for folders shut by hand,
 * and a per-row `revealed` flag for the branch holding the selected note, with a
 * collapse counter to knock that flag down. A folder could therefore be open
 * *because of the selection*, and clicking another folder moved the selection and
 * shut it: expand one, click a second, and the first collapsed. Revealing now
 * **writes** — `reveal` opens every folder above a note — so what is open stays
 * open until something shuts it, and there is one answer to "is this open".
 */
const OPEN_KEY = 'journeys:folders-open'

/** What is stored, or `seed` when nothing is: the sections of the left pane start
 *  open on a vault this app has not seen, and a folder starts shut. */
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
    // Losing the shape of the tree is not worth an error.
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

  /** Every change goes through here, so the store and the state cannot disagree. */
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
   * Opens every folder **above** `path`, so a row that far down is on screen.
   *
   * Above, and not `path` itself: a folder note's own path is its folder, and
   * opening that note is the click that toggles the folder — revealing it here as
   * well would fight the toggle inside one gesture.
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
   * Every one of `paths` open, or every one shut — **and nothing else touched.**
   * It replaced the whole set, which held while one section's folders were all
   * there was in it; with the left pane's sections and the Actions groups in the
   * same set, "expand all notes" shut the Actions section and its groups, and
   * "expand all actions" shut Notes. `paths` is the section's own list, because
   * opening them all means naming them.
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

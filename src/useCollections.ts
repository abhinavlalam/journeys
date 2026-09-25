import { useCallback, useEffect, useMemo, useState } from 'react'
import { COLLECTIONS_FILE, readCollections, withCollection } from './actions'
import type { CollectionOption } from './editorComplete'
import { readConfigFile, writeConfigFile } from './vault'

/**
 * **What each collection declares**, and the one place that writes it.
 *
 * One line per collection saying how its lines are written — `--expense
 * amount::<<>> at merchant:: [[<<>>]]` — and three parts of the app want it: the
 * pane lists a declared collection even before a note carries one, the
 * collection's view shows the line and edits it, and the editor's `--` popup
 * completes to it. They sit in three different corners of the tree, so the read
 * belongs to none of them; it belongs here, and `App` holds it.
 *
 * **One JSON file, not a folder of markdown.** It was a file per collection whose
 * first `--` line was the declaration, which asks anything reading the vault to
 * glob a folder and parse markdown for a fact that is plainly data — see
 * `COLLECTIONS_FILE`. The file name comes from `actions.ts`, which owns what a
 * collection is; it is not passed in, because a constant in a pure module is not
 * the layering mistake `settings.ts` made by importing `SettingsPanel.tsx`.
 */
export function useCollections({
  vaultPath,
  revision,
  inUse,
  onWritten,
  onError,
}: {
  vaultPath: string | null
  /** Bumped when the app itself writes one, so the read comes straight back
   *  rather than waiting for the next window focus. */
  revision: number
  /** The `--keyword`s the vault's notes carry, off the one read of it. */
  inUse: readonly { name: string; notes: number }[]
  onWritten: () => void
  onError: (message: string) => void
}) {
  const [structures, setStructures] = useState<Record<string, string>>({})

  const read = useCallback(async () => {
    if (!vaultPath) return {}
    const text = await readConfigFile(vaultPath, COLLECTIONS_FILE)
    // No file yet is the ordinary case, and not an error: a vault has no
    // collections until someone declares one.
    if (text === null) return {}
    return readCollections(text) ?? {}
  }, [vaultPath])

  useEffect(() => {
    // A read that lands after the vault changed is the wrong answer, and this is
    // the effect that knows — the guard `useVaultTexts` keeps a generation for.
    let live = true
    const load = () =>
      void read().then(
        (found) => {
          if (live) setStructures(found)
        },
        // There and unreadable: said, and the structures last read are kept.
        (err: unknown) => {
          if (live) onError(`Could not read ${COLLECTIONS_FILE}: ${String(err)}`)
        }
      )
    load()
    // On focus for the same reason every other read is: a structure edited in
    // another editor should turn up. `revision` is for the app's own writes, where
    // waiting for a focus would show the file as it was.
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
  }, [read, revision])

  const declarations = useMemo<CollectionOption[]>(
    () =>
      Object.entries(structures).map(([name, structure]) => ({
        name,
        // A collection with no shape yet is declared but not structured, and the
        // page asks for one rather than showing an empty line.
        declaration: structure || null,
      })),
    [structures]
  )

  /**
   * Every collection the `--` popup can offer: the ones the notes carry and the
   * ones that have declared a structure, by lowercased name so a name spelled two
   * ways is one entry. The declared spelling wins, because it is the one someone
   * wrote down on purpose.
   */
  const completable = useMemo<CollectionOption[]>(() => {
    const found = new Map<string, CollectionOption>()
    for (const one of inUse) found.set(one.name.toLowerCase(), { name: one.name, declaration: null })
    for (const one of declarations) found.set(one.name.toLowerCase(), one)
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [inUse, declarations])

  return {
    /** The names the file holds, for the pane's rows. */
    declared: useMemo(() => Object.keys(structures), [structures]),
    completable,

    declarationOf: (keyword: string) =>
      declarations.find((one) => one.name.toLowerCase() === keyword.toLowerCase())?.declaration ??
      null,

    /**
     * Writes a collection's structure, keeping every other entry.
     *
     * **A file it cannot parse is a file it will not overwrite.** Someone may edit
     * this by hand, and a stray comma is not a reason to throw their structures
     * away — so the write is refused and said out loud, which is the bargain
     * `.config/settings.json` already makes.
     *
     * `''` is a structure too: a collection that exists and has not been given a
     * shape, which is what the `+` makes.
     */
    /**
     * The structure a name has **on disk, read now**, rather than from what the pane
     * last read. The calendar syncs as the vault opens, before that read has landed,
     * and taking "not read yet" for "not declared" would write the default over the
     * owner's own structure.
     */
    declarationNow: async (name: string): Promise<string | null> => {
      const found = await read()
      const key = Object.keys(found).find((one) => one.toLowerCase() === name.toLowerCase())
      return key ? found[key] : null
    },
    declare: async (name: string, structure: string) => {
      if (!vaultPath) return
      let existing: string | null
      try {
        existing = await readConfigFile(vaultPath, COLLECTIONS_FILE)
      } catch (err) {
        // Taken for empty, it was written over with this one declaration.
        onError(`Could not read ${COLLECTIONS_FILE}, so it was left alone: ${String(err)}`)
        return
      }
      const next = withCollection(existing ?? '', name, structure)
      if (next === null) {
        onError(`${COLLECTIONS_FILE} could not be read as JSON, so it was left alone.`)
        return
      }
      await writeConfigFile(vaultPath, COLLECTIONS_FILE, next).catch((err: unknown) =>
        onError(String(err))
      )
      // **The app knows what it just wrote**, so the pane's rows do not wait for a
      // read of the file to find out. Declaring one used to go write → bump →
      // re-read → parse before the name appeared beside the others, which is two
      // round trips of latency for an answer already in hand. The re-read still
      // happens; this is only what is shown until it lands.
      setStructures((current) => ({ ...current, [name]: structure }))
      onWritten()
    },
  }
}

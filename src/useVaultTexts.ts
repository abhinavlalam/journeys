import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { readVaultFile } from './vault'
import { isEncrypted, isNote, type VaultFile, type VaultFolder } from './vaultModel'
import { buildNoteIndex, collectFiles, collectNotes } from './links'
import { buildBacklinkIndex } from './links'
import type { BacklinkIndex } from './links'
import { buildNoteGraph, type NoteGraph, type NoteText } from './graph'
import { APP_PROPERTIES, noteProperties, readProperty, typeOf } from './properties'
import type { Entries } from './configEntries'
import { collectTagLines, tagNames, type CollectedLine } from './tags'
import { timelineDays, type TimelineDay } from './timeline'

/** One note and the entries it holds: what a tag's page draws. */
export interface CollectedNote {
  note: VaultFile
  lines: CollectedLine[]
}

/**
 * The open note's text as the editor has it, with its path, so it is never
 * applied to another note. `App` fills it in; nothing here writes it.
 */
interface LiveText {
  path: string
  text: string
}

interface VaultTexts {
  /** Every note in the tree, for the `[[` picker. */
  notes: ReturnType<typeof collectNotes>
  /**
   * The same notes in lookup form: resolves links, and turns a
   * clicked graph node back into its note.
   */
  noteIndex: ReturnType<typeof buildNoteIndex>
  /** `icon::` per note path. */
  icons: Record<string, string>
  /**
   * Every property name the notes use, and how many use it. From
   * the same read as everything else, so a property typed into a
   * note appears in the Actions pane on the next read.
   */
  properties: { name: string; notes: number }[]
  /** Everything a property says across the notes: its page. */
  propertyValues: (name: string) => { note: VaultFile; value: string }[]
  /**
   * The lines carrying a tag, grouped by note, or null while the vault is being
   * read. From `corpus`, so a line typed seconds ago is included. A function of
   * the tag, because two panes can show two tags. Memoised per corpus.
   */
  collectTag: (tag: string) => CollectedNote[] | null
  /** The daily notes by time, oldest first (see `timeline.ts`). */
  timeline: TimelineDay[] | null
  tags: { name: string; notes: number }[]
  graph: NoteGraph | null
  backlinks: BacklinkIndex | null
  /**
   * A read is in progress. The graph says "reading" for this,
   * and "no links yet" for a vault with none.
   */
  reading: boolean
  /** Every note's text, for search. */
  texts: NoteText[] | null
  /**
   * Makes the change a write is about to make on disk to the copy everything
   * here is built from. For an icon: a property write doesn't change the
   * tree, so nothing reads it back and the row wouldn't redraw until the
   * next focus. Uses the same function as the write, so they match.
   */
  patch: (paths: ReadonlySet<string>, change: (text: string) => string) => void
}

/**
 * One read of the vault, and everything built from it: the notes, their
 * index, the icons, the graph, the backlinks, and whether a read is
 * running. A new cross-note fact goes here as a memo, not as a second read.
 *
 * The read runs when the vault changes and on window focus. Opening a
 * note reads nothing: the only note the app can have changed since is the
 * one being typed into, and `liveText` already has it (see `corpus`).
 */
export function useVaultTexts({
  root,
  graphHides,
  dailyFolder,
  vaultPath,
  openPath,
  viewOpen,
  liveVersion,
  liveText,
  types,
  onError,
}: {
  root: VaultFolder | null
  /** Folders the graph leaves out: `settings.graphHides` (see `buildNoteGraph`). */
  graphHides: readonly string[]
  /** Where the daily notes live (`settings.dailyFolder`), for the timeline. */
  dailyFolder: string
  vaultPath: string | null
  /**
   * The open note: switching notes is when `liveText` is dropped
   * for the disk's text (see `corpus`).
   */
  openPath: string | null
  /**
   * A view built from the notes is open: the graph, a tag's or property's page,
   * the calendar, or the timeline. Any can open on a line typed seconds ago,
   * which is neither on disk nor in the buffer, so this takes `liveText` again.
   */
  viewOpen: boolean
  /**
   * Bumped by typing while such a view is on screen beside the note, so it follows
   * the typing instead of waiting for the next focus. `App` bumps it, throttled.
   */
  liveVersion: number
  liveText: { current: LiveText | null }
  /** Each property's type: where a block property's value ends. */
  types: Entries
  onError: (message: string) => void
}): VaultTexts {
  const [texts, setTexts] = useState<NoteText[] | null>(null)
  const [reading, setReading] = useState(false)

  /**
   * Which read is current. Each note is one await, and changing vaults
   * or a focus mid-read makes everything still in flight stale.
   */
  const generation = useRef(0)

  /**
   * A new vault clears the old one's notes, and moves the
   * generation so a read in flight can't land. Declared before
   * the read below, so that read's generation is newer.
   */
  useEffect(() => {
    generation.current += 1
    setTexts(null)
  }, [vaultPath])

  useEffect(() => {
    if (!root) {
      generation.current += 1
      setTexts(null)
      setReading(false)
      return
    }
    // Every note, not only folder notes: a plain note can have an icon too. Not
    // a locked note, unlocked or not: its content is its owner's alone, so
    // search, tags, properties, backlinks and the graph are built without it.
    const all = collectNotes(root).filter((note) => !isEncrypted(note.path))
    async function read() {
      const mine = ++generation.current
      setReading(true)
      try {
        const rows = await Promise.all(
          all.map(async (note) => ({
            note,
            // A folder note is written lazily, so not being on
            // disk is normal here: it is a note with no text yet.
            text: await readVaultFile(note).catch(() => ''),
          }))
        )
        if (generation.current === mine) setTexts(rows)
      } catch (err: unknown) {
        onError(String(err))
      } finally {
        if (generation.current === mine) setReading(false)
      }
    }
    void read()
    window.addEventListener('focus', read)
    return () => {
      generation.current += 1
      window.removeEventListener('focus', read)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  const notes = useMemo(() => (root ? collectNotes(root) : []), [root])
  const noteIndex = useMemo(() => buildNoteIndex(root ? collectFiles(root) : []), [root])

  /**
   * The notes among the texts, which every cross-note answer is built from.
   * The texts include every text file, for search; a `.conf` or `.yaml`
   * isn't a note, and treating it as one turned its `#comment` into a tag.
   */
  const noteTexts = useMemo(() => texts?.filter(({ note }) => isNote(note.path)) ?? null, [texts])

  /**
   * `icon::`, read from each note. Kept in the note, not in app
   * storage, so it travels with the vault and shows in any
   * editor. Derived from `texts`, so it costs no extra read.
   */
  const icons = useMemo(() => {
    const found: Record<string, string> = {}
    for (const { note, text } of noteTexts ?? []) {
      const icon = readProperty(text, APP_PROPERTIES.icon)
      if (icon) found[note.path] = icon
    }
    return found
  }, [noteTexts])

  /**
   * The names in use, counted: a property a note carries (on its page or a
   * line), or a `#tag`. Names are compared case-insensitively, and the first
   * spelling met is shown. A note using a name twice counts once. `read` comes
   * from the module that owns the syntax: `noteProperties` or `tagNames`.
   */
  const countNames = (read: (text: string) => string[]) => {
    const found = new Map<string, { name: string; notes: number }>()
    for (const { text } of noteTexts ?? []) {
      for (const name of new Set(read(text))) {
        const at = name.toLowerCase()
        const seen = found.get(at)
        if (seen) seen.notes += 1
        else found.set(at, { name, notes: 1 })
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  const typed = useCallback((name: string) => typeOf(types, name), [types])
  const properties = useMemo(
    () => countNames((text) => noteProperties(text, typed).map((one) => one.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [noteTexts, typed]
  )
  /** The `#tag`s the notes carry. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tags = useMemo(() => countNames(tagNames), [noteTexts])

  /**
   * Everything a property says, on a note's page and on its
   * lines, one row each: the property's page. Case-insensitive
   * on the name; a name with nothing after it has no value.
   */
  const propertyValues = useCallback(
    (name: string): { note: VaultFile; value: string }[] => {
      const want = name.toLowerCase()
      const found: { note: VaultFile; value: string }[] = []
      for (const { note, text } of noteTexts ?? []) {
        for (const one of noteProperties(text, typed)) {
          if (one.value && one.name.toLowerCase() === want) found.push({ note, value: one.value })
        }
      }
      return found.sort((a, b) => a.note.path.localeCompare(b.note.path))
    },
    [noteTexts, typed]
  )

  /**
   * What every cross-note answer is built from: the last read, with the open note's
   * text as typed. Rebuilding from all the text is cheap and handles removal too: a
   * link deleted a moment ago leaves the graph, even though the disk still has it.
   */
  const corpus = useMemo(() => {
    if (!noteTexts) return null
    const live = liveText.current
    if (!live) return noteTexts
    return noteTexts.map((row) =>
      row.note.path === live.path ? { note: row.note, text: live.text } : row
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteTexts, openPath, viewOpen, liveVersion])

  const graph = useMemo(
    () => (corpus ? buildNoteGraph(corpus, noteIndex, graphHides, { typeOf: typed, dailyFolder }) : null),
    [corpus, noteIndex, graphHides, typed, dailyFolder]
  )
  /** Who links here. Same corpus as the graph, so the two always agree. */
  const backlinks = useMemo(
    () => (corpus ? buildBacklinkIndex(corpus, noteIndex) : null),
    [corpus, noteIndex]
  )

  const collectTag = useMemo(() => tagLines(corpus), [corpus])
  const timeline = useMemo(() => (corpus ? timelineDays(corpus, dailyFolder) : null), [corpus, dailyFolder])

  const patch = (paths: ReadonlySet<string>, change: (text: string) => string) =>
    setTexts(
      (current) =>
        current?.map((row) =>
          paths.has(row.note.path) ? { note: row.note, text: change(row.text) } : row
        ) ?? null
    )

  return {
    notes,
    noteIndex,
    icons,
    properties,
    propertyValues,
    collectTag,
    timeline,
    tags,
    graph,
    backlinks,
    reading,
    texts,
    patch,
  }
}

/**
 * See `collectTag`. Only the page asked for, not every tag on
 * each read. A note with no matching line is left out.
 */
function tagLines(corpus: readonly { note: VaultFile; text: string }[] | null): (tag: string) => CollectedNote[] | null {
  const cache = new Map<string, CollectedNote[]>()
  return (name: string) => {
    if (!corpus) return null
    const key = name.toLowerCase()
    const hit = cache.get(key)
    if (hit) return hit
    const found: CollectedNote[] = []
    for (const { note, text } of corpus) {
      const lines = collectTagLines(text, name)
      if (lines.length > 0) found.push({ note, lines })
    }
    cache.set(key, found)
    return found
  }
}

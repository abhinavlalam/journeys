import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { readVaultFile } from './vault'
import { isEncrypted, isNote, type VaultFile, type VaultFolder } from './vaultModel'
import { buildNoteIndex, collectNotes } from './links'
import { buildBacklinkIndex } from './links'
import type { BacklinkIndex } from './links'
import { buildNoteGraph, type NoteGraph, type NoteText } from './graph'
import { APP_PROPERTIES, noteProperties, readProperty, typeOf } from './properties'
import type { Entries } from './configEntries'
import { collectTagLines, tagNames, type CollectedLine } from './tags'
import { timelineDays, type TimelineDay } from './timeline'

/** One note and the entries it holds, which is what a tag's page draws. */
export interface CollectedNote {
  note: VaultFile
  lines: CollectedLine[]
}

/** The open note's text as the *editor* has it, with the path it belongs to so a
 *  stale tap cannot be applied to the wrong note. `App` fills this in on the way
 *  past; nothing here writes it. */
interface LiveText {
  path: string
  text: string
}

interface VaultTexts {
  /** Every note in the tree, for the `[[` picker. */
  notes: ReturnType<typeof collectNotes>
  /** Those notes in lookup form: what resolves a link, and what turns a clicked
   *  graph node back into the note it stands for. */
  noteIndex: ReturnType<typeof buildNoteIndex>
  /** `icon:` per note path. */
  icons: Record<string, string>
  /**
   * Every property name the vault's notes carry, and how many carry it.
   *
   * Derived from the same read as everything else, so a property typed into a
   * note's block turns up in the Actions pane on the next pass over the vault —
   * which is what makes that list *what is in use* rather than a list someone has
   * to keep in step by hand.
   */
  properties: { name: string; notes: number }[]
  /** What a property says in every note that carries it — its page. */
  propertyValues: (name: string) => { note: VaultFile; value: string }[]
  /**
   * The lines carrying a tag, grouped by the note each is in, or null while the
   * vault is being read. Off `corpus`, so a line typed seconds ago is in it.
   *
   * **A function of the tag, not the one open page**: two panes can show two tags,
   * and the one not focused went blank when this answered only for the focused
   * pane's. Memoised per corpus, so the vault is walked once per tag per read.
   */
  collectTag: (tag: string) => CollectedNote[] | null
  /** The daily notes as each day happened, oldest first — see `timeline.ts`. */
  timeline: TimelineDay[] | null
  tags: { name: string; notes: number }[]
  graph: NoteGraph | null
  backlinks: BacklinkIndex | null
  /** A read is in flight. The graph pane says "reading" for this and "no links
   *  yet" for a vault that has none. */
  reading: boolean
  /** Every note's text, for anything that wants the corpus itself — search. */
  texts: NoteText[] | null
  /**
   * The same change a write is about to make on disk, made to the copy everything
   * here is derived from.
   *
   * For an icon: writing a property does not change the *tree*, so no re-read
   * follows to correct a guess — and without one the row would not redraw until
   * the next window focus. Made with the very function the write uses, so the
   * guess cannot drift from what lands.
   */
  patch: (paths: ReadonlySet<string>, change: (text: string) => string) => void
}

/**
 * **One read of the vault, and everything derived from it.**
 *
 * `App` used to hold all of this. It is one subject: the read, and the six answers
 * that are memos over it — the notes, their index, the icons, the graph, what links
 * here, and whether a read is in flight. When another cross-note fact is wanted,
 * the obvious thing to write is a second pass over the vault; add it to this file
 * instead, as a memo, because the bytes are already here.
 *
 * The read runs when the vault changes and again on **window focus**, the moment
 * `useNoteBuffer` re-reads the open note, so the rest of the vault catches up with
 * it. Opening a note reads nothing: the only note whose bytes this app can have
 * changed since the last pass is the one it was typing into, and `liveText` holds
 * that text already — see `corpus` below.
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
  /** Folders the graph leaves out — `settings.graphHides`, see `buildNoteGraph`. */
  graphHides: readonly string[]
  /** Where the daily notes live — `settings.dailyFolder` — for the timeline. */
  dailyFolder: string
  vaultPath: string | null
  /** The open note, because switching notes is when `liveText` becomes the disk's
   *  business again — see `corpus`. */
  openPath: string | null
  /**
   * A view derived from the corpus is open — the graph, or a tag's page.
   *
   * Either can be opened on a line typed seconds ago, which is on neither the disk
   * nor the buffer; this is what re-takes `liveText` at that moment. It was
   * `graphOpen`, when the graph was the only such view.
   */
  viewOpen: boolean
  /**
   * **Bumped by a keystroke while a view is on screen beside the note.** With one
   * pane, opening the view was the moment to re-take the live text; with two, the
   * tag's page can sit beside the note being typed into, and nothing changed
   * to re-take it — the page held the disk's text until the window was refocused.
   * `App` bumps this, throttled, only while such a view is showing.
   */
  liveVersion: number
  liveText: { current: LiveText | null }
  /** Each property's type, which is where a block property's value ends. */
  types: Entries
  onError: (message: string) => void
}): VaultTexts {
  const [texts, setTexts] = useState<NoteText[] | null>(null)
  const [reading, setReading] = useState(false)

  /**
   * Which read is current. Every note is one await, and picking another vault or a
   * focus landing mid-read makes every byte still in flight the wrong answer.
   */
  const generation = useRef(0)

  /** Another vault is another set of notes. Dropped rather than left showing the
      last one's, and the generation moves so a read in flight cannot land. Declared
      before the read below so that read's generation is the newer one. */
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
    // Every note, not only the folder notes: a plain page carries an icon too. **Not
    // an encrypted one, unlocked or not**: what it says is the owner's alone, so
    // search, the tags, the properties, the backlinks and the graph
    // are all built without it — and the live text never joins, having no row here.
    const all = collectNotes(root).filter((note) => !isEncrypted(note.path))
    async function read() {
      const mine = ++generation.current
      setReading(true)
      try {
        const rows = await Promise.all(
          all.map(async (note) => ({
            note,
            // A folder note is written lazily (CLAUDE.md), so "not on disk" is the
            // ordinary case here and not an error: it is a note with no text yet.
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
  const noteIndex = useMemo(() => buildNoteIndex(notes), [notes])

  /**
   * The one property this app reads out of every note: `icon:`.
   *
   * Read from the note rather than kept in the app's own storage, because it lives
   * in the page as plain text: so it travels with the vault and shows up in any
   * editor. Derived from `texts`, which is what makes it free — the bytes are
   * already here. It was a second full read of the vault of its own.
   */
  /**
   * **The notes among the texts**: what every cross-note answer is made of. The
   * texts are every text file, for search; a `.conf` or a `.yaml` is not a note, and
   * a `#comment` in one was a tag, its `key: value` lines were properties, and its
   * links were backlinks and edges. A note's link *to* a text file still resolves
   * and still draws it.
   */
  const noteTexts = useMemo(() => texts?.filter(({ note }) => isNote(note.path)) ?? null, [texts])

  const icons = useMemo(() => {
    const found: Record<string, string> = {}
    for (const { note, text } of noteTexts ?? []) {
      const icon = readProperty(text, APP_PROPERTIES.icon)
      if (icon) found[note.path] = icon
    }
    return found
  }, [noteTexts])

  /**
   * The names in use, counted — a property a note carries, on its page or on a
   * line, and a `#tag` a line carries alike.
   *
   * Case-insensitively the same name is the same thing — `Status` and `status` are
   * one key to anything reading a block — and the first spelling met is the one
   * shown, because a list that renames what someone typed is a list they do not
   * recognise. A note naming the same thing twice counts once.
   *
   * One function, because it is one question asked of two syntaxes: `read` is the
   * only difference, and it comes from the module that owns that syntax —
   * `noteProperties` from `properties.ts`, `tagNames` from `tags.ts`.
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
   * **What a property says, everywhere it is said** — on a note's page and on its
   * lines, one row each — the property's page, the way `collectTag` is a tag's.
   * Off the same one read, case-insensitive on the name for the
   * reason `countNames` is, and a name with nothing after it carries no value.
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
   * What every cross-note answer is computed from: the last read, with the open
   * note's text as the *editor* has it.
   *
   * Substituting the text and rebuilding beats patching the built structures
   * afterwards, and the *removing* half is why: a link deleted a moment ago has to
   * leave the graph, not linger because the disk still remembers it. Rebuilding
   * from the whole vault's text is microseconds — the function that patched one
   * note's edges into a built graph was twenty lines and its own set of invariants.
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
  /** Who points here. Same corpus, so the two answers can never disagree. */
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
 * See `collectTag`. **Only the page asked for**: gathering every tag on each read
 * would be a pass over the vault per tag to answer a question nobody has asked. A
 * note with no line is left out rather than listed empty.
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

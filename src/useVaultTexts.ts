import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { readVaultFile } from './vault'
import { isEncrypted, type VaultFile, type VaultFolder } from './vaultModel'
import { buildNoteIndex, collectNotes } from './links'
import { buildBacklinkIndex } from './links'
import type { BacklinkIndex } from './links'
import { buildNoteGraph, type NoteGraph, type NoteText } from './graph'
import { propertyKeys, readProperty } from './frontmatter'
import { collectTagLines, tagNames } from './tags'
import { actionKeywords, collectLines, type CollectedLine } from './actions'

/** One note and the entries it holds, which is what a collection's view draws. */
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
   * Every `--keyword` the vault's lines carry, and how many notes carry it.
   *
   * The same derivation as `properties`, over the same one read: a collection is
   * written as `--name` at the start of a line, so the Collections group lists what
   * the notes are using and not only what has been defined.
   */
  collections: { name: string; notes: number }[]
  /**
   * What the open collection collects, grouped by the note it is written in, or
   * null when no collection is open.
   *
   * **A collection is a view, not a file.** It is derived here for the reason
   * everything else is: the bytes are already in hand, and a second pass over the
   * vault to answer one more cross-note question is the thing this file exists to
   * stop. Off `corpus`, so a `--expense` line typed seconds ago is in it.
   *
   * **A function of the keyword, not the one open collection**: two panes can show
   * two collections, and the one in the pane that is not focused went blank when
   * this answered only for the focused pane's. Memoised per corpus, so a page asks
   * as often as it renders and the vault is walked once per keyword per read.
   */
  collect: (keyword: string) => CollectedNote[] | null
  collectTag: (tag: string) => CollectedNote[] | null
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
  vaultPath,
  openPath,
  viewOpen,
  liveVersion,
  liveText,
  onError,
}: {
  root: VaultFolder | null
  /** Folders the graph leaves out — `settings.graphHides`, see `buildNoteGraph`. */
  graphHides: readonly string[]
  vaultPath: string | null
  /** The open note, because switching notes is when `liveText` becomes the disk's
   *  business again — see `corpus`. */
  openPath: string | null
  /**
   * A view derived from the corpus is open — the graph, or a collection.
   *
   * Either can be opened on a line typed seconds ago, which is on neither the disk
   * nor the buffer; this is what re-takes `liveText` at that moment. It was
   * `graphOpen`, when the graph was the only such view.
   */
  viewOpen: boolean
  /**
   * **Bumped by a keystroke while a view is on screen beside the note.** With one
   * pane, opening the view was the moment to re-take the live text; with two, the
   * collection page can sit beside the note being typed into, and nothing changed
   * to re-take it — the page held the disk's text until the window was refocused.
   * `App` bumps this, throttled, only while such a view is showing.
   */
  liveVersion: number
  liveText: { current: LiveText | null }
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
    // search, the collections, the tags, the properties, the backlinks and the graph
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
  const icons = useMemo(() => {
    const found: Record<string, string> = {}
    for (const { note, text } of texts ?? []) {
      const icon = readProperty(text, 'icon')
      if (icon) found[note.path] = icon
    }
    return found
  }, [texts])

  /**
   * The names in use, counted — a property a block declares and a `--keyword` a
   * line carries alike.
   *
   * Case-insensitively the same name is the same thing — `Status` and `status` are
   * one key to anything reading a block — and the first spelling met is the one
   * shown, because a list that renames what someone typed is a list they do not
   * recognise. A note naming the same thing twice counts once.
   *
   * One function, because it is one question asked of two syntaxes: `read` is the
   * only difference, and it comes from the module that owns that syntax —
   * `propertyKeys` from `frontmatter.ts`, `actionKeywords` from `actions.ts`.
   */
  const countNames = (read: (text: string) => string[]) => {
    const found = new Map<string, { name: string; notes: number }>()
    for (const { text } of texts ?? []) {
      for (const name of new Set(read(text))) {
        const at = name.toLowerCase()
        const seen = found.get(at)
        if (seen) seen.notes += 1
        else found.set(at, { name, notes: 1 })
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const properties = useMemo(() => countNames(propertyKeys), [texts])
  /** The `--keyword`s the notes carry: a collection is written as a line, so this
   *  is what puts the ones in play in the pane beside the ones with a file. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const collections = useMemo(() => countNames(actionKeywords), [texts])
  /** The `#tag`s the notes carry. The third syntax `countNames` is asked of, and
   *  the reading comes from the module that owns it, as the other two do. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tags = useMemo(() => countNames(tagNames), [texts])

  /**
   * **What a property says in every note that carries it** — the property's page,
   * the way `collected` is a collection's. Off the same one read, case-insensitive
   * on the name for the reason `countNames` is, and a note that names the key with
   * nothing after it is not carrying a value.
   */
  const propertyValues = useCallback(
    (name: string): { note: VaultFile; value: string }[] => {
      const found: { note: VaultFile; value: string }[] = []
      for (const { note, text } of texts ?? []) {
        const key = propertyKeys(text).find((k) => k.toLowerCase() === name.toLowerCase())
        const value = key ? readProperty(text, key) : null
        if (value) found.push({ note, value })
      }
      return found.sort((a, b) => a.note.path.localeCompare(b.note.path))
    },
    [texts]
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
    if (!texts) return null
    const live = liveText.current
    if (!live) return texts
    return texts.map((row) =>
      row.note.path === live.path ? { note: row.note, text: live.text } : row
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texts, openPath, viewOpen, liveVersion])

  const graph = useMemo(
    () => (corpus ? buildNoteGraph(corpus, noteIndex, graphHides) : null),
    [corpus, noteIndex, graphHides]
  )
  /** Who points here. Same corpus, so the two answers can never disagree. */
  const backlinks = useMemo(
    () => (corpus ? buildBacklinkIndex(corpus, noteIndex) : null),
    [corpus, noteIndex]
  )

  /**
   * The open page's lines, per note, memoised per name.
   *
   * **Only the open one**: gathering every collection and every tag on each read
   * would be a pass over the whole vault per name to answer a question nobody has
   * asked yet. A note with no line is left out rather than listed empty — the page
   * lists where the lines are.
   *
   * One function for both, because a collection and a tag differ only in which
   * lines they gather, and two copies of this are two pages that could disagree
   * about what the corpus says. Defined outside the component, so it is plainly a
   * function of its arguments.
   */
  const collect = useMemo(() => gathered(corpus, collectLines), [corpus])
  /** The same, for a tag: one function, two syntaxes — see `gathered`. */
  const collectTag = useMemo(() => gathered(corpus, collectTagLines), [corpus])

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
    collections,
    collect,
    collectTag,
    tags,
    graph,
    backlinks,
    reading,
    texts,
    patch,
  }
}

/** See `collect`. `gather` is the per-note rule; the cache is per name. */
function gathered(
  corpus: readonly { note: VaultFile; text: string }[] | null,
  gather: (text: string, name: string) => CollectedLine[]
): (name: string) => CollectedNote[] | null {
  const cache = new Map<string, CollectedNote[]>()
  return (name: string) => {
    if (!corpus) return null
    const key = name.toLowerCase()
    const hit = cache.get(key)
    if (hit) return hit
    const found: CollectedNote[] = []
    for (const { note, text } of corpus) {
      const lines = gather(text, name)
      if (lines.length > 0) found.push({ note, lines })
    }
    cache.set(key, found)
    return found
  }
}

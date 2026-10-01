import { describe, expect, it } from 'vitest'
import type { VaultFile, VaultFolder } from '../vaultModel'

// No mocks: `links.ts` imports no filesystem, directly or through `vault.ts`.
import {
  parseNoteLinks,
  isExternalTarget,
  collectNotes,
  childrenOf,
  folderWithNote,
  buildNoteIndex,
  resolveTarget,
  buildBacklinkIndex,
  backlinksTo,
  matchNotes,
  pathKey,
  retargetLinks,
} from '../links'
import { buildNoteGraph } from '../graph'
import { tagNames } from '../tags'

const targets = (text: string) => parseNoteLinks(text).map((l) => l.target)

describe('parseNoteLinks', () => {
  it('finds a link, its label, its raw target, and where it sits', () => {
    const text = 'See [Roadmap](Notes/Roadmap.md) today.'
    expect(parseNoteLinks(text)).toEqual([
      { label: 'Roadmap', target: 'Notes/Roadmap.md', targetAt: 14, wiki: false, start: 4, end: 31 },
    ])
    expect(text.slice(4, 31)).toBe('[Roadmap](Notes/Roadmap.md)')
  })

  it('finds several links on one line', () => {
    expect(targets('[a](One.md) and [b](Two.md)')).toEqual(['One.md', 'Two.md'])
  })

  it('skips every external scheme, and a protocol-relative host', () => {
    expect(
      targets(
        '[a](https://pingbird.example/x) [b](http://x.example) [c](mailto:nobody@pingbird.example)' +
          ' [d](obsidian://open?x) [e](//pingbird.example/x)'
      )
    ).toEqual([])
  })

  it('skips an image, but not the link one character to its right', () => {
    expect(targets('![alt](Diagram.png)')).toEqual([])
    expect(targets('![alt](Diagram.png) [Notes](Notes.md)')).toEqual(['Notes.md'])
    // `\!` is a literal bang, so what follows it is a link after all.
    expect(targets('\\![alt](Ideas.md)')).toEqual(['Ideas.md'])
  })

  it('skips a link inside a fenced block', () => {
    expect(targets('```\n[a](Fake.md)\n```\n[b](Real.md)')).toEqual(['Real.md'])
    expect(targets('~~~md\n[a](Fake.md)\n~~~\n[b](Real.md)')).toEqual(['Real.md'])
    // Indented fence, and a longer fence closed only by one at least as long.
    expect(targets('  ```md\n[a](Fake.md)\n  ```\n[b](Real.md)')).toEqual(['Real.md'])
    expect(targets('`````\n[a](Fake.md)\n```\n[b](AlsoFake.md)\n`````\n[c](Real.md)')).toEqual([
      'Real.md',
    ])
    // An unclosed fence runs to the end of the note.
    expect(targets('```\n[a](Fake.md)\n[b](AlsoFake.md)')).toEqual([])
  })

  it('skips a link inside an inline code span', () => {
    expect(targets('`[a](Fake.md)` but [b](Real.md)')).toEqual(['Real.md'])
    expect(targets('``a `[x](Fake.md)` b`` [c](Real.md)')).toEqual(['Real.md'])
    // A backtick with no partner is literal text, so it must not swallow the note.
    expect(targets('a ` b [c](Real.md)')).toEqual(['Real.md'])
    // Nor may a span cross the blank line that ended its paragraph.
    expect(targets('a `b\n\nc [d](Real.md) e`')).toEqual(['Real.md'])
    // Inline code *inside a label* is a real link, not a code sample.
    expect(targets('[a `b` c](Real.md)')).toEqual(['Real.md'])
  })

  it('skips frontmatter', () => {
    expect(targets('---\nlink: "[a](Fake.md)"\n---\n[b](Real.md)')).toEqual(['Real.md'])
  })

  it('reports offsets into the string it was given, frontmatter included', () => {
    const text = '---\ntitle: Trip\n---\n[a](Real.md)'
    const [link] = parseNoteLinks(text)
    expect(text.slice(link.start, link.end)).toBe('[a](Real.md)')
  })

  it('skips an escaped bracket', () => {
    expect(targets('\\[not a link](Fake.md)')).toEqual([])
    // Two backslashes are one literal backslash, so the bracket is live again.
    expect(targets('\\\\[a](Real.md)')).toEqual(['Real.md'])
  })

  it('reads an angle-bracket target', () => {
    expect(targets('[a](<Notes/Q3 plan.md>)')).toEqual(['Notes/Q3 plan.md'])
  })

  it('reads a target that carries a title', () => {
    expect(targets('[a](Notes/Roadmap.md "The roadmap")')).toEqual(['Notes/Roadmap.md'])
    expect(targets("[a](Notes/Roadmap.md 'The roadmap')")).toEqual(['Notes/Roadmap.md'])
    expect(targets('[a](<Q3 plan.md> "A title")')).toEqual(['Q3 plan.md'])
  })

  it('keeps balanced parentheses inside a bare target', () => {
    expect(targets('[a](Notes/Plan(draft).md)')).toEqual(['Notes/Plan(draft).md'])
    // A space in a bare target is not a link in markdown, which
    // is why `linkToNote` percent-encodes spaces and parentheses.
    expect(targets('[a](Notes/Plan (draft).md)')).toEqual([])
  })

  it('keeps a nested bracket in the label', () => {
    expect(parseNoteLinks('[a [b] c](Real.md)')[0].label).toBe('a [b] c')
  })

  it('resolves backslash escapes in the label but leaves the target verbatim', () => {
    const [link] = parseNoteLinks('[a \\[b\\]](Notes/Q3%20plan.md)')
    expect(link.label).toBe('a [b]')
    expect(link.target).toBe('Notes/Q3%20plan.md')
  })

  it('is not a link when the parentheses never close', () => {
    expect(targets('[a](Notes/Roadmap.md')).toEqual([])
    expect(targets('[a] (Notes/Roadmap.md)')).toEqual([])
  })

  it('finds a wikilink, its label, its target, and where it sits', () => {
    const text = 'See [[Notes/Roadmap]] today.'
    expect(parseNoteLinks(text)).toEqual([
      { label: 'Notes/Roadmap', target: 'Notes/Roadmap', targetAt: 6, wiki: true, start: 4, end: 21 },
    ])
    expect(text.slice(4, 21)).toBe('[[Notes/Roadmap]]')
    // Offsets index the string as given, frontmatter included, as for a markdown link.
    const withFront = '---\ntitle: Trip\n---\n[[Roadmap]]'
    const [link] = parseNoteLinks(withFront)
    expect(withFront.slice(link.start, link.end)).toBe('[[Roadmap]]')
  })

  it('reads a wikilink alias, an anchor, and both at once', () => {
    const one = (text: string) => {
      const [link] = parseNoteLinks(text)
      return [link.target, link.label]
    }
    expect(one('[[Roadmap|the roadmap]]')).toEqual(['Roadmap', 'the roadmap'])
    expect(one('[[Roadmap#Q3]]')).toEqual(['Roadmap#Q3', 'Roadmap#Q3'])
    expect(one('[[Roadmap#Q3|Q3 only]]')).toEqual(['Roadmap#Q3', 'Q3 only'])
    // Only the *first* `|` splits, so an alias may hold one.
    expect(one('[[Roadmap|a|b]]')).toEqual(['Roadmap', 'a|b'])
    // A wikilink has no escapes, so the label is kept as is,
    // where a markdown label would resolve `\[`.
    expect(one('[[a\\-b]]')).toEqual(['a\\-b', 'a\\-b'])
  })

  it('counts an Obsidian embed as a link, where a markdown image is skipped', () => {
    expect(parseNoteLinks('![[Roadmap]]')).toEqual([
      { label: 'Roadmap', target: 'Roadmap', targetAt: 3, wiki: true, start: 1, end: 12 },
    ])
    expect(targets('![alt](Diagram.png)')).toEqual([])
    // The `!` is outside the reported span, so a rewrite of it stays an embed.
    expect('![[Roadmap]]'.slice(1, 12)).toBe('[[Roadmap]]')
  })

  it('marks which syntax a link came from', () => {
    expect(parseNoteLinks('[[a]] [b](c.md)').map((l) => l.wiki)).toEqual([true, false])
  })

  it('is not a link when the wikilink names nothing', () => {
    expect(targets('[[]]')).toEqual([])
    expect(targets('[[   ]]')).toEqual([])
    expect(targets('[[|Alias]]')).toEqual([])
    // The `]]` is consumed either way, so no half-link is left in the leftovers.
    expect(targets('[[]](Real.md)')).toEqual([])
  })

  it('will not let an unclosed wikilink run away', () => {
    expect(targets('[[Roadmap')).toEqual([])
    // A newline ends the attempt, so a stray `[[` cannot pair with a `]]` further down.
    expect(targets('[[Roadmap\nand Diet]]')).toEqual([])
    expect(targets('[[Roadmap\nand [[Diet]]')).toEqual(['Diet'])
    // A bracket inside ends it too, which leaves the inner link found.
    expect(targets('[[a[[b]]')).toEqual(['b'])
    expect(targets('[[a]b]]')).toEqual([])
    // A markdown link wins where it starts, so a `[[…]]` inside
    // its label is label text.
    expect(targets('[see [[x]]](Real.md)')).toEqual(['Real.md'])
  })

  it('skips a wikilink inside code or frontmatter, exactly as it skips a markdown link', () => {
    expect(targets('```\n[[Fake]]\n```\n[[Real]]')).toEqual(['Real'])
    // With nothing real after it, so finding the wrong link cannot pass.
    expect(targets('```\n[[Fake]]\n```')).toEqual([])
    expect(targets('~~~md\n![[Fake]]\n~~~\n[[Real]]')).toEqual(['Real'])
    expect(targets('`[[Fake]]` but [[Real]]')).toEqual(['Real'])
    expect(targets('``a `[[Fake]]` b`` [[Real]]')).toEqual(['Real'])
    expect(targets('---\nlink: "[[Fake]]"\n---\n[[Real]]')).toEqual(['Real'])
    // The `[[` is live text and only its `]]` is inside the code span, so
    // the scan must run over the masked text, where that `]]` is spaces.
    expect(targets('[[Fake`]]` x')).toEqual([])
    // An escaped `\[` is not the start of a wikilink, and what is left is not one.
    expect(targets('\\[[Fake]]')).toEqual([])
  })

  // As with the markdown run below: a failed `[[` restarts one
  // character along, so the scan must stop at the first bracket
  // or newline and be capped. Uncapped, these are quadratic.
  /**
   * The runner's limit must be looser than this test's own budget. Vitest's
   * default 5s killed it under load and reported a timeout; it takes 0.3s
   * normally and 10.4s at load 20. The budget below judges the parser.
   */
  it('finishes on pathological wikilink runs', { timeout: 60000 }, () => {
    const started = Date.now()
    expect(targets('[['.repeat(100000))).toEqual([])
    expect(targets(`${'[['.repeat(100000)}Real]]`)).toEqual(['Real'])
    expect(targets('[[a|'.repeat(50000))).toEqual([])
    expect(targets('[[|]]'.repeat(20000))).toEqual([])
    // The worst shape: a `[[` every 1,000 bracket-free
    // characters, so every attempt runs to the cap.
    expect(targets(`[[${'a'.repeat(1000)}`.repeat(200))).toEqual([])
    // 15s, not 4s: the quadratic forms take 35s against 0.3s, so a
    // loose bound still catches them. At 4s the wall-clock budget
    // lost to parallel test runs and failed only on a full run.
    expect(Date.now() - started).toBeLessThan(15000)
  })

  // The run lengths make this a test: without the `MAX_LABEL` cap,
  // 200,000 unclosed brackets take 35s rather than 0.3s. The runner's
  // 5s default would kill it first; see the wikilink case above.
  it('finishes on pathological bracket runs', { timeout: 60000 }, () => {
    const started = Date.now()
    expect(targets('['.repeat(200000))).toEqual([])
    expect(targets('[a]('.repeat(20000))).toEqual([])
    // An empty label is a legal link, so this resolves; the
    // point is that it does so without walking every prefix.
    expect(targets(`${'['.repeat(200000)}](Real.md)`)).toEqual(['Real.md'])
    expect(targets(`[a](${'('.repeat(20000)}`)).toEqual([])
    expect(targets('`'.repeat(20000))).toEqual([])
    // 15s, not 4s, for the same reason as above.
    expect(Date.now() - started).toBeLessThan(15000)
  })
})

/**
 * One rule for what is code, for links and tags alike (`maskCode`). Two rules
 * had disagreed about a fence under a list item and a fence inside a longer one.
 */
describe('code, as links and tags both read it', () => {
  const note = [
    '- a list item',
    '    ```sh',
    '    yt-dlp --sub-langs en',
    '',
    '    [[Inside Fence]] #intag',
    '    ```',
    '````md',
    '```',
    '--escaped [[Also Inside]] #alsoin',
    '````',
    'after [[Outside]] --real #real',
  ]
  for (const [ending, eol] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
    it(`leaves out a nested and a list-held fence, with ${ending} endings`, () => {
      const text = note.join(eol)
      expect(targets(text)).toEqual(['Outside'])
      expect(tagNames(text)).toEqual(['real'])
    })
  }
})

describe('isExternalTarget', () => {
  it('is true for a scheme, a protocol-relative host, and nothing', () => {
    expect(isExternalTarget('https://pingbird.example')).toBe(true)
    expect(isExternalTarget('mailto:nobody@pingbird.example')).toBe(true)
    expect(isExternalTarget('//pingbird.example/x')).toBe(true)
    expect(isExternalTarget('')).toBe(true)
    expect(isExternalTarget('   ')).toBe(true)
  })

  it('is false for a vault path, an anchor, or a name holding a colon-free path', () => {
    expect(isExternalTarget('Notes/Roadmap.md')).toBe(false)
    expect(isExternalTarget('../Ideas')).toBe(false)
    expect(isExternalTarget('#a-heading')).toBe(false)
    expect(isExternalTarget('/Notes/Roadmap.md')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A vault to resolve against. Every name here is fictional.
// ---------------------------------------------------------------------------

const note = (path: string): VaultFile => ({
  path,
  absolutePath: `/vault/${path}`,
  name: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
})

const health: VaultFolder = {
  path: 'Areas/Health',
  absolutePath: '/vault/Areas/Health',
  name: 'Health',
  folders: [],
  files: [note('Areas/Health/Diet.md'), note('Areas/Health/Sleep.md')],
  note: note('Areas/Health/Health.md'),
}

const root: VaultFolder = {
  path: '',
  absolutePath: '/vault',
  name: 'Vault',
  files: [note('Index.md'), note('Sleep.md')],
  folders: [
    // `Areas/` and `Notes/` have no note file on disk yet; `Ideas/` does.
    { path: 'Areas', absolutePath: '/vault/Areas', name: 'Areas', folders: [health], files: [] },
    {
      path: 'Ideas',
      absolutePath: '/vault/Ideas',
      name: 'Ideas',
      folders: [],
      files: [],
      note: note('Ideas/Ideas.md'),
    },
    {
      path: 'Notes',
      absolutePath: '/vault/Notes',
      name: 'Notes',
      folders: [],
      files: [note('Notes/Q3 plan.md'), note('Notes/Roadmap.md')],
    },
  ],
}

const notes = collectNotes(root)
const index = buildNoteIndex(notes)
const resolve = (target: string, from = 'Index.md') => resolveTarget(target, from, index)
const resolvedPath = (target: string, from = 'Index.md') => {
  const r = resolve(target, from)
  return r.kind === 'note' ? r.note.path : r.kind === 'new' ? `new:${r.path}` : 'external'
}

describe('collectNotes', () => {
  it('lists every note, folder notes included, whether or not the file is there yet', () => {
    expect(notes.map((n) => n.path)).toEqual([
      'Index.md',
      'Sleep.md',
      'Areas/Areas.md',
      'Areas/Health/Health.md',
      'Areas/Health/Diet.md',
      'Areas/Health/Sleep.md',
      'Ideas/Ideas.md',
      'Notes/Notes.md',
      'Notes/Q3 plan.md',
      'Notes/Roadmap.md',
    ])
  })

  it('does not invent a note for the vault root', () => {
    expect(notes.some((n) => n.path.startsWith('/'))).toBe(false)
  })
})

describe('resolveTarget', () => {
  /**
   * A path link's head is a name too. `Areas/Northwind/Query Layer.md`
   * existed, a daily note said `[[Query Layer/DML Files]]`, and following
   * it made `Query Layer/DML Files.md` at the vault root. A slash skipped
   * the by-name lookup. A note's children are in a folder beside it, so
   * the head resolves by name and the rest hangs off its `knownPath`.
   */
  const wiki = (target: string, from = 'Index.md') =>
    resolveTarget({ label: target, target, targetAt: 0, start: 0, end: 0, wiki: true }, from, index)

  it('creates a child under the note the head names, not at the root', () => {
    const found = wiki('Diet/Notes')
    expect(found).toEqual({ kind: 'new', path: 'Areas/Health/Diet/Notes.md' })
  })

  /**
   * The literal readings still decide what resolves, so nothing that
   * works changes meaning; only where an unresolved link is created.
   */
  it('leaves a link that already resolves exactly where it resolved', () => {
    expect(resolvedPath('Notes/Roadmap.md')).toBe('Notes/Roadmap.md')
    expect(resolvedPath('Notes/Q3 plan.md')).toBe('Notes/Q3 plan.md')
  })

  /**
   * A head that names nothing is a path from the root, and a markdown
   * link is always a path: `[label](Diet/Notes.md)` means what it says.
   */
  it('keeps the root-relative reading when the head names no note', () => {
    expect(wiki('Nowhere/At All')).toEqual({ kind: 'new', path: 'Nowhere/At All.md' })
    expect(resolvedPath('Diet/Notes')).toBe('new:Diet/Notes.md')
  })

  it('resolves a root-relative link, which is what the app writes', () => {
    expect(resolvedPath('Notes/Roadmap.md', 'Areas/Health/Health.md')).toBe('Notes/Roadmap.md')
    expect(resolvedPath('/Notes/Roadmap.md', 'Areas/Health/Health.md')).toBe('Notes/Roadmap.md')
  })

  it('falls back to the containing note’s own folder', () => {
    expect(resolvedPath('Diet', 'Areas/Health/Health.md')).toBe('Areas/Health/Diet.md')
    expect(resolvedPath('./Diet.md', 'Areas/Health/Health.md')).toBe('Areas/Health/Diet.md')
    expect(resolvedPath('../Health/Diet.md', 'Areas/Health/Health.md')).toBe(
      'Areas/Health/Diet.md'
    )
  })

  it('gives root-relative the win when a target resolves both ways', () => {
    // `Sleep.md` at the root and `Areas/Health/Sleep.md` are both real notes.
    expect(resolvedPath('Sleep', 'Areas/Health/Health.md')).toBe('Sleep.md')
    // An explicit `./` asks for the neighbour instead.
    expect(resolvedPath('./Sleep', 'Areas/Health/Health.md')).toBe('Areas/Health/Sleep.md')
  })

  it('adds the missing .md', () => {
    expect(resolvedPath('Notes/Roadmap')).toBe('Notes/Roadmap.md')
  })

  it('ignores case, because the volume does', () => {
    expect(resolvedPath('notes/roadmap.md')).toBe('Notes/Roadmap.md')
    expect(resolvedPath('NOTES/ROADMAP')).toBe('Notes/Roadmap.md')
  })

  it('decodes a percent-encoded target', () => {
    expect(resolvedPath('Notes/Q3%20plan.md')).toBe('Notes/Q3 plan.md')
  })

  it('does not throw on a malformed escape', () => {
    expect(resolvedPath('Notes/Q3%zzplan.md')).toBe('new:Notes/Q3%zzplan.md')
    expect(resolvedPath('Notes/Q3%20plan%zz.md')).toBe('new:Notes/Q3 plan%zz.md')
  })

  it('ignores an anchor or a query string', () => {
    expect(resolvedPath('Notes/Roadmap.md#a-heading')).toBe('Notes/Roadmap.md')
    expect(resolvedPath('Notes/Roadmap?v=2')).toBe('Notes/Roadmap.md')
    // An escaped `#` is part of the name, not the start of an anchor.
    expect(resolvedPath('Notes/Q3%20plan.md')).toBe('Notes/Q3 plan.md')
  })

  it('reads a bare anchor as the note holding it', () => {
    expect(resolvedPath('#a-heading', 'Notes/Roadmap.md')).toBe('Notes/Roadmap.md')
  })

  it('treats a link to a folder and to its folder note as one note', () => {
    expect(resolvedPath('Ideas')).toBe('Ideas/Ideas.md')
    expect(resolvedPath('Ideas/')).toBe('Ideas/Ideas.md')
    expect(resolvedPath('Ideas/Ideas.md')).toBe('Ideas/Ideas.md')
    // And a folder whose note is not written yet is still that note.
    expect(resolvedPath('Notes')).toBe('Notes/Notes.md')
  })

  it('lets a real note at a path outrank the folder alias', () => {
    const withRootIdeas = buildNoteIndex([...notes, note('Ideas.md')])
    expect(resolveTarget('Ideas', 'Index.md', withRootIdeas)).toEqual({
      kind: 'note',
      note: note('Ideas.md'),
    })
  })

  it('reports a dangling link as new, with where the note would go', () => {
    expect(resolve('Notes/Later', 'Index.md')).toEqual({ kind: 'new', path: 'Notes/Later.md' })
    expect(resolve('./Later', 'Areas/Health/Health.md')).toEqual({
      kind: 'new',
      path: 'Areas/Health/Later.md',
    })
  })

  /**
   * The target comes along, since a link drawn as a link must go
   * somewhere when clicked: `App` hands it to the OS.
   */
  it('carries what was written on an external target', () => {
    expect(resolveTarget('https://pingbird.example/a', 'Index.md', index)).toEqual({
      kind: 'external',
      target: 'https://pingbird.example/a',
    })
    expect(resolveTarget('assets/plan.png', 'Index.md', index)).toEqual({
      kind: 'external',
      target: 'assets/plan.png',
    })
  })

  it('is external for a scheme, a non-.md file, or a walk out of the vault', () => {
    expect(resolvedPath('https://pingbird.example')).toBe('external')
    expect(resolvedPath('')).toBe('external')
    expect(resolvedPath('assets/plan.png')).toBe('external')
    expect(resolvedPath('../../Desktop/pwned', 'Index.md')).toBe('external')
  })

  it('does not mistake a dotted note name for a file extension', () => {
    expect(resolvedPath('Daily/2026.09.03')).toBe('new:Daily/2026.09.03.md')
  })
})

// // --------------------------------------------------------------------------- //
// Wikilinks resolve by name, which a markdown path does not. // Parsed rather than
// hand-built, so these cover both halves. //
// ---------------------------------------------------------------------------

const wikiResolve = (text: string, from = 'Index.md', into = index) =>
  resolveTarget(parseNoteLinks(text)[0], from, into)
const wikiPath = (text: string, from = 'Index.md', into = index) => {
  const r = wikiResolve(text, from, into)
  return r.kind === 'note' ? r.note.path : r.kind === 'new' ? `new:${r.path}` : 'external'
}

describe('resolveTarget, for a wikilink', () => {
  it('finds a bare name anywhere in the vault — the whole point of the syntax', () => {
    expect(wikiPath('[[Roadmap]]')).toBe('Notes/Roadmap.md')
    expect(wikiPath('[[Diet]]')).toBe('Areas/Health/Diet.md')
    // From a note nowhere near it, which is where a path lookup gives up.
    expect(wikiPath('[[Roadmap]]', 'Areas/Health/Diet.md')).toBe('Notes/Roadmap.md')
    // A markdown link does not get that search: `[x](Roadmap)` is a
    // relative URL, and searching the vault for it would be ambiguous.
    expect(resolvedPath('Roadmap')).toBe('new:Roadmap.md')
    expect(resolvedPath('Roadmap', 'Areas/Health/Diet.md')).toBe('new:Roadmap.md')
  })

  it('ignores case in a name, because the volume does', () => {
    expect(wikiPath('[[roadmap]]')).toBe('Notes/Roadmap.md')
    expect(wikiPath('[[ROADMAP]]')).toBe('Notes/Roadmap.md')
    expect(wikiPath('[[Roadmap.md]]')).toBe('Notes/Roadmap.md')
    // A space needs no encoding inside `[[…]]`, unlike a bare markdown destination.
    expect(wikiPath('[[q3 PLAN]]')).toBe('Notes/Q3 plan.md')
  })

  it('drops an alias and an anchor before looking', () => {
    expect(wikiPath('[[Roadmap|the roadmap]]')).toBe('Notes/Roadmap.md')
    expect(wikiPath('[[Roadmap#Q3]]')).toBe('Notes/Roadmap.md')
    expect(wikiPath('[[Roadmap#Q3|Q3 only]]')).toBe('Notes/Roadmap.md')
    // A block reference is an anchor too.
    expect(wikiPath('[[Roadmap#^b7f2a1]]')).toBe('Notes/Roadmap.md')
    // And a bare anchor is the note holding it, as `[x](#h)` already was.
    expect(wikiPath('[[#Q3]]', 'Notes/Roadmap.md')).toBe('Notes/Roadmap.md')
  })

  it('takes a target holding a slash as the path it looks like', () => {
    expect(wikiPath('[[Notes/Roadmap]]')).toBe('Notes/Roadmap.md')
    expect(wikiPath('[[/Notes/Roadmap.md]]')).toBe('Notes/Roadmap.md')
    expect(wikiPath('[[../Health/Diet]]', 'Areas/Health/Health.md')).toBe('Areas/Health/Diet.md')
    // The path rule, not the name rule: the named folder is honoured,
    // so this dangles rather than finding `Notes/Roadmap.md`.
    expect(wikiPath('[[Archive/Roadmap]]')).toBe('new:Archive/Roadmap.md')
  })

  it('gives an ambiguous name to the linking note’s own folder, then the shortest path', () => {
    // `Sleep.md` at the root and `Areas/Health/Sleep.md` are both real notes.
    expect(wikiPath('[[Sleep]]', 'Areas/Health/Health.md')).toBe('Areas/Health/Sleep.md')
    expect(wikiPath('[[Sleep]]', 'Index.md')).toBe('Sleep.md')
    // Neither folder holds one, so the shortest path wins.
    expect(wikiPath('[[Sleep]]', 'Ideas/Ideas.md')).toBe('Sleep.md')
  })

  it('breaks a name tie totally, so the pick cannot depend on the read order', () => {
    const twins = [note('Zoo/Plan.md'), note('Areas/Plan.md'), note('Areas/Health/Plan.md')]
    for (const order of [twins, [...twins].reverse()]) {
      const built = buildNoteIndex(order)
      expect(wikiPath('[[Plan]]', 'Areas/Health/Health.md', built)).toBe('Areas/Health/Plan.md')
      // Fewest segments next, and `Areas` before `Zoo` at equal depth.
      expect(wikiPath('[[Plan]]', 'Index.md', built)).toBe('Areas/Plan.md')
      expect(wikiPath('[[Plan]]', 'Ideas/Ideas.md', built)).toBe('Areas/Plan.md')
    }
  })

  it('finds a folder note once, not twice', () => {
    expect(wikiPath('[[Ideas]]')).toBe('Ideas/Ideas.md')
    // And a folder whose note is not written yet is still that one note.
    expect(wikiPath('[[Notes]]')).toBe('Notes/Notes.md')
    expect(wikiPath('[[Areas]]')).toBe('Areas/Areas.md')
    // A real note at that path still outranks the folder of the same name.
    const withRootIdeas = buildNoteIndex([...notes, note('Ideas.md')])
    expect(wikiPath('[[Ideas]]', 'Index.md', withRootIdeas)).toBe('Ideas.md')
  })

  it('reports a name with no note as a dangling link, at the vault root', () => {
    expect(wikiResolve('[[Later]]')).toEqual({ kind: 'new', path: 'Later.md' })
    expect(wikiResolve('[[Later]]', 'Areas/Health/Health.md')).toEqual({
      kind: 'new',
      path: 'Later.md',
    })
    expect(wikiResolve('[[Notes/Later]]')).toEqual({ kind: 'new', path: 'Notes/Later.md' })
  })

  it('calls an embedded asset external, so a picture is not a note', () => {
    expect(wikiPath('![[diagram.png]]')).toBe('external')
    expect(wikiPath('![[Roadmap]]')).toBe('Notes/Roadmap.md')
  })

  it('reads a name as typed, where a markdown destination is a URL', () => {
    const odd = buildNoteIndex([note('What now?.md'), note('Q3%20plan.md')])
    // `?` is a legal character in a name and starts a query string in a URL.
    expect(wikiPath('[[What now?]]', 'Index.md', odd)).toBe('What now?.md')
    expect(resolveTarget('What now?.md', 'Index.md', odd).kind).toBe('new')
    // Nothing inside `[[…]]` is percent-encoded, so `%20` is three characters.
    expect(wikiPath('[[Q3%20plan]]', 'Index.md', odd)).toBe('Q3%20plan.md')
    expect(wikiPath('[[Q3%20plan]]')).toBe('new:Q3%20plan.md')
  })

  it('never calls a wikilink external for looking like a scheme', () => {
    const odd = buildNoteIndex([note('Q3: plan.md')])
    expect(wikiPath('[[Q3: plan]]', 'Index.md', odd)).toBe('Q3: plan.md')
    // Where the same text as a markdown destination is a URL, and is not a note.
    expect(resolvedPath('Q3: plan')).toBe('external')
  })
})

// // --------------------------------------------------------------------------- // A
// vault linked only by wikilinks must give the graph a person would draw. // Before
// wikilinks were parsed it had no edges at all. //
// ---------------------------------------------------------------------------

describe('the graph a wikilink-only vault makes', () => {
  const flat = [note('Index.md'), note('Roadmap.md'), note('Diet.md'), note('Sleep.md')]
  const texts = [
    { note: flat[0], text: 'Plans: [[Roadmap]], and [[Diet|what I eat]].' },
    { note: flat[1], text: 'See [[Diet]] and [[Sleep#Naps]].\n\n```\n[[Fake]]\n```' },
    { note: flat[2], text: 'Back to [[Roadmap]] twice: [[roadmap]]. And ![[Sleep]].' },
    { note: flat[3], text: 'Nothing links out of here.' },
  ]

  it('has the edges a reader would count, and no others', () => {
    const graph = buildNoteGraph(texts, buildNoteIndex(flat))
    expect(graph.edges.map((e) => `${e.from} -> ${e.to} x${e.weight}`)).toEqual([
      'diet -> roadmap x2',
      'diet -> sleep x1',
      'index -> diet x1',
      'index -> roadmap x1',
      'roadmap -> diet x1',
      'roadmap -> sleep x1',
    ])
    expect(graph.nodeCount).toBe(4)
    // A code sample invents no node, so `Fake` is not there and nothing is orphaned.
    expect(graph.orphans).toEqual([])
  })
})


describe('buildBacklinkIndex', () => {
  const vault = [
    { note: note('Index.md'), text: 'See [Roadmap](Notes/Roadmap.md) and [again](notes/roadmap).' },
    {
      note: note('Areas/Health/Health.md'),
      text: '[Roadmap](/Notes/Roadmap.md)\n[Diet](Diet)\n[self](Areas/Health/Health.md)',
    },
    { note: note('Ideas/Ideas.md'), text: '```\n[Roadmap](Notes/Roadmap.md)\n```\n[Later](Notes/Later)' },
  ]
  const backlinks = buildBacklinkIndex(vault, index)

  it('answers which notes link to this one, one entry per source note', () => {
    const into = backlinksTo(backlinks, 'Notes/Roadmap.md')
    expect(into.map((b) => [b.note.path, b.count])).toEqual([
      ['Areas/Health/Health.md', 1],
      ['Index.md', 2],
    ])
    // Two links, one line, and one row to read, which is what `mentions` is for.
    expect(into[1].mentions).toEqual([
      'See [Roadmap](Notes/Roadmap.md) and [again](notes/roadmap).',
    ])
  })

  it('keys by the note, not by how the link was spelt', () => {
    expect(backlinksTo(backlinks, 'notes/roadmap').map((b) => b.note.path)).toEqual([
      'Areas/Health/Health.md',
      'Index.md',
    ])
    expect(backlinksTo(backlinks, 'Areas/Health/Diet.md').map((b) => b.note.path)).toEqual([
      'Areas/Health/Health.md',
    ])
  })

  it('leaves a note out of its own backlinks', () => {
    expect(backlinksTo(backlinks, 'Areas/Health/Health.md')).toEqual([])
  })

  it('holds the links into a note that does not exist yet', () => {
    expect(backlinksTo(backlinks, 'Notes/Later.md').map((b) => b.note.path)).toEqual([
      'Ideas/Ideas.md',
    ])
  })

  it('is empty for a note nothing links to, and never counts a code sample', () => {
    expect(backlinksTo(backlinks, 'Sleep.md')).toEqual([])
    expect(backlinksTo(backlinks, 'Index.md')).toEqual([])
  })

  it('renders the same whatever order the notes were read in', () => {
    const reversed = buildBacklinkIndex([...vault].reverse(), index)
    expect(backlinksTo(reversed, 'Notes/Roadmap.md').map((b) => b.note.path)).toEqual([
      'Areas/Health/Health.md',
      'Index.md',
    ])
  })
})

describe('buildBacklinkIndex, for wikilinks', () => {
  const vault = [
    { note: note('Index.md'), text: 'See [[Roadmap]] and [[roadmap|again]].' },
    { note: note('Areas/Health/Health.md'), text: '[[Roadmap#Q3]], [[Diet]], [[Health]]' },
    { note: note('Ideas/Ideas.md'), text: '```\n[[Roadmap]]\n```\n[[Later]] ![[Roadmap]]' },
  ]
  const backlinks = buildBacklinkIndex(vault, index)

  it('keys a wikilink by the note it names, wherever in the vault that note lives', () => {
    expect(
      backlinksTo(backlinks, 'Notes/Roadmap.md').map((b) => [b.note.path, b.count])
    ).toEqual([
      ['Areas/Health/Health.md', 1],
      // The embed counts; the one in the fence does not.
      ['Ideas/Ideas.md', 1],
      ['Index.md', 2],
    ])
    // A bare name from a note two folders away, the case that went unseen.
    expect(backlinksTo(backlinks, 'Areas/Health/Diet.md').map((b) => b.note.path)).toEqual([
      'Areas/Health/Health.md',
    ])
  })

  it('leaves a note out of its own backlinks, and holds a dangling name', () => {
    expect(backlinksTo(backlinks, 'Areas/Health/Health.md')).toEqual([])
    expect(backlinksTo(backlinks, 'Later.md').map((b) => b.note.path)).toEqual(['Ideas/Ideas.md'])
  })

  // Each `\r` of a line ending is a character before the link:
  // uncounted, thirty lines down the mention was read off a later line.
  it('quotes the line a link is on in a note with CRLF endings', () => {
    const lines = [...Array.from({ length: 30 }, (_, n) => `line ${n}`), 'the plan [[Roadmap]]', 'after']
    const crlf = buildBacklinkIndex([{ note: note('Index.md'), text: lines.join('\r\n') }], index)
    expect(backlinksTo(crlf, 'Notes/Roadmap.md')[0].mentions).toEqual(['the plan [[Roadmap]]'])
  })
})

describe('matchNotes', () => {
  // Every tier matters here: the exact match is nested (without the exact tier a
  // root prefix match would outrank it), and the shorter of the two word-start
  // names sorts later (without the shorter-name tie-break they would swap).
  const pick = [
    note('Alpine Road Trip.md'),
    note('Areas/Road.md'),
    note('Crossroad.md'),
    note('Notes/road/Plan.md'),
    note('Roadmapping.md'),
    note('Zoo Road.md'),
  ]

  it('ranks exact, then prefix, then a word inside, then anywhere, then the path alone', () => {
    expect(matchNotes('road', pick).map((m) => m.note.path)).toEqual([
      'Areas/Road.md',
      'Roadmapping.md',
      'Zoo Road.md',
      'Alpine Road Trip.md',
      'Crossroad.md',
      'Notes/road/Plan.md',
    ])
  })

  it('lets a path find a note the name cannot', () => {
    expect(matchNotes('notes/ro', pick).map((m) => m.note.path)).toEqual(['Notes/road/Plan.md'])
  })

  it('ignores case and surrounding space', () => {
    expect(matchNotes('  ROADM ', pick).map((m) => m.note.path)).toEqual(['Roadmapping.md'])
  })

  it('breaks a tie on the shorter name, then the path', () => {
    expect(matchNotes('sleep', notes).map((m) => m.note.path)).toEqual([
      'Sleep.md',
      'Areas/Health/Sleep.md',
    ])
  })

  it('lists the vault in tree order for an empty query, and honours the limit', () => {
    expect(matchNotes('', notes, 3).map((m) => m.note.path)).toEqual([
      'Index.md',
      'Sleep.md',
      'Areas/Areas.md',
    ])
    expect(matchNotes('road', pick, 2)).toHaveLength(2)
  })
})

/**
 * What is inside a nested note: the children the tree draws under
 * its row, which the note's Inside section lists. The folder's
 * own note is not one of them; `walk` moves it onto the folder.
 */
describe('folderWithNote', () => {
  const paths = (path: string) => {
    const folder = folderWithNote(root, path)
    return folder ? childrenOf(folder).map((file) => file.path) : []
  }

  it('answers with a folder’s children, subfolders first, by their own notes', () => {
    // `Areas/` holds one folder and no files, named by its
    // folder note, the path its tree row opens.
    expect(paths('Areas/Areas.md')).toEqual(['Areas/Health/Health.md'])
    expect(paths('Areas/Health/Health.md')).toEqual([
      'Areas/Health/Diet.md',
      'Areas/Health/Sleep.md',
    ])
  })

  it('answers with nothing for a plain note', () => {
    expect(paths('Index.md')).toEqual([])
    expect(paths('Notes/Roadmap.md')).toEqual([])
  })

  // A folder note never typed in has no file, but the row and its
  // children are there: `folderNoteRef`'s path is what the tree opens.
  it('answers for a folder whose own note is not written yet', () => {
    expect(paths('Notes/Notes.md')).toEqual(['Notes/Q3 plan.md', 'Notes/Roadmap.md'])
  })

  it('answers with nothing for a folder that holds only its own note', () => {
    expect(paths('Ideas/Ideas.md')).toEqual([])
  })

  it('is case-insensitive, as the volume is', () => {
    expect(paths('notes/notes.md')).toEqual(['Notes/Q3 plan.md', 'Notes/Roadmap.md'])
  })

  it('answers with nothing for no tree at all', () => {
    expect(folderWithNote(null, 'Index.md')).toBeNull()
  })

  // The folder itself, so the section can draw it with
  // `FolderTree` and open subfolders.
  it('answers with the folder, not a list', () => {
    expect(folderWithNote(root, 'Areas/Areas.md')?.path).toBe('Areas')
  })
})

/**
 * Following a note that moved. A rename takes its backlinks along, or
 * every link to it points at a note to be created. Each link keeps its
 * form (bare name, path, alias, label, anchor), and is rewritten because
 * it resolves to the moved note, never because its text looks like it.
 */
describe('retargetLinks', () => {
  /** `Notes/Roadmap.md` renamed to `Notes/Plan.md`, the ordinary case. */
  const renamed = note('Notes/Plan.md')
  const moves = new Map([[pathKey('Notes/Roadmap.md'), renamed]])
  const follow = (text: string, from = 'Index.md') => retargetLinks(text, from, moves, index)

  it('rewrites a bare wikilink to the new name', () => {
    expect(follow('See [[Roadmap]] today.')).toBe('See [[Plan]] today.')
  })

  it('keeps a wikilink written as a path a path', () => {
    expect(follow('See [[Notes/Roadmap]].')).toBe('See [[Notes/Plan]].')
  })

  /** The alias is what the link is called; renaming the note does not change it. */
  it('keeps the alias', () => {
    expect(follow('See [[Roadmap|the plan]].')).toBe('See [[Plan|the plan]].')
    expect(follow('See [[Notes/Roadmap|the plan]].')).toBe('See [[Notes/Plan|the plan]].')
  })

  /** The anchor names a heading inside the note, which did not move. */
  it('keeps an anchor', () => {
    expect(follow('See [[Roadmap#Q3]].')).toBe('See [[Plan#Q3]].')
    expect(follow('See [[Roadmap#Q3|later]].')).toBe('See [[Plan#Q3|later]].')
  })

  it('follows an embed, which is a stronger reference than a link', () => {
    expect(follow('![[Roadmap]]')).toBe('![[Plan]]')
  })

  /** A markdown destination is a path to a file; `.md` stays if it was there. */
  it('rewrites a markdown destination, keeping the label and the extension', () => {
    expect(follow('See [the plan](Notes/Roadmap.md).')).toBe('See [the plan](Notes/Plan.md).')
    expect(follow('See [the plan](Notes/Roadmap).')).toBe('See [the plan](Notes/Plan).')
    expect(follow('See [x](/Notes/Roadmap.md).')).toBe('See [x](/Notes/Plan.md).')
  })

  /**
   * The destination, not the label (the same word here), so the
   * replacement is tied to where the target sits.
   */
  it('leaves a label that reads like the destination alone', () => {
    expect(follow('See [Roadmap](Notes/Roadmap.md).')).toBe('See [Roadmap](Notes/Plan.md).')
  })

  /** And a title that repeats it: the destination was found by searching the link's text. */
  it('leaves a title that reads like the destination alone', () => {
    expect(follow('See [x](Notes/Roadmap.md "Notes/Roadmap.md").')).toBe('See [x](Notes/Plan.md "Notes/Roadmap.md").')
  })

  it('encodes a space when the destination it replaces was encoded', () => {
    const spaced = new Map([[pathKey('Notes/Roadmap.md'), note('Notes/Reading list.md')]])
    expect(retargetLinks('[x](Notes/Roadmap.md)', 'Index.md', spaced, index)).toBe(
      '[x](Notes/Reading%20list.md)'
    )
    // A wikilink is not a URL: its spaces are spaces.
    expect(retargetLinks('[[Roadmap]]', 'Index.md', spaced, index)).toBe('[[Reading list]]')
  })

  /**
   * It resolves, not matches text. `Sleep` is two notes here, `Sleep.md`
   * at the root and `Areas/Health/Sleep.md`, and `[[Sleep]]` means the
   * nearer one. Renaming one must not touch links meant for the other.
   */
  it('rewrites only the link that resolved to the note that moved', () => {
    const moved = new Map([[pathKey('Areas/Health/Sleep.md'), note('Areas/Health/Rest.md')]])
    // Written in Health, `[[Sleep]]` is Health's own.
    expect(retargetLinks('[[Sleep]]', 'Areas/Health/Diet.md', moved, index)).toBe('[[Rest]]')
    // Written at the root it is the root's, and is left alone.
    expect(retargetLinks('[[Sleep]]', 'Index.md', moved, index)).toBe('[[Sleep]]')
  })

  it('leaves a link to a note that did not move', () => {
    expect(follow('See [[Q3 plan]] and [[Ideas]].')).toBe('See [[Q3 plan]] and [[Ideas]].')
  })

  it('leaves a link to a note that does not exist yet', () => {
    expect(follow('See [[Landmark Plaza]].')).toBe('See [[Landmark Plaza]].')
  })

  it('leaves external links, images and code alone', () => {
    const text = [
      'A [site](https://example.test/Roadmap) and a mail [x](mailto:someone@example.test).',
      '![a picture](Notes/Roadmap.png)',
      'Inline `[[Roadmap]]` and a fence:',
      '```',
      '[[Roadmap]]',
      '```',
    ].join('\n')
    expect(follow(text)).toBe(text)
  })

  it('rewrites every link in a note, and nothing between them', () => {
    expect(follow('[[Roadmap]] then [[Roadmap|again]] then [x](Notes/Roadmap.md).')).toBe(
      '[[Plan]] then [[Plan|again]] then [x](Notes/Plan.md).'
    )
  })

  /**
   * A folder rename moves every note under it, so links to any
   * of them follow. That is why this takes a map, not one pair.
   */
  it('follows every note of a renamed folder at once', () => {
    const group = new Map([
      [pathKey('Areas/Health/Health.md'), note('Areas/Wellbeing/Wellbeing.md')],
      [pathKey('Areas/Health/Diet.md'), note('Areas/Wellbeing/Diet.md')],
    ])
    expect(retargetLinks('[[Areas/Health]] and [[Areas/Health/Diet]]', 'Index.md', group, index)).toBe(
      '[[Areas/Wellbeing]] and [[Areas/Wellbeing/Diet]]'
    )
  })

  it('leaves a note with no links exactly as it was', () => {
    const text = '---\npath: Notes\n---\n\n# A page\n\nNo links here.\n'
    expect(follow(text)).toBe(text)
  })
})

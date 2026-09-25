import { describe, expect, it } from 'vitest'
import type { VaultFile, VaultFolder } from '../vaultModel'

// No mock of anything: `links.ts` imports no filesystem, directly or through
// `vault.ts`, so there is no seam left to stand in for. That is what the pure
// helpers moving to `vaultModel.ts` and `frontmatter.ts` bought.
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

const targets = (text: string) => parseNoteLinks(text).map((l) => l.target)

describe('parseNoteLinks', () => {
  it('finds a link, its label, its raw target, and where it sits', () => {
    const text = 'See [Roadmap](Notes/Roadmap.md) today.'
    expect(parseNoteLinks(text)).toEqual([
      { label: 'Roadmap', target: 'Notes/Roadmap.md', wiki: false, start: 4, end: 31 },
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
    // A *space* in a bare target is not a link at all in markdown — which is why
    // `linkToNote` percent-encodes the space and the parentheses both.
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
      { label: 'Notes/Roadmap', target: 'Notes/Roadmap', wiki: true, start: 4, end: 21 },
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
    // A wikilink has no escape syntax, so the label is verbatim where a markdown
    // label would resolve `\[`.
    expect(one('[[a\\-b]]')).toEqual(['a\\-b', 'a\\-b'])
  })

  it('counts an Obsidian embed as a link, where a markdown image is skipped', () => {
    expect(parseNoteLinks('![[Roadmap]]')).toEqual([
      { label: 'Roadmap', target: 'Roadmap', wiki: true, start: 1, end: 12 },
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
    // A newline ends the attempt, so a stray `[[` cannot reach a `]]` further down
    // the note and invent a link out of the prose in between.
    expect(targets('[[Roadmap\nand Diet]]')).toEqual([])
    expect(targets('[[Roadmap\nand [[Diet]]')).toEqual(['Diet'])
    // A bracket inside ends it too, which is what leaves the *inner* link found.
    expect(targets('[[a[[b]]')).toEqual(['b'])
    expect(targets('[[a]b]]')).toEqual([])
    // A markdown link wins the position it starts at, so a `[[…]]` inside a label
    // is label text and not a second link.
    expect(targets('[see [[x]]](Real.md)')).toEqual(['Real.md'])
  })

  it('skips a wikilink inside code or frontmatter, exactly as it skips a markdown link', () => {
    expect(targets('```\n[[Fake]]\n```\n[[Real]]')).toEqual(['Real'])
    // With nothing real after it, so the assertion cannot be met by finding the
    // wrong link and calling it the right one.
    expect(targets('```\n[[Fake]]\n```')).toEqual([])
    expect(targets('~~~md\n![[Fake]]\n~~~\n[[Real]]')).toEqual(['Real'])
    expect(targets('`[[Fake]]` but [[Real]]')).toEqual(['Real'])
    expect(targets('``a `[[Fake]]` b`` [[Real]]')).toEqual(['Real'])
    expect(targets('---\nlink: "[[Fake]]"\n---\n[[Real]]')).toEqual(['Real'])
    // The `[[` is live text and only its `]]` is inside the code span, so the scan
    // has to run over the *masked* text — where that `]]` is spaces — rather than
    // over the note, where it would close a link nobody wrote.
    expect(targets('[[Fake`]]` x')).toEqual([])
    // An escaped `\[` is not the start of a wikilink, and what is left is not one.
    expect(targets('\\[[Fake]]')).toEqual([])
  })

  // Same argument as the markdown run below: a failed `[[` attempt restarts one
  // character along, so the scan must die on the first bracket or newline it meets
  // and be capped in any case. Uncapped, these are quadratic.
  /**
   * **The runner's own limit has to be looser than this test's.** Vitest kills a
   * test at 5s by default, and this one allows itself 15 — so on a loaded machine
   * it died at five and reported a timeout, which says nothing about the thing it
   * guards. Measured: 0.3s normally, 10.4s at load 20. The budget below is what
   * judges the parser; this number only has to stay out of its way.
   */
  it('finishes on pathological wikilink runs', { timeout: 60000 }, () => {
    const started = Date.now()
    expect(targets('[['.repeat(100000))).toEqual([])
    expect(targets(`${'[['.repeat(100000)}Real]]`)).toEqual(['Real'])
    expect(targets('[[a|'.repeat(50000))).toEqual([])
    expect(targets('[[|]]'.repeat(20000))).toEqual([])
    // The worst shape there is: a `[[` every 1,000 bracket-free characters, so
    // every attempt runs the cap out before it fails.
    expect(targets(`[[${'a'.repeat(1000)}`.repeat(200))).toEqual([])
    // 15s, not 4s. The quadratic forms these guard against take 35 seconds against
    // 0.3 — measured both ways — so the margin is three orders of magnitude and a
    // generous bound still catches them. A 4s budget did not: it is wall-clock, and
    // it loses to contention when vitest runs every file in parallel, so the test
    // failed on a full run and passed alone. A flaky guard is worse than a loose one.
    expect(Date.now() - started).toBeLessThan(15000)
  })

  // The run lengths are what make this a test: a failed label scan restarts one
  // character along, so without the `MAX_LABEL` bound 200,000 unclosed brackets
  // take 35 seconds rather than 0.3 — measured, both ways.
  // The runner's 5s default would kill this before its own 15s budget could judge
  // it — see the wikilink case above.
  it('finishes on pathological bracket runs', { timeout: 60000 }, () => {
    const started = Date.now()
    expect(targets('['.repeat(200000))).toEqual([])
    expect(targets('[a]('.repeat(20000))).toEqual([])
    // An empty label is a legal link, so this one resolves — the point is that it
    // does so without walking every prefix of the run.
    expect(targets(`${'['.repeat(200000)}](Real.md)`)).toEqual(['Real.md'])
    expect(targets(`[a](${'('.repeat(20000)}`)).toEqual([])
    expect(targets('`'.repeat(20000))).toEqual([])
    // 15s, not 4s. The quadratic forms these guard against take 35 seconds against
    // 0.3 — measured both ways — so the margin is three orders of magnitude and a
    // generous bound still catches them. A 4s budget did not: it is wall-clock, and
    // it loses to contention when vitest runs every file in parallel, so the test
    // failed on a full run and passed alone. A flaky guard is worse than a loose one.
    expect(Date.now() - started).toBeLessThan(15000)
  })
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
   * **A path link's head is a name too**, and this is the bug that made it matter.
   *
   * Reported from the running app: `Areas/Northwind/Query Layer.md` existed, a
   * daily note said `[[Query Layer/DML Files]]`, and following it created
   * `Query Layer/DML Files.md` **at the vault root** — a second folder with the
   * same name as a note, sitting beside `Areas`. The by-name lookup is guarded on
   * the target *not* containing a slash, so one slash sent the whole thing to the
   * root-relative reading and nothing looked for the note it plainly names.
   *
   * A note's children live in a folder beside it, so the head resolves by name and
   * the rest hangs off its `knownPath`.
   */
  const wiki = (target: string, from = 'Index.md') =>
    resolveTarget({ label: target, target, start: 0, end: 0, wiki: true }, from, index)

  it('creates a child under the note the head names, not at the root', () => {
    const found = wiki('Diet/Notes')
    expect(found).toEqual({ kind: 'new', path: 'Areas/Health/Diet/Notes.md' })
  })

  /** The literal readings still decide what *resolves*, so nothing that works today
   *  changes meaning — only where an unresolved one is created. */
  it('leaves a link that already resolves exactly where it resolved', () => {
    expect(resolvedPath('Notes/Roadmap.md')).toBe('Notes/Roadmap.md')
    expect(resolvedPath('Notes/Q3 plan.md')).toBe('Notes/Q3 plan.md')
  })

  /** A head that names nothing is still a path from the root, and a markdown link
   *  is a path always: `[label](Diet/Notes.md)` means what it says. */
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

  /** The target rides along, because a link the editor draws as a link has to go
   *  somewhere when it is clicked: `App` hands this to the OS. */
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

// ---------------------------------------------------------------------------
// Wikilinks resolve by **name**, which is the half a markdown path does not do.
// Parsed rather than hand-built, so these cover the two halves together.
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
    // A markdown link is deliberately **not** given that search: `[x](Roadmap)` is
    // a relative URL, and hunting the vault for it is the ambiguity this refuses.
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
    // Path rule, not name rule: the folder named is honoured rather than searched
    // past, so this dangles instead of finding `Notes/Roadmap.md`.
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

// ---------------------------------------------------------------------------
// The check whose absence let the bug ship: a vault linked *only* by wikilinks
// must produce the graph a person would draw by hand. Before wikilinks were
// parsed this graph had **zero** edges, which is why it looked random on screen.
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
    // Two links, one line — and one row to read, which is what `mentions` is for.
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
    // A bare name from a note two folders away, which is the case that was invisible.
    expect(backlinksTo(backlinks, 'Areas/Health/Diet.md').map((b) => b.note.path)).toEqual([
      'Areas/Health/Health.md',
    ])
  })

  it('leaves a note out of its own backlinks, and holds a dangling name', () => {
    expect(backlinksTo(backlinks, 'Areas/Health/Health.md')).toEqual([])
    expect(backlinksTo(backlinks, 'Later.md').map((b) => b.note.path)).toEqual(['Ideas/Ideas.md'])
  })
})

describe('matchNotes', () => {
  // Chosen so every rung is load-bearing: the exact match is *nested* (so dropping
  // the exact tier would let the root-level prefix match outrank it), and the
  // shorter of the two word-start names sorts later alphabetically (so dropping the
  // shorter-name tie-break would reorder them).
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
 * What is inside a nested note: the children the tree draws under its row, which
 * is what the section at the end of that note lists.
 *
 * A nested note *is* a folder plus a same-named note, so this is a question about
 * the folder — and the folder's own note is not one of its children, because
 * `walk` lifts that note off the file list and onto the folder.
 */
describe('folderWithNote', () => {
  const paths = (path: string) => {
    const folder = folderWithNote(root, path)
    return folder ? childrenOf(folder).map((file) => file.path) : []
  }

  it('answers with a folder’s children, subfolders first, by their own notes', () => {
    // `Areas/` holds one folder and no files, and it is named by its folder note —
    // which is the path a row in the tree would open.
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

  // A folder note nobody has typed in yet has no file on disk, but the row is
  // there and so are its children: `folderNoteRef`'s path is what the tree opens.
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

  // The folder itself, so the section can draw it with `FolderTree` and let a
  // subfolder in there expand.
  it('answers with the folder, not a list', () => {
    expect(folderWithNote(root, 'Areas/Areas.md')?.path).toBe('Areas')
  })
})

/**
 * **Following a note that has moved.**
 *
 * Renaming a note has to take its backlinks with it, or every link into it becomes
 * a link to a note waiting to be created. What is pinned here is that the *form* of
 * each link survives — a bare name stays a bare name, a path stays a path, and the
 * alias, the label and the anchor are the user's — and that a link is rewritten
 * because it **resolves** to the moved note, never because its text looks like it.
 */
describe('retargetLinks', () => {
  /** `Notes/Roadmap.md` renamed to `Notes/Plan.md`, which is the ordinary case. */
  const renamed = note('Notes/Plan.md')
  const moves = new Map([[pathKey('Notes/Roadmap.md'), renamed]])
  const follow = (text: string, from = 'Index.md') => retargetLinks(text, from, moves, index)

  it('rewrites a bare wikilink to the new name', () => {
    expect(follow('See [[Roadmap]] today.')).toBe('See [[Plan]] today.')
  })

  it('keeps a wikilink written as a path a path', () => {
    expect(follow('See [[Notes/Roadmap]].')).toBe('See [[Notes/Plan]].')
  })

  /** The alias is what the link is *called*; renaming the note does not rename it. */
  it('keeps the alias', () => {
    expect(follow('See [[Roadmap|the plan]].')).toBe('See [[Plan|the plan]].')
    expect(follow('See [[Notes/Roadmap|the plan]].')).toBe('See [[Notes/Plan|the plan]].')
  })

  /** The anchor names a heading *inside* the note, which is not what moved. */
  it('keeps an anchor', () => {
    expect(follow('See [[Roadmap#Q3]].')).toBe('See [[Plan#Q3]].')
    expect(follow('See [[Roadmap#Q3|later]].')).toBe('See [[Plan#Q3|later]].')
  })

  it('follows an embed, which is a stronger reference than a link', () => {
    expect(follow('![[Roadmap]]')).toBe('![[Plan]]')
  })

  /** A markdown destination is a path to a file, and `.md` stays if it was there. */
  it('rewrites a markdown destination, keeping the label and the extension', () => {
    expect(follow('See [the plan](Notes/Roadmap.md).')).toBe('See [the plan](Notes/Plan.md).')
    expect(follow('See [the plan](Notes/Roadmap).')).toBe('See [the plan](Notes/Plan).')
    expect(follow('See [x](/Notes/Roadmap.md).')).toBe('See [x](/Notes/Plan.md).')
  })

  /** The destination, not the label — which is the same word here, and the reason
   *  the replacement is anchored to where the target sits in the link. */
  it('leaves a label that reads like the destination alone', () => {
    expect(follow('See [Roadmap](Notes/Roadmap.md).')).toBe('See [Roadmap](Notes/Plan.md).')
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
   * **It resolves, it does not match text.** `Sleep` is two notes in this vault —
   * `Sleep.md` at the root and `Areas/Health/Sleep.md` — and a bare `[[Sleep]]`
   * means whichever is nearer the note holding it. So a rename of one must not
   * touch a link that meant the other.
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

  /** A folder rename moves every note under it, so a link to any of them follows —
   *  which is the reason this takes a map and not one pair. */
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

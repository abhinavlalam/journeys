import { describe, expect, it } from 'vitest'
import { folderNoteRef, isSamePath, knownPath, linkLabelSpan } from '../vaultModel'
import type { VaultFolder } from '../vaultModel'

/**
 * The operations on names and shapes, tested without a disk anywhere in sight —
 * which is the whole reason they live in `vaultModel.ts` and not in `vault.ts`.
 * These were in `vault.test.ts`, behind a mock of `@tauri-apps/plugin-fs` that
 * nothing here ever called.
 */

/**
 * The volume is case-insensitive but case-preserving, so two differently-cased
 * paths are one file. Comparing with `===` is what made a case-only rename trip an
 * "already exists" guard against itself.
 */
describe('whether two paths are one file', () => {
  it('answers on the lowercased path', () => {
    expect(isSamePath('Notes/Inbox.md', 'Notes/inbox.md')).toBe(true)
    expect(isSamePath('Notes/inbox.md', 'Notes/inbox.md')).toBe(true)
    expect(isSamePath('Notes/inbox.md', 'Notes/outbox.md')).toBe(false)
  })
})

const folder = (path: string, withNote: boolean): VaultFolder => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    path,
    absolutePath: `/v/${path}`,
    name,
    folders: [],
    files: [],
    note: withNote
      ? { path: `${path}/${name}.md`, absolutePath: `/v/${path}/${name}.md`, name }
      : undefined,
  }
}

/**
 * A folder note is created lazily, so this has to answer for a folder that does
 * not have one yet — the tree compares the selected path against it, and a folder
 * without a note on disk could otherwise never show as selected.
 */
describe('a folder’s own note', () => {
  it('is the note on disk when there is one', () => {
    expect(folderNoteRef(folder('Ideas', true)).path).toBe('Ideas/Ideas.md')
  })

  it('is the path one *would* have when there is not', () => {
    const ref = folderNoteRef(folder('Ideas', false))
    expect(ref.path).toBe('Ideas/Ideas.md')
    expect(ref.absolutePath).toBe('/v/Ideas/Ideas.md')
    expect(ref.name).toBe('Ideas')
  })
})

/**
 * The path a note is known by.
 *
 * A nested note is a folder plus a same-named note inside it, so
 * `Areas/Northwind` and `Areas/Northwind/Northwind.md` are one note under two
 * spellings — and only the first has a row anywhere in the app. Reported from the
 * running app: the `path:` property and the `[[` picker both showed the second.
 */
describe('the path a note is known by', () => {
  it('is the folder, for a folder’s own note', () => {
    expect(knownPath('Areas/Northwind/Northwind.md')).toBe('Areas/Northwind')
    expect(knownPath('Ideas/Ideas.md')).toBe('Ideas')
  })

  it('is the file, for every other note', () => {
    expect(knownPath('Areas/Northwind/Plan.md')).toBe('Areas/Northwind/Plan')
    expect(knownPath('Index.md')).toBe('Index')
  })

  // The volume is case-insensitive, so `ideas/Ideas.md` is a folder note too.
  it('reads the pairing the way the volume does', () => {
    expect(knownPath('ideas/Ideas.md')).toBe('ideas')
    expect(knownPath('Ideas/ideas.md')).toBe('Ideas')
  })

  /** A note named after its *grandparent* is not its folder's note: only the
   *  folder it actually sits in counts. */
  it('does not fold a name that matches a folder further up', () => {
    expect(knownPath('Ideas/Plans/Ideas.md')).toBe('Ideas/Plans/Ideas')
  })

  it('drops the extension either way, because a link never carries one', () => {
    expect(knownPath('Notes/Reading list.md')).toBe('Notes/Reading list')
    expect(knownPath('Notes/Reading list')).toBe('Notes/Reading list')
  })
})

/**
 * What a wikilink shows. One function because three renderers had answered it three
 * ways — the editor the name alone, a collection's page and its table the whole
 * target — so one link read two different ways in one app.
 */
describe('linkLabelSpan', () => {
  /** What the span picks out, which is what every caller but the editor wants. */
  const shown = (inner: string) => {
    const span = linkLabelSpan(inner)
    return inner.slice(span.from, span.to)
  }

  it('shows a link’s name, because a path is not a name', () => {
    expect(shown('Entities/Cafes/Bean Street/Lakeside Arrival')).toBe('Lakeside Arrival')
    expect(shown('Pingbird')).toBe('Pingbird')
  })

  it('shows an alias verbatim, because an alias is how a link gets a name', () => {
    expect(shown('Areas/Pingbird|the bird one')).toBe('the bird one')
    // A leading space is the writer's, and stays: the editor hides up to the pipe.
    expect(shown('Areas/Pingbird| Bird')).toBe(' Bird')
  })

  it('shows the last n names for |!n, and every name for a bare |!', () => {
    const target = 'Entities/Cafes/Bean Street/Lakeside Arrival'
    expect(shown(`${target}|!1`)).toBe('Lakeside Arrival')
    expect(shown(`${target}|!2`)).toBe('Bean Street/Lakeside Arrival')
    expect(shown(`${target}|!3`)).toBe('Cafes/Bean Street/Lakeside Arrival')
    expect(shown(`${target}|!`)).toBe(target)
    // Space around the marker is still the marker.
    expect(shown(`${target}| !2 `)).toBe('Bean Street/Lakeside Arrival')
  })

  it('clamps a count past the path rather than failing', () => {
    expect(shown('Areas/Pingbird|!9')).toBe('Areas/Pingbird')
    expect(shown('Pingbird|!4')).toBe('Pingbird')
    // `!0` is not nothing: a link always shows at least its own name.
    expect(shown('Areas/Pingbird|!0')).toBe('Pingbird')
  })

  /**
   * The marker is a *depth*, not an alias, and only an exact `!n` is one — so a
   * note aliased `!important` keeps its alias and is not read as a count.
   */
  it('reads anything else after the pipe as the alias it is', () => {
    expect(shown('Areas/Pingbird|!important')).toBe('!important')
    expect(shown('Areas/Pingbird|2')).toBe('2')
    expect(shown('Areas/Pingbird|!2 birds')).toBe('!2 birds')
  })
})

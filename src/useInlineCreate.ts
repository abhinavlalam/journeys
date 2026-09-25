import { useState } from 'react'
import { createLockedNote, createNote } from './vault'
import { noteName } from './vaultModel'
import type { VaultFile } from './vaultModel'
import type { InlineCreate } from './FolderTree'
import type { useVault } from './useVault'

/**
 * Where a new note is going, and **which tree asked**. `convert` is set while its
 * folder does not exist yet: the note that will become one, if a name is committed.
 *
 * `owner` is there because two panes draw the same tree — the left pane's, and the
 * *Inside* section at the end of a nested note, which is `FolderTree` with the same
 * props. Both rendered the field, both autofocused it, the second blurred the first,
 * and a create abandons on blur: pressing `+` on a folder whose own note was open
 * opened a field and cancelled it in the same breath. A field belongs to the tree
 * the press happened in.
 */
type CreateTarget = { parentPath: string; convert?: VaultFile; owner: string; locked?: boolean } | null

/**
 * Naming a new note in place — the field under a row that the tree's `+` opens.
 *
 * There is one kind of creation. A note with notes in it is a nested note, and
 * that is a state it is in rather than a thing to pick, so nothing here asks.
 * `App` owns the field because the `+` that starts it is in the header and the
 * field that finishes it is in the pane; `onStart` is what it does to the *other*
 * fields when this one opens — one box at a time.
 */
export function useInlineCreate({
  vault,
  openNote,
  onCreated,
  onConvert,
  onStart,
  setError,
}: {
  vault: ReturnType<typeof useVault>
  openNote: (file: VaultFile) => Promise<void>
  /** **Everything a new note is given** — its `path:`, an inherited icon. `App`
   *  owns it, because a note is made in three places and all three must do it. */
  onCreated: (file: VaultFile) => Promise<void>
  /** Turns a plain note into a nested one, with everything that follows from it. */
  onConvert: (file: VaultFile, vaultPath: string) => Promise<VaultFile>
  onStart: () => void
  setError: (message: string | null) => void
}) {
  const [target, setTarget] = useState<CreateTarget>(null)
  const [name, setName] = useState('')
  /**
   * **A locked note is asked for its passphrase twice, in the name's own field.**
   * Null while the name is being typed; then what is being typed, and the first
   * answer once there is one. Twice, because there is no recovery: a slip of the
   * finger here is a note nobody can open. Held for the question and nowhere else.
   */
  const [phrase, setPhrase] = useState<{ typed: string; first: string | null } | null>(null)

  /**
   * **Asking again is not a reason to start over.** Pressing the same `+` a second
   * time reopened the field on an empty name — the press blurred the one that was
   * up, which for a *create* abandons, and the handler then made a fresh one. So
   * the half-typed name was gone and the box flickered. Reported from the running
   * app. The `+` holds the focus on mousedown (see `FolderTree`), and this declines
   * when the field is already asking the same question.
   */
  const asking = (next: NonNullable<CreateTarget>) =>
    target?.parentPath === next.parentPath &&
    target.convert?.path === next.convert?.path &&
    Boolean(target.locked) === Boolean(next.locked)

  function open(next: NonNullable<CreateTarget>) {
    if (asking(next)) return
    onStart()
    setName('')
    setPhrase(null)
    setTarget(next)
  }

  function close() {
    setTarget(null)
    setPhrase(null)
  }

  async function submitLocked() {
    const typed = name.trim()
    if (!typed || !vault.vaultPath) return
    if (!phrase) return setPhrase({ typed: '', first: null })
    if (!phrase.typed) return
    if (phrase.first === null) return setPhrase({ typed: '', first: phrase.typed })
    if (phrase.typed !== phrase.first) {
      setError('The two passphrases differ. Type it again.')
      return setPhrase({ typed: '', first: null })
    }
    close()
    setError(null)
    try {
      // No `onCreated`: a locked note is its owner's alone, so nothing is written
      // into it — not a `path:`, not an inherited icon.
      const created = await createLockedNote(vault.vaultPath, typed, phrase.typed)
      await vault.refresh(vault.vaultPath)
      await openNote(created)
    } catch (err) {
      setError(String(err))
    }
  }

  async function submit() {
    if (target?.locked) return submitLocked()
    const asked = target
    const typed = name.trim()
    close()
    if (!asked || !vault.vaultPath || !typed) return
    setError(null)
    try {
      // **Nothing happens on disk until a name is committed.** Converting on the
      // click left an empty nested note behind every `+` somebody thought better
      // of — a folder holding only its own note, drawn with an arrow as though it
      // were full. The folder first, when the note going in is the one being given
      // children.
      // `App`'s, because everything holding the old path has to follow it — the
      // buffer, the tab, the note's own `path:` — and a second caller of this
      // (a file dropped on a plain note) must do all of it too.
      if (asked.convert) await onConvert(asked.convert, vault.vaultPath)
      const created = await createNote(vault.vaultPath, asked.parentPath, typed)
      // Not `writePathProperty` alone: what a new note is given is `App`'s to say,
      // and all three ways of making one now say the same thing.
      await onCreated(created)
      await vault.refresh(vault.vaultPath)
      await openNote(created)
    } catch (err) {
      setError(String(err))
    }
  }

  const create: InlineCreate | null = target && {
    parentPath: target.parentPath,
    owner: target.owner,
    insideNote: target.convert?.path,
    secret: phrase
      ? phrase.first === null
        ? { placeholder: 'Passphrase…', label: `Passphrase for ${name.trim()}` }
        : { placeholder: 'Passphrase again…', label: `Passphrase again for ${name.trim()}` }
      : undefined,
    value: phrase ? phrase.typed : name,
    onChange: phrase ? (typed) => setPhrase({ ...phrase, typed }) : setName,
    onSubmit: () => void submit(),
    onCancel: close,
  }

  return {
    /** The field, for the tree to draw under its row — or nothing. */
    create,
    /** Ask for a name inside `parentPath`, `''` being the vault itself. `owner` is
     *  the tree that asked — see `CreateTarget`. */
    start: (parentPath: string, owner = 'tree') => open({ parentPath, owner }),
    /** A note inside a note that has no folder yet: converted when the name lands. */
    startInside: (file: VaultFile, owner = 'tree') =>
      open({ parentPath: noteName(file.path), convert: file, owner }),
    /** A locked note, at the top of the vault — see `createLockedNote`. */
    startLocked: () => open({ parentPath: '', owner: 'tree', locked: true }),
    cancel: close,
  }
}

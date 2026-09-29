import { useState } from 'react'
import { createLockedNote, createNote } from './vault'
import { noteName } from './vaultModel'
import type { VaultFile } from './vaultModel'
import type { InlineCreate } from './FolderTree'
import type { useVault } from './useVault'

/**
 * Where a new note is going, and which tree asked. `convert` is set while
 * its folder does not exist yet: the note that will become one if a name
 * is committed. `owner` matters because two trees draw the same rows (the
 * left pane's and a nested note's Inside section). Both drew the field,
 * the second blurred the first, and a create abandons on blur.
 */
type CreateTarget = { parentPath: string; convert?: VaultFile; owner: string; locked?: boolean } | null

/**
 * Naming a new note in place, in the field the tree's `+` opens. A note with
 * notes in it is a nested note, a state it gets into, so nothing asks which kind.
 * `App` owns the field. `onStart` closes the other fields when this one opens.
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
  /**
   * Everything a new note is given: its `path::` and an inherited
   * icon. `App` owns it, since notes are made in three places.
   */
  onCreated: (file: VaultFile) => Promise<void>
  /** Turns a plain note into a nested one, with everything that follows. */
  onConvert: (file: VaultFile, vaultPath: string) => Promise<VaultFile>
  onStart: () => void
  setError: (message: string | null) => void
}) {
  const [target, setTarget] = useState<CreateTarget>(null)
  const [name, setName] = useState('')
  /**
   * A locked note asks for its passphrase twice, in the name's own field. Null while
   * the name is typed; then the text being typed and the first answer once given.
   * Twice, since a typo here is a note no one can open. Held only for the question.
   */
  const [phrase, setPhrase] = useState<{ typed: string; first: string | null } | null>(null)

  /**
   * Asking the same question again keeps the field. Pressing the same `+` twice
   * blurred the field, which abandons a create, and the name typed so far was lost.
   * The `+` keeps focus on mousedown (see `FolderTree`), and this refuses a repeat.
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
      // No `onCreated`: nothing is written into a locked note,
      // not a `path::` or an icon.
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
      // Nothing is written until a name is committed. Converting on
      // the click left an empty nested note behind every cancelled
      // `+`. The folder first, when the note is being given children.
      //
      // `App` converts, since everything holding the old path must follow
      // (buffer, tab, `path::`), and a file dropped on a note needs the same.
      if (asked.convert) await onConvert(asked.convert, vault.vaultPath)
      const created = await createNote(vault.vaultPath, asked.parentPath, typed)
      // Through `App`, so all three ways of making a note give it the same things.
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
    /** The field, for the tree to draw under its row, or nothing. */
    create,
    /**
     * Ask for a name inside `parentPath` (`''` is the vault).
     * `owner` is the tree that asked; see `CreateTarget`.
     */
    start: (parentPath: string, owner = 'tree') => open({ parentPath, owner }),
    /** A note inside a note with no folder yet: converted when the name lands. */
    startInside: (file: VaultFile, owner = 'tree') =>
      open({ parentPath: noteName(file.path), convert: file, owner }),
    /** A locked note at the top of the vault; see `createLockedNote`. */
    startLocked: () => open({ parentPath: '', owner: 'tree', locked: true }),
    cancel: close,
  }
}

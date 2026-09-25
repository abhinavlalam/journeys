import { importFile, moveFile, moveFolder } from './vault'
import { folderOf, type VaultFile, type VaultFolder } from './vaultModel'
import type { useRelocation } from './useRelocation'
import type { useVault } from './useVault'
import { useWindowEvent } from './useWindowEvent'

type Relocation = ReturnType<typeof useRelocation>

/**
 * **What is dropped onto the tree**: files from outside, copied into a folder or
 * into a plain note (which converts it), and one of the vault's own notes dropped
 * on a plain note, which goes inside it. And a file dropped anywhere else, which
 * does nothing at all.
 */
export function useDrops({
  vault,
  convertNote,
  relocateFile,
  relocateFolder,
  setError,
}: {
  vault: ReturnType<typeof useVault>
  /** Turns a plain note into a nested one, with everything that follows it. */
  convertNote: (file: VaultFile, vaultPath: string) => Promise<VaultFile>
  relocateFile: Relocation['relocateFile']
  relocateFolder: Relocation['relocateFolder']
  setError: (message: string | null) => void
}) {
  /** The copy itself, inside a mutation the caller owns — two callers now, and the
   *  refresh and the report belong to one of them rather than to each. */
  async function copyInto(vaultPath: string, to: string, files: readonly File[]) {
    /** Already there, and left alone — not a failure. */
    const there: string[] = []
    /**
     * **And what actually went wrong, said as itself.** These two were one list
     * once, so a copy that *failed* was reported as one that was already there:
     * `fs:allow-write-file` was missing from the capability, every write was
     * refused, and the app said the file was in the vault when nothing was. A
     * message that names the wrong cause is worse than no message — it sends you
     * looking in Finder for a file that was never written.
     */
    const failed: string[] = []
    for (const file of files) {
      try {
        const made = await importFile(vaultPath, to, file.name, new Uint8Array(await file.arrayBuffer()))
        if (!made) there.push(file.name)
      } catch (err: unknown) {
        failed.push(`${file.name} (${String(err)})`)
      }
    }
    return { there, failed }
  }

  /** What the copy has to say for itself, once the tree has been read again. */
  function sayHowItWent({ there, failed }: { there: string[]; failed: string[] }) {
    const said: string[] = []
    if (there.length > 0) {
      const many = there.length > 1
      said.push(
        `${there.join(', ')} ${many ? 'are' : 'is'} already here, so nothing was copied over ${many ? 'them' : 'it'}.`
      )
    }
    if (failed.length > 0) said.push(`Could not copy ${failed.join(', ')}.`)
    if (said.length > 0) setError(said.join(' '))
  }

  /** Files dropped on a folder, or on the tree itself. */
  async function importFiles(files: readonly File[], to: string) {
    let outcome = { there: [] as string[], failed: [] as string[] }
    await vault.mutate(
      async (v) => {
        outcome = await copyInto(v, to, files)
      },
      () => sayHowItWent(outcome)
    )
  }

  /**
   * **Files dropped on a plain note**: it becomes a nested note and they go inside
   * it. A note with notes in it is a folder plus a same-named note, and that is a
   * state a note gets *into* rather than a kind it is — the `+` on a row already
   * says so for a typed name, and this says it for a file dragged in. One drop, one
   * conversion, one refresh.
   */
  async function importFilesInside(note: VaultFile, files: readonly File[]) {
    let outcome = { there: [] as string[], failed: [] as string[] }
    await vault.mutate(
      async (v) => {
        const moved = await convertNote(note, v)
        outcome = await copyInto(v, folderOf(moved.path), files)
      },
      () => sayHowItWent(outcome)
    )
  }

  /**
   * **A note dropped on a plain note goes inside it**, converting it on the way —
   * `importFilesInside` for one of the vault's own notes, and the same shape: the
   * conversion and the move are **one mutation**, so the tree is read once and
   * nothing is drawn with the target converted and the note still outside it. The
   * target's own following (buffer, tab, `path:`) is `convertNote`'s; the dragged
   * note's is the relocate callback every other move already uses, handed the move's
   * result after the refresh. Asked for as "I want to be able to move notes under any
   * other note; a note should just automatically convert."
   */
  function adoptFile(note: VaultFile, dragged: VaultFile) {
    return vault.mutate(async (v) => {
      const parent = await convertNote(note, v)
      return moveFile(dragged, v, folderOf(parent.path))
    }, relocateFile(dragged.path))
  }

  /** The same for a nested note — a folder with its own note — dragged onto a plain one. */
  function adoptFolder(note: VaultFile, dragged: VaultFolder) {
    return vault.mutate(async (v) => {
      const parent = await convertNote(note, v)
      return moveFolder(dragged, v, folderOf(parent.path))
    }, relocateFolder(dragged.path))
  }

  /**
   * **A file dropped anywhere else does nothing at all.**
   *
   * The webview's own answer to a dropped file is to *navigate to it* — the whole
   * app replaced by a PDF, with no way back but relaunching, which is what happened
   * to a file dragged at the left pane and missed. `preventDefault` on `dragover`
   * is what makes a drop possible at all, and on `drop` is what makes this one do
   * nothing; the tree's own targets stop the event before it reaches here.
   */
  const swallow = (event: DragEvent) => event.preventDefault()
  useWindowEvent('dragover', swallow)
  useWindowEvent('drop', swallow)

  return { importFiles, importFilesInside, adoptFile, adoptFolder }
}

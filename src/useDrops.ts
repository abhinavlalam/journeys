import { countOf } from './rows'
import { ensureFolder, importFile, moveFile, moveFolder, safeNewName } from './vault'
import { folderOf, type VaultFile, type VaultFolder } from './vaultModel'
import type { useRelocation } from './useRelocation'
import type { useVault } from './useVault'
import { useWindowEvent } from './useWindowEvent'

type Relocation = ReturnType<typeof useRelocation>
type Copied = { copied: string[]; there: string[]; failed: string[] }

/**
 * What is dropped onto the tree: files from outside, copied into a folder or
 * a plain note (which converts it); a vault note dropped on a plain note,
 * which goes inside it; and a file dropped anywhere else, which does nothing.
 */
export function useDrops({
  vault,
  convertNote,
  relocateFile,
  relocateFolder,
  setError,
}: {
  vault: ReturnType<typeof useVault>
  /** Turns a plain note into a nested one, with everything that follows. */
  convertNote: (file: VaultFile, vaultPath: string) => Promise<VaultFile>
  relocateFile: Relocation['relocateFile']
  relocateFolder: Relocation['relocateFolder']
  setError: (message: string | null) => void
}) {
  /**
   * The copy itself, inside a change the caller owns; the
   * refresh and the report are the caller's.
   */
  async function copyInto(vaultPath: string, to: string, files: readonly File[]) {
    setError(`Copying ${countOf(files.length, 'file')}…`)
    // The folder once, first: copies made together would each try to create it.
    if (to) await ensureFolder(vaultPath, to)
    const names = new Set<string>()
    // Together, not in turn: a file dragged from Drive downloads before it can be
    // read, and six small PDFs took 27 seconds one after another. Of two of one name
    // in a drop the first is copied and the second is already here, as in turn.
    const outcomes = await Promise.all(
      files.map(async (file) => {
        // As it is written: `a:b.pdf` and `a-b.pdf` are one file on disk.
        const name = (() => {
          try {
            return safeNewName(file.name).toLowerCase()
          } catch {
            return file.name.toLowerCase()
          }
        })()
        if (names.has(name)) return 'there'
        names.add(name)
        try {
          return (await importFile(vaultPath, to, file.name, new Uint8Array(await file.arrayBuffer()))) ? 'copied' : 'there'
        } catch (err: unknown) {
          return `${file.name} (${String(err)})`
        }
      })
    )
    const named = (kind: string) => files.filter((_, at) => outcomes[at] === kind).map((file) => file.name)
    return {
      copied: named('copied'),
      /** Already there and left alone. Not a failure. */
      there: named('there'),
      /**
       * What went wrong, said as itself. These were once one list, so when
       * every write was refused the app said the files were already there.
       */
      failed: outcomes.filter((one) => one !== 'copied' && one !== 'there'),
    }
  }

  /**
   * What the copy reports, once the tree is read again: what was copied too, since a
   * drop that said nothing until it was done looked like one that had not worked.
   */
  function sayHowItWent({ copied, there, failed }: Copied, to: string) {
    const said: string[] = []
    if (copied.length > 0) said.push(`Copied ${countOf(copied.length, 'file')} into ${to || 'the vault'}.`)
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
    let outcome: Copied = { copied: [], there: [], failed: [] }
    await vault.mutate(
      async (v) => {
        outcome = await copyInto(v, to, files)
      },
      () => sayHowItWent(outcome, to)
    )
  }

  /**
   * Files dropped on a plain note: it becomes a nested note and
   * they go inside. One drop, one conversion, one refresh.
   */
  async function importFilesInside(note: VaultFile, files: readonly File[]) {
    let outcome: Copied = { copied: [], there: [], failed: [] }
    await vault.mutate(
      async (v) => {
        const moved = await convertNote(note, v)
        outcome = await copyInto(v, folderOf(moved.path), files)
      },
      () => sayHowItWent(outcome, note.name)
    )
  }

  /**
   * A note dropped on a plain note goes inside it, converting it.
   * The conversion and the move are one change, so the tree is read
   * once. `convertNote` moves the target's buffer, tab and `path::`;
   * the dragged note follows through the usual relocate callback.
   */
  function adoptFile(note: VaultFile, dragged: VaultFile) {
    return vault.mutate(async (v) => {
      const parent = await convertNote(note, v)
      return moveFile(dragged, v, folderOf(parent.path))
    }, relocateFile(dragged.path))
  }

  /**
   * The same for a nested note (a folder with its own note) dragged onto a plain one.
   */
  function adoptFolder(note: VaultFile, dragged: VaultFolder) {
    return vault.mutate(async (v) => {
      const parent = await convertNote(note, v)
      return moveFolder(dragged, v, folderOf(parent.path))
    }, relocateFolder(dragged.path))
  }

  /**
   * A file dropped anywhere else does nothing. The webview's default is to open the
   * file in place of the app, with no way back but a relaunch. `preventDefault` on
   * `dragover` and `drop` stops that; the tree's own targets stop the event first.
   */
  const swallow = (event: DragEvent) => event.preventDefault()
  useWindowEvent('dragover', swallow)
  useWindowEvent('drop', swallow)

  return { importFiles, importFilesInside, adoptFile, adoptFolder }
}

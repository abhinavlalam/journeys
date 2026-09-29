import { importFile, moveFile, moveFolder } from './vault'
import { folderOf, type VaultFile, type VaultFolder } from './vaultModel'
import type { useRelocation } from './useRelocation'
import type { useVault } from './useVault'
import { useWindowEvent } from './useWindowEvent'

type Relocation = ReturnType<typeof useRelocation>

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
    /** Already there and left alone. Not a failure. */
    const there: string[] = []
    /**
     * What went wrong, said as itself. These were once one list, so when
     * every write was refused the app said the files were already there.
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

  /** What the copy reports, once the tree is read again. */
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
   * Files dropped on a plain note: it becomes a nested note and
   * they go inside. One drop, one conversion, one refresh.
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

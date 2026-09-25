import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * **Every source file is text to every tool that reads it.** A literal NUL in a
 * `.ts` file compiles, and makes `grep` take the file for binary and answer nothing
 * for it: `actions.ts` held four as sentinels, so the scan for the vault's names
 * that CLAUDE.md asks for passed over the one file that quotes a journal. Written
 * as `\u0000` it is the same character to the code.
 */
describe('the source', () => {
  it('holds no NUL byte', () => {
    const roots = ['../', '../../src-tauri/src/'].map((dir) => new URL(dir, import.meta.url))
    const holding = roots.flatMap((root) =>
      (readdirSync(root, { recursive: true }) as string[]).filter(
        (path) => /\.(ts|tsx|css|rs)$/.test(path) && readFileSync(new URL(path, root)).includes(0)
      )
    )
    expect(holding).toEqual([])
  })
})

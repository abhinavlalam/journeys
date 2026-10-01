import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Every source file is text to every tool. A literal NUL in a `.ts` file
 * compiles, but makes `grep` treat the file as binary: one file held four
 * as markers, so the scan for vault names skipped the one file that quoted
 * a journal. Written as `\u0000` it is the same character to the code.
 */
describe('the source', () => {
  // Reads every source file: slow on a synced folder under a full run, past the 5s default.
  it('holds no NUL byte', { timeout: 30000 }, () => {
    const roots = ['../', '../../src-tauri/src/'].map((dir) => new URL(dir, import.meta.url))
    const holding = roots.flatMap((root) =>
      (readdirSync(root, { recursive: true }) as string[]).filter(
        (path) => /\.(ts|tsx|css|rs)$/.test(path) && readFileSync(new URL(path, root)).includes(0)
      )
    )
    expect(holding).toEqual([])
  })
})

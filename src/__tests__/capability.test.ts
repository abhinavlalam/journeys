import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * **A `**` scope does not reach a dot.**
 *
 * `tauri-plugin-fs` defaults `requireLiteralLeadingDot` to *true* on Unix, so every
 * `{"path": "**"}` in the capability stops at `.config` — the vault's own
 * configuration folder, which the app writes on first open and reads on every one
 * after. It fails at runtime only, and quietly: the first build wrote nothing at
 * all, and the Actions pane's Config group came up empty for a whole round because
 * `readDir` was refused and the listing swallowed it.
 *
 * CLAUDE.md said no test could see this, on the reasoning that the fake disk has no
 * scope. That is true of the *behaviour* — but the capability is a JSON file, and
 * "every filesystem permission this app uses names `.config` as well" is a fact
 * about that file. This is that fact.
 */
describe('the filesystem capability', () => {
  const capability = JSON.parse(
    readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8')
  ) as { permissions: (string | { identifier: string; allow?: { path: string }[] })[] }

  const scoped = capability.permissions.filter(
    (entry): entry is { identifier: string; allow?: { path: string }[] } =>
      typeof entry !== 'string' && entry.identifier.startsWith('fs:')
  )

  it('names every dot folder it reads, in every scope that reaches the vault', () => {
    expect(scoped.length).toBeGreaterThan(0)
    for (const permission of scoped) {
      const paths = (permission.allow ?? []).map((entry) => entry.path)
      // `**` alone is the bug: it matches every path in the vault except the one
      // the app keeps its own files in.
      expect(paths, permission.identifier).toContain('**')
      expect(paths, permission.identifier).toContain('**/.config')
      expect(paths, permission.identifier).toContain('**/.config/**')
      // `.claude` holds the vault's skills, which the Actions pane lists. Same
      // rule, same silence when it is missing: `readDir` answers nothing.
      expect(paths, permission.identifier).toContain('**/.claude')
      expect(paths, permission.identifier).toContain('**/.claude/**')
    }
  })
})

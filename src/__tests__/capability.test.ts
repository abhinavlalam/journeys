import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A `**` scope does not reach a dot. The fs plugin sets `requireLiteralLeadingDot` on
 * Unix, so every `{"path": "**"}` stops at `.config`, the vault's own config folder. It
 * fails only at runtime and quietly: the first build wrote nothing, and Config showed
 * empty because `readDir` was refused and the error swallowed. The capability is a JSON
 * file, so "every filesystem permission also names `.config`" can be checked.
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
      // `**` alone is the bug: it matches every path in the
      // vault except the app's own folder.
      expect(paths, permission.identifier).toContain('**')
      expect(paths, permission.identifier).toContain('**/.config')
      expect(paths, permission.identifier).toContain('**/.config/**')
      // `.claude` holds the vault's skills, which the Actions pane
      // lists. The same rule and the same silence when missing.
      expect(paths, permission.identifier).toContain('**/.claude')
      expect(paths, permission.identifier).toContain('**/.claude/**')
    }
  })
})

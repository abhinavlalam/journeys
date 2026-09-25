import { describe, expect, it } from 'vitest'
import {
  clearKeyCache,
  decryptNote,
  encryptNote,
  followUnlocked,
  lock,
  lockAll,
  passphraseFor,
  remember,
  saltOf,
  DamagedFileError,
  WrongPassphraseError,
} from '../crypto'
import { isEncrypted, isNote, noteName } from '../vaultModel'

const PW = 'correct horse battery staple'

/** An armored note with its header lines replaced, for the malformed-file cases. */
async function damaged(edit: (lines: string[]) => string[]): Promise<string> {
  return edit((await encryptNote('secret', PW)).split('\n')).join('\n')
}

describe('note encryption', () => {
  it('round-trips and leaks no plaintext', async () => {
    const secret = '# Private\n\nSalary is 123456.\n+expense 450 lunch\n'
    const armored = await encryptNote(secret, PW)
    expect(armored.startsWith('JOURNEYS-ENC-V1')).toBe(true)
    expect(armored.split('\n')[1]).toBe('pbkdf2-sha256:600000')
    for (const fragment of ['Salary','123456','+expense']) expect(armored).not.toContain(fragment)
    expect(await decryptNote(armored, PW)).toBe(secret)
  })

  it('rejects a wrong passphrase', async () => {
    const armored = await encryptNote('x', PW)
    await expect(decryptNote(armored, 'wrong')).rejects.toBeInstanceOf(WrongPassphraseError)
  })

  // GCM authenticates: tampering must fail loudly rather than return garbage.
  it('detects tampering', async () => {
    const lines = (await encryptNote('x', PW)).split('\n')
    const bytes = [...atob(lines[4])]
    bytes[5] = String.fromCharCode(bytes[5].charCodeAt(0) ^ 1)
    lines[4] = btoa(bytes.join(''))
    await expect(decryptNote(lines.join('\n'), PW)).rejects.toBeInstanceOf(WrongPassphraseError)
  })

  // Two PBKDF2 derivations at the real iteration count: 8.7s under a loaded suite,
  // against vitest's 5s default. The assertion judges; the runner stays out of it.
  it('never produces identical ciphertext for identical input', { timeout: 60000 }, async () => {
    expect(await encryptNote('same', PW)).not.toBe(await encryptNote('same', PW))
  })

  it('handles empty and unicode content', async () => {
    expect(await decryptNote(await encryptNote('', PW), PW)).toBe('')
    const u = 'héllo 🔒 日本'
    expect(await decryptNote(await encryptNote(u, PW), PW)).toBe(u)
  })

  /** Both spellings: `.enc` is what this app asks for and `.enc.md` is what v1
   *  wrote, and a file already in a vault has to keep opening. The name a row shows
   *  is `noteName`'s answer — one function for every extension a note wears. */
  it('knows one when it sees it, whichever way it is spelled', () => {
    expect(noteName('Private.enc.md')).toBe('Private')
    expect(noteName('Private.enc')).toBe('Private')
    expect(isEncrypted('Areas/Private.enc')).toBe(true)
    expect(isEncrypted('Areas/Private.enc.md')).toBe(true)
    expect(isEncrypted('Areas/Private.md')).toBe(false)
    expect(isEncrypted('encoder.md')).toBe(false)
    // And neither spelling is a note: no note machinery reads one or writes into it.
    expect(isNote('Areas/Private.enc.md')).toBe(false)
    expect(isNote('Areas/Private.enc')).toBe(false)
    expect(isNote('Areas/Private.md')).toBe(true)
  })

  /**
   * **The passphrase is remembered for the window and nowhere else.** `vault.ts`
   * asks for it on every read and every write — that is what lets the buffer, the
   * editor and the autosave stay ignorant of encryption — and a vault change locks
   * everything again.
   */
  it('remembers a passphrase per path, follows a move, and locks on demand', () => {
    remember('Areas/Private.enc', PW)
    expect(passphraseFor('Areas/Private.enc')).toBe(PW)
    expect(passphraseFor('Areas/Other.enc')).toBeNull()

    followUnlocked('Areas/Private.enc', 'Private.enc')
    expect(passphraseFor('Areas/Private.enc')).toBeNull()
    expect(passphraseFor('Private.enc')).toBe(PW)

    // One note locks and the rest stay open.
    remember('Other.enc', PW)
    lock('Private.enc')
    expect(passphraseFor('Private.enc')).toBeNull()
    expect(passphraseFor('Other.enc')).toBe(PW)

    lockAll()
    expect(passphraseFor('Other.enc')).toBeNull()
  })
})

// A damaged file and a wrong passphrase are different situations with different
// remedies, and only one of them is the user's to fix. Secure/ is Drive-synced, so
// half a file is a real shape; "wrong passphrase" sent people to retype a passphrase
// that was never wrong.
describe('damaged files', () => {
  // The count is plain text in the file and PBKDF2 runs on the main thread: 600
  // million rounds measured ~45s of frozen window, on *selecting* the note.
  it('refuses an absurd iteration count without deriving it', async () => {
    const file = await damaged((l) => [l[0], 'pbkdf2-sha256:600000000', ...l.slice(2)])
    const t0 = performance.now()
    await expect(decryptNote(file, PW)).rejects.toBeInstanceOf(DamagedFileError)
    expect(performance.now() - t0).toBeLessThan(100)
  })

  // Number() takes exponent notation, so a short header can still ask for billions.
  it('refuses an exponent-notation count', async () => {
    await expect(decryptNote(await damaged((l) => [l[0], 'pbkdf2-sha256:1e9', ...l.slice(2)]), PW))
      .rejects.toBeInstanceOf(DamagedFileError)
  })

  // The ceiling is inclusive: 10M rounds is ~730ms — slow, not absurd — so this file
  // reaches decryption and fails there on the passphrase, which is what proves it.
  it('still derives at the ceiling and at the honest 600k', async () => {
    await expect(decryptNote(await damaged((l) => [l[0], 'pbkdf2-sha256:10000000', ...l.slice(2)]), PW))
      .rejects.toBeInstanceOf(WrongPassphraseError)
    expect(await decryptNote(await encryptNote('x', PW), PW)).toBe('x')
    // Explicit, because this is the one test in the suite whose cost is a
    // deliberate 10M PBKDF2 rounds rather than anything it could be waiting on.
    // It measures 1.2–1.7s idle; under the loaded suite it has overrun the 5s
    // default and reported as a flake, which it is not.
  }, 30000)

  it('reports a truncated file as damaged, not as a wrong passphrase', async () => {
    const file = await damaged((l) => l.slice(0, 4))
    await expect(decryptNote(file, PW)).rejects.toBeInstanceOf(DamagedFileError)
    await expect(decryptNote(file, PW)).rejects.not.toBeInstanceOf(WrongPassphraseError)
  })

  it('reports a half-written ciphertext as damaged', async () => {
    await expect(decryptNote(await damaged((l) => [...l.slice(0, 4), btoa('abc'), '']), PW))
      .rejects.toBeInstanceOf(DamagedFileError)
  })

  // atob throws a DOMException, which App.tsx has no case for and showed raw.
  it('reports an undecodable header field as damaged', async () => {
    for (const line of [2, 3, 4]) {
      const file = await damaged((l) => l.map((text, i) => (i === line ? '!!! not base64 !!!' : text)))
      await expect(decryptNote(file, PW)).rejects.toBeInstanceOf(DamagedFileError)
    }
  })

  it('keeps the unrelated header failures as they were', async () => {
    await expect(decryptNote('', PW)).rejects.toThrow('Not an encrypted Journeys note.')
    await expect(decryptNote(await damaged((l) => [l[0], 'pbkdf2-sha256:abc', ...l.slice(2)]), PW))
      .rejects.toThrow('Malformed iteration count.')
  })
})

// Deriving a key is 600k PBKDF2 rounds; the cache must speed that up without
// weakening anything.
describe('key cache', () => {
  it('reuses a salt without repeating the IV', async () => {
    const first = await encryptNote('one', PW)
    const salt = saltOf(first)!
    const second = await encryptNote('two', PW, salt)
    expect(saltOf(second)).toEqual(salt)
    expect(await decryptNote(second, PW)).toBe('two')

    const a = await encryptNote('same', PW, salt)
    const b = await encryptNote('same', PW, salt)
    expect(a).not.toBe(b)
  })

  it('still rejects a wrong passphrase, cached or cleared', async () => {
    const armored = await encryptNote('x', PW)
    await decryptNote(armored, PW)
    await expect(decryptNote(armored, 'wrong')).rejects.toBeInstanceOf(WrongPassphraseError)
    clearKeyCache()
    expect(await decryptNote(armored, PW)).toBe('x')
  })

  it('is materially faster warm', async () => {
    const armored = await encryptNote('x', PW)
    clearKeyCache()
    const t0 = performance.now(); await decryptNote(armored, PW); const cold = performance.now() - t0
    const t1 = performance.now(); await decryptNote(armored, PW); const warm = performance.now() - t1
    expect(warm).toBeLessThan(cold / 3)
  })
})

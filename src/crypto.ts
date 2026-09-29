// AES-256-GCM and PBKDF2-SHA256 via `crypto.subtle`. Ciphertext on disk is what keeps
// Drive and the `claude` CLI from reading a note; ignore files are only advice. PBKDF2
// is not memory-hard like Argon2id, so the passphrase's strength does the work.

const MAGIC = 'JOURNEYS-ENC-V1'
const KDF = 'pbkdf2-sha256'
const ITERATIONS = 600_000
// The file states its iteration count, and PBKDF2 runs on the main thread in time
// to that count: 600k is 43ms, 10M is 730ms, 600M about 45s of frozen window, paid
// on selecting the note. One flipped digit in a synced file could do it, so the
// count is capped, not trusted. Room for about 16x more before this needs a look.
const MAX_ITERATIONS = 10_000_000
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Deriving a key is 600k iterations, hundreds of milliseconds. Cached so saves and
// focus do not pay it each time; cleared on lock, so no key outlives its passphrase.
const keyCache = new Map<string, CryptoKey>()

export function clearKeyCache() {
  keyCache.clear()
}

async function deriveKeyCached(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const id = `${iterations}:${toBase64(salt)}:${passphrase}`
  const hit = keyCache.get(id)
  if (hit) return hit
  const key = await deriveKey(passphrase, salt, iterations)
  keyCache.set(id, key)
  return key
}

/** The salt from a locked file, so a save can reuse it and hit the cache. */
export function saltOf(raw: string): Uint8Array | null {
  const line = raw.split('\n')[2]
  if (!line) return null
  try {
    return fromBase64(line)
  } catch {
    return null
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * The on-disk form. Line-based and self-describing, so the file
 * explains itself and the KDF settings can change later.
 */
export async function encryptNote(
  plaintext: string,
  passphrase: string,
  /**
   * Reuse the file's salt so the key stays cached across saves.
   * Safe, since the IV is new each time: with AES-GCM it is IV
   * reuse under one key that breaks it, not salt reuse.
   */
  reuseSalt?: Uint8Array | null
): Promise<string> {
  const salt = reuseSalt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKeyCached(passphrase, salt, ITERATIONS)

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext)
  )

  return [
    MAGIC,
    `${KDF}:${ITERATIONS}`,
    toBase64(salt),
    toBase64(iv),
    toBase64(new Uint8Array(ciphertext)),
    '',
  ].join('\n')
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase, or this file has been altered.')
  }
}

/**
 * Damage found before any key is derived. Apart from `WrongPassphraseError`
 * because only that one is the owner's to fix: a truncated file used to say
 * wrong passphrase, and retyping never cleared it.
 */
export class DamagedFileError extends Error {
  constructor(detail: string) {
    super(`This encrypted note is damaged or incomplete: ${detail}`)
  }
}

/**
 * Decodes one header field. Anything unusable is damage;
 * `atob`'s own error does not escape.
 */
function decodeField(line: string | undefined, what: string, minBytes: number): Uint8Array {
  let bytes: Uint8Array | null = null
  try {
    bytes = fromBase64((line ?? '').trim())
  } catch {
    throw new DamagedFileError(`its ${what} is not valid base64.`)
  }
  if (bytes.length < minBytes) throw new DamagedFileError(`its ${what} is missing or too short.`)
  return bytes
}

export async function decryptNote(raw: string, passphrase: string): Promise<string> {
  const lines = raw.split('\n')
  if (lines[0]?.trim() !== MAGIC) throw new Error('Not an encrypted Journeys note.')

  const [kdf, iterationsText] = (lines[1] ?? '').split(':')
  if (kdf !== KDF) throw new Error(`Unsupported key derivation: ${kdf}`)
  const iterations = Number(iterationsText)
  if (!Number.isInteger(iterations) || iterations <= 0) throw new Error('Malformed iteration count.')
  if (iterations > MAX_ITERATIONS)
    throw new DamagedFileError(
      `it declares an unreasonable key-derivation cost of ${iterations} rounds (the limit is ${MAX_ITERATIONS}).`
    )

  const salt = decodeField(lines[2], 'salt', SALT_BYTES)
  const iv = decodeField(lines[3], 'IV', IV_BYTES)
  const ciphertext = decodeField(lines[4], 'ciphertext', TAG_BYTES)
  const key = await deriveKeyCached(passphrase, salt, iterations)

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    // A GCM check failure looks the same as a wrong passphrase,
    // which is what makes it useful.
    throw new WrongPassphraseError()
  }
}

// ---------------------------------------------------------------------------
// What is unlocked, for as long as the window is open
// ---------------------------------------------------------------------------
//
// Passphrases live here and nowhere else: not in `localStorage`, the vault's
// config or a note. Closing the window locks every note. Module state, not a hook,
// because `vault.ts` reads and writes locked notes, and a save queued from a key
// press must find the passphrase without a render.

const unlocked = new Map<string, string>()

/** After a decryption has proved it. */
export function remember(path: string, passphrase: string) {
  unlocked.set(path, passphrase)
}

export function passphraseFor(path: string): string | null {
  return unlocked.get(path) ?? null
}

/** A renamed or moved file keeps its passphrase, so the next save still works. */
export function followUnlocked(from: string, to: string) {
  const held = unlocked.get(from)
  if (held !== undefined) {
    unlocked.delete(from)
    unlocked.set(to, held)
  }
}

/**
 * One note locks again, and its derived keys go too: a cached key is the
 * passphrase by another name. Other notes re-derive on their next save.
 */
export function lock(path: string) {
  unlocked.delete(path)
  clearKeyCache()
}

export function unlockedPaths(): string[] {
  return [...unlocked.keys()]
}

/** Switching vaults locks everything, and the derived keys go too. */
export function lockAll() {
  unlocked.clear()
  clearKeyCache()
}

/** Thrown by a read of a locked file: the caller should ask for the passphrase. */
export class LockedFileError extends Error {
  constructor(path: string) {
    super(`${path} is locked.`)
  }
}

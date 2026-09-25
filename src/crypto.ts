// AES-256-GCM + PBKDF2-SHA256 via crypto.subtle. Ciphertext at rest is what stops
// Drive, and the `claude` CLI, reading a note — ignore-files are only advisory.
// PBKDF2 isn't memory-hard like Argon2id, so passphrase strength carries the weight.

const MAGIC = 'JOURNEYS-ENC-V1'
const KDF = 'pbkdf2-sha256'
const ITERATIONS = 600_000
// The file states its own iteration count in plain text and PBKDF2 runs on the main
// thread, linear in that number: 600k is 43ms, 10M is 730ms, 600M is ~45s of frozen
// window — paid on *selecting* the note, before a passphrase is even asked for. A
// flipped digit in a Drive-synced file is enough to do it, so the header is capped
// rather than trusted. Room for ~16x hardening before this needs revisiting.
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

// Deriving a key is 600k PBKDF2 iterations — hundreds of milliseconds. Without a
// cache that cost is paid on every save and every window focus. Cleared on lock,
// so a derived key never outlives the passphrase it came from.
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

/** The salt from an encrypted file, so a re-save can reuse it and hit the cache. */
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
 * Produces the on-disk form. Deliberately line-based and self-describing so the
 * file explains itself to anyone (or anything) that opens it, and so the KDF
 * parameters can change later without guesswork.
 */
export async function encryptNote(
  plaintext: string,
  passphrase: string,
  /**
   * Reuse this file's existing salt so the derived key stays cached across saves.
   * Safe because the IV is fresh every time: with AES-GCM it is IV reuse under the
   * same key that is catastrophic, not salt reuse.
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
 * Structural damage, found before any key is derived. Kept apart from
 * `WrongPassphraseError` because only one of the two is the user's to fix: a
 * half-synced or truncated file used to report a wrong passphrase, and no amount
 * of retyping could ever clear it.
 */
export class DamagedFileError extends Error {
  constructor(detail: string) {
    super(`This encrypted note is damaged or incomplete: ${detail}`)
  }
}

/** Decodes one header field, treating anything unusable as damage rather than letting
 *  `atob`'s raw DOMException escape to the caller. */
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
    // GCM authentication failure is indistinguishable from a wrong passphrase,
    // which is exactly the property that makes it useful.
    throw new WrongPassphraseError()
  }
}

// ---------------------------------------------------------------------------
// What is unlocked, for as long as the window is open
// ---------------------------------------------------------------------------
//
// **Never written down.** The passphrase lives here and nowhere else: not in
// `localStorage`, not in the vault's config, not in a note. Closing the window is
// what locks a file again, which is the only promise this can honestly make.
//
// Here rather than in `App` because the read and the write are `vault.ts`'s — a
// locked file is read and written exactly like any other file, and everything
// between the editor and the disk is left not knowing the difference. That is also
// why this is module state and not a hook: a save queued from a keystroke has to
// find the passphrase without a render.

const unlocked = new Map<string, string>()

/** After a decryption has proved it. */
export function remember(path: string, passphrase: string) {
  unlocked.set(path, passphrase)
}

export function passphraseFor(path: string): string | null {
  return unlocked.get(path) ?? null
}

/** A file renamed or moved keeps what it had, so a save after either still lands. */
export function followUnlocked(from: string, to: string) {
  const held = unlocked.get(from)
  if (held !== undefined) {
    unlocked.delete(from)
    unlocked.set(to, held)
  }
}

/** One note locks again, and the derived keys go with it: a key left cached is
 *  the passphrase by another name. The others re-derive on their next save. */
export function lock(path: string) {
  unlocked.delete(path)
  clearKeyCache()
}

export function unlockedPaths(): string[] {
  return [...unlocked.keys()]
}

/** Switching vaults locks everything, and the derived keys go with it. */
export function lockAll() {
  unlocked.clear()
  clearKeyCache()
}

/** Thrown by a read of a locked file: the caller is being told to ask. */
export class LockedFileError extends Error {
  constructor(path: string) {
    super(`${path} is locked.`)
  }
}

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'
import { decryptNote, encryptNote, lockAll } from '../crypto'

/**
 * A locked note: `.enc` in the tree, a passphrase under its row, then a note like
 * any other. The seam is `vault.ts`: reading decrypts and writing re-encrypts, so
 * everything above gets plain text. Tested at that boundary: plaintext never
 * reaches the disk, and the question is asked instead of the file opening.
 */

/**
 * jsdom's `crypto` has no `subtle`: its own `crypto` object has only `getRandomValues`
 * and hides Node's, so every derive and decrypt threw here. This hands the test Node's.
 */
vi.hoisted(() => {
  const { webcrypto } = require('node:crypto') as { webcrypto: Crypto }
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  }
})

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

const PW = 'correct horse battery staple'
const SECRET = '# Private\n\nThe number is 123456.\n'

afterEach(() => {
  cleanup()
  lockAll()
})
beforeEach(async () => {
  resetFakeVault()
  rememberVault('/v')
  disk.write('/v/private.enc', await encryptNote(SECRET, PW))
})


const tree = () => document.querySelector('.file-list') as HTMLElement
const field = () => screen.queryByLabelText('Passphrase for private') as HTMLInputElement | null
const editor = () => screen.queryByTestId('editor') as HTMLTextAreaElement | null

describe('an encrypted file', () => {
  it('is in the tree, under its own name', async () => {
    await openApp()
    expect(within(tree()).getByText('private')).toBeTruthy()
  })

  /**
   * The question is asked where the file is, and nothing opens until it is answered.
   */
  it('asks for a passphrase instead of opening', async () => {
    await openApp()
    fireEvent.click(within(tree()).getByText('private'))

    await waitFor(() => expect(field()).toBeTruthy())
    expect(field()!.type).toBe('password')
    // Nothing is open behind the question.
    expect(editor()).toBeNull()
  })

  it('opens the note once the passphrase is right', async () => {
    await openApp()
    fireEvent.click(within(tree()).getByText('private'))
    await waitFor(() => expect(field()).toBeTruthy())

    fireEvent.change(field()!, { target: { value: PW } })
    fireEvent.keyDown(field()!, { key: 'Enter' })

    await waitFor(() => expect(editor()).toBeTruthy())
    expect(editor()!.value).toBe(SECRET)
    // And the question is gone.
    expect(field()).toBeNull()
  })

  /**
   * A wrong passphrase and a damaged file are different answers;
   * both keep the field open.
   */
  it('says so on a wrong passphrase and keeps asking', async () => {
    await openApp()
    fireEvent.click(within(tree()).getByText('private'))
    await waitFor(() => expect(field()).toBeTruthy())

    fireEvent.change(field()!, { target: { value: 'not it' } })
    fireEvent.keyDown(field()!, { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/passphrase/i))
    expect(field()).toBeTruthy()
    expect(editor()).toBeNull()
  })

  /**
   * The plaintext never lands on disk. The editor holds the note's text and the
   * file stays sealed, with a new IV each save and the same salt, so the derived
   * key stays cached and typing does not pay 600,000 PBKDF2 rounds per key.
   */
  it('writes ciphertext back, never the text you typed', async () => {
    await openApp()
    fireEvent.click(within(tree()).getByText('private'))
    await waitFor(() => expect(field()).toBeTruthy())
    fireEvent.change(field()!, { target: { value: PW } })
    fireEvent.keyDown(field()!, { key: 'Enter' })
    await waitFor(() => expect(editor()).toBeTruthy())

    const before = disk.read('/v/private.enc')
    fireEvent.change(editor()!, { target: { value: `${SECRET}and a new line\n` } })

    await waitFor(() => expect(disk.read('/v/private.enc')).not.toBe(before))
    const armoured = disk.read('/v/private.enc') ?? ''
    expect(armoured.startsWith('JOURNEYS-ENC-V1')).toBe(true)
    for (const fragment of ['123456', 'a new line', 'Private']) {
      expect(armoured).not.toContain(fragment)
    }
    // The same salt (line 3), a different IV (line 4).
    const wasLines = (before ?? '').split('\n')
    expect(armoured.split('\n')[2]).toBe(wasLines[2])
    expect(armoured.split('\n')[3]).not.toBe(wasLines[3])
  })

  /** Escape leaves the file as it was. */
  it('closes the question on Escape', async () => {
    await openApp()
    fireEvent.click(within(tree()).getByText('private'))
    await waitFor(() => expect(field()).toBeTruthy())
    fireEvent.keyDown(field()!, { key: 'Escape' })
    expect(field()).toBeNull()
    expect(editor()).toBeNull()
  })
})

/**
 * A locked note keeps its links, quietly. A rename rewrites every link to the moved
 * note, and a note no one unlocked cannot be read, which used to be reported on every
 * rename. A locked note is outside the rest of the app too (graph, backlinks, search),
 * so the message is kept for a note that is not locked and still could not be read.
 */
describe('renaming beside a locked note', () => {
  it('says nothing about it', async () => {
    await openApp()
    fireEvent.contextMenu(within(tree()).getByText('roadmap'))
    fireEvent.click(screen.getByText('Rename'))
    const name = document.querySelector('.rename-input') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'plan' } })
    fireEvent.keyDown(name, { key: 'Enter' })

    await waitFor(() => expect(disk.has('/v/plan.md')).toBe(true))
    // The note is still sealed on disk, and nothing was said.
    expect(disk.read('/v/private.enc')!.startsWith('# Private')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports one that is not locked and still cannot be read', async () => {
    disk.write('/v/unreadable.md', 'see [[roadmap]]\n')
    await openApp()
    // A note that exists, is not locked, and is refused on read (a sync
    // placeholder, a permissions error): a real failure, worth saying.
    disk.corrupt('/v/unreadable.md')

    fireEvent.contextMenu(within(tree()).getByText('roadmap'))
    fireEvent.click(screen.getByText('Rename'))
    const name = document.querySelector('.rename-input') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'plan' } })
    fireEvent.keyDown(name, { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unreadable.md'))
  })
})

/**
 * Unlocked is not shared. A note open in its own editor is still
 * its owner's alone: the vault read leaves it out, so search, tags
 * and the graph are built without it, and nothing writes into it.
 */
describe('an unlocked encrypted note', () => {
  async function unlock(name: string) {
    fireEvent.click(within(tree()).getByText(name))
    const ask = await screen.findByLabelText(`Passphrase for ${name}`)
    fireEvent.change(ask, { target: { value: PW } })
    fireEvent.keyDown(ask, { key: 'Enter' })
    await waitFor(() => expect(editor()).toBeTruthy())
  }

  it('is not found by search', async () => {
    await openApp()
    await unlock('private')
    // The vault is read again on focus, when an unlocked note would join
    // it; the plain note saying the same thing shows the read landed.
    disk.write('/v/roadmap.md', '# Roadmap\n\nThe number is 123456 here too.\n')
    fireEvent.focus(window)
    fireEvent.click(screen.getByLabelText('Search in notes'))
    fireEvent.change(screen.getByLabelText('Search notes'), { target: { value: '123456' } })

    expect(await screen.findByText('The number is 123456 here too.')).toBeTruthy()
    expect(screen.queryByText('The number is 123456.')).toBeNull()
  })

  /**
   * v1's `.enc.md` ends in `.md`, so it reached the note code: a
   * rename rewrote links inside it.
   */
  it('keeps its own links when the note they name is renamed', async () => {
    disk.write('/v/old.enc.md', await encryptNote('see [[roadmap]]\n', PW))
    await openApp()
    await unlock('old')

    fireEvent.contextMenu(within(tree()).getByText('roadmap'))
    fireEvent.click(screen.getByText('Rename'))
    const name = document.querySelector('.rename-input') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'plan' } })
    fireEvent.keyDown(name, { key: 'Enter' })

    await waitFor(() => expect(disk.has('/v/plan.md')).toBe(true))
    expect(await decryptNote(disk.read('/v/old.enc.md')!, PW)).toBe('see [[roadmap]]\n')
  })

  it('takes no property, so its ciphertext is never written as text', async () => {
    const sealed = await encryptNote(SECRET, PW)
    disk.write('/v/old.enc.md', sealed)
    const { vaultFileRef, writeNoteProperty } = await import('../vault')
    await writeNoteProperty(vaultFileRef('/v', 'old.enc.md'), 'icon', 'star')
    expect(disk.read('/v/old.enc.md')).toBe(sealed)
  })
})

/**
 * A note is locked from the moment it is made, or never. The lock beside the
 * Notes `+` asks for a name and the passphrase twice, in one field, and the first
 * bytes on disk are ciphertext; a plain copy synced once stays in the history.
 */
describe('a new locked note', () => {
  const typeInto = (label: string, value: string) => {
    const input = screen.getByLabelText(label) as HTMLInputElement
    fireEvent.change(input, { target: { value } })
    fireEvent.keyDown(input, { key: 'Enter' })
    return input
  }

  it('is written sealed, at the top, and opens without asking again', async () => {
    await openApp()
    // The one way in: the heading, never a folder's row.
    expect(screen.getAllByLabelText('New locked note')).toHaveLength(1)
    fireEvent.click(screen.getByLabelText('New locked note'))
    const named = document.querySelector('.rename-input') as HTMLInputElement
    fireEvent.change(named, { target: { value: 'Letters' } })
    fireEvent.keyDown(named, { key: 'Enter' })
    const first = typeInto('Passphrase for Letters', PW)
    expect(first.type).toBe('password')
    // One element throughout: a replaced field would lose the
    // keyboard, and a create gives up on blur.
    expect(first).toBe(named)
    typeInto('Passphrase again for Letters', PW)

    await waitFor(() => expect(editor()).toBeTruthy())
    expect(await decryptNote(disk.read('/v/Letters.enc')!, PW)).toBe('')
    expect(disk.has('/v/Letters.md')).toBe(false)

    fireEvent.change(editor()!, { target: { value: 'Dear nobody.\n' } })
    await waitFor(async () =>
      expect(await decryptNote(disk.read('/v/Letters.enc')!, PW)).toBe('Dear nobody.\n')
    )
    expect(disk.read('/v/Letters.enc')).not.toContain('Dear nobody')
  })

  it('asks again when the two passphrases differ, and writes nothing', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('New locked note'))
    const named = document.querySelector('.rename-input') as HTMLInputElement
    fireEvent.change(named, { target: { value: 'Letters' } })
    fireEvent.keyDown(named, { key: 'Enter' })
    typeInto('Passphrase for Letters', PW)
    typeInto('Passphrase again for Letters', 'correct horse battery stapler')

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('differ'))
    expect(screen.getByLabelText('Passphrase for Letters')).toBeTruthy()
    expect(disk.has('/v/Letters.enc')).toBe(false)
  })

  it('takes no name a note already has', async () => {
    await openApp()
    fireEvent.click(screen.getByLabelText('New locked note'))
    const named = document.querySelector('.rename-input') as HTMLInputElement
    fireEvent.change(named, { target: { value: 'roadmap' } })
    fireEvent.keyDown(named, { key: 'Enter' })
    typeInto('Passphrase for roadmap', PW)
    typeInto('Passphrase again for roadmap', PW)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('roadmap.md'))
    expect(disk.has('/v/roadmap.enc')).toBe(false)
  })
})

/**
 * Locking by hand: the typing is written sealed first, the tab
 * closes, and the note asks for its passphrase again.
 */
describe('locking a note by hand', () => {
  it('seals what was typed, closes it, and asks again', async () => {
    await openApp()
    fireEvent.click(within(tree()).getByText('private'))
    await waitFor(() => expect(field()).toBeTruthy())
    fireEvent.change(field()!, { target: { value: PW } })
    fireEvent.keyDown(field()!, { key: 'Enter' })
    await waitFor(() => expect(editor()).toBeTruthy())

    // Typed and not yet saved: locking writes it.
    fireEvent.change(editor()!, { target: { value: `${SECRET}and the last word\n` } })
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }))

    await waitFor(() => expect(editor()).toBeNull())
    expect(await decryptNote(disk.read('/v/private.enc')!, PW)).toBe(`${SECRET}and the last word\n`)
    fireEvent.click(within(tree()).getByText('private'))
    await waitFor(() => expect(field()).toBeTruthy())
  })

  it('is offered on a locked note only', async () => {
    await openApp()
    fireEvent.click(within(tree()).getByText('roadmap'))
    await waitFor(() => expect(editor()).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull()
  })
})

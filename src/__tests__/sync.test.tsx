/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'
import type { SyncStatus } from '../sync'
import { isOffline, useSync } from '../useSync'

/**
 * The sync from the app's side, over a mocked bridge: the Applications
 * row's sentence, a focus running a round in order (flush, commit,
 * pull, push), a pull's conflicts said once, and a folder that is not
 * a repository left alone. `sync.rs` tests what git does.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

const backedUp: SyncStatus = {
  isRepo: true,
  remote: 'https://github.com/mira/journal',
  name: 'Mira Vance',
  email: 'mira@example',
  dirty: 0,
  ahead: 0,
  behind: 0,
  lastCommit: 1_700_000_000,
  hasToken: true,
}
const fake = {
  status: backedUp,
  pulled: { changed: [] as string[], conflicts: [] as string[] },
  /** What a round's commit answers, or throws, as the mass-deletion guard does. */
  commit: async (_byHand: boolean) => true,
  /** What happens while the pull runs: the checkout's writes, the owner's typing. */
  duringPull: () => {},
}
const calls: string[] = []
vi.mock('../sync', () => ({
  syncStatus: vi.fn(async () => fake.status),
  syncCommit: vi.fn(async (_vault: string, byHand: boolean) => (calls.push(`commit${byHand ? ':by-hand' : ''}`), fake.commit(byHand))),
  syncPull: vi.fn(async () => (calls.push('pull'), fake.duringPull(), fake.pulled)),
  syncPush: vi.fn(async () => void calls.push('push')),
  // Configuring the address is what puts it in the status, as on disk.
  syncConfigure: vi.fn(async (_vault: string, remote: string | null, name: string, email: string) => {
    fake.status = { ...fake.status, isRepo: true, remote, name, email }
    calls.push('configure')
  }),
  syncSetToken: vi.fn(async (remote: string) => {
    calls.push(`token:${remote}`)
    fake.status = { ...fake.status, hasToken: true }
  }),
  syncForgetToken: vi.fn(async () => {}),
  syncClone: vi.fn(async () => {}),
}))

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  fake.status = backedUp
  fake.pulled = { changed: [], conflicts: [] }
  fake.commit = async () => true
  fake.duringPull = () => {}
  calls.length = 0
})

const pane = () => within(document.querySelector('.sidebar')!)


/**
 * The app, with the round that opening the vault runs already
 * done and forgotten, so a test sees only its own rounds.
 */
async function openAppSettled() {
  await openApp()
  await waitFor(() => expect(calls.length).toBeGreaterThan(0))
  await new Promise((r) => setTimeout(r, 50))
  calls.length = 0
}

describe('the sync', () => {
  it('says its one sentence on the row, and the row opens its settings', async () => {
    await openApp()
    const row = await pane().findByLabelText('Sync')
    await waitFor(() => expect(row.textContent).toContain('Synced'))
    fireEvent.click(row)
    expect(screen.getByRole('heading', { name: 'Sync', level: 3 })).toBeTruthy()
  })

  /**
   * The first backup in one press. The token read the address from the panel's state
   * before it had caught up, so it was not stored; the round found no token, committed
   * locally, said Synced, and nothing reached GitHub. The token's remote is read fresh
   * now, and the whole sequence runs: configure, token, commit, pull, push.
   */
  it('backs a fresh vault up in one press: address, token, then the round', async () => {
    fake.status = { ...backedUp, isRepo: false, remote: null, name: '', email: '', hasToken: false, lastCommit: null }
    await openApp()
    fireEvent.click(await pane().findByLabelText('Sync'))
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mira Vance' } })
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'mira@example' } })
    fireEvent.change(screen.getByLabelText('Repository address'), { target: { value: backedUp.remote! } })
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'ghp_fictional' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back up this vault' }))
    await waitFor(() => expect(calls).toContain('push'))
    expect(calls).toEqual(['configure', `token:${backedUp.remote}`, 'commit:by-hand', 'pull', 'push'])
  })

  /**
   * A folder emptied by hand is not pushed to every device by
   * the next round; it is said once and waits for Sync now.
   */
  it('refuses to carry a deletion of more than half the vault on its own, and says so once', async () => {
    fake.commit = async (byHand) => {
      if (!byHand) throw new Error('102 of the 126 files in the vault were deleted since the last save. Not saving that on its own: if you meant it, press Sync now in Settings → Sync.')
      return true
    }
    await openApp()
    fireEvent(window, new Event('focus'))
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('102 of the 126 files')
    expect(calls).not.toContain('push')
    // The same refusal next round is not a second message.
    fireEvent(window, new Event('focus'))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // By hand, it goes.
    fireEvent.click(await pane().findByLabelText('Sync'))
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(calls).toContain('commit:by-hand'))
    await waitFor(() => expect(calls).toContain('push'))
  })

  /**
   * Leaving the app is leaving for another device, so this one's
   * last edits go up then, not when a throttled timer gets to it.
   */
  /**
   * Opening the vault runs a round, without waiting for a focus
   * that may come before the vault loads.
   */
  it('runs a round when the vault opens', async () => {
    await openApp()
    await waitFor(() => expect(calls).toEqual(['commit', 'pull', 'push']))
  })

  it('runs a round when the window loses focus', async () => {
    await openAppSettled()
    fireEvent(window, new Event('blur'))
    await waitFor(() => expect(calls).toContain('push'))
    expect(calls).toEqual(['commit', 'pull', 'push'])
  })

  it('runs a round on focus: commit, pull, push, in that order', async () => {
    await openAppSettled()
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(calls).toContain('push'))
    expect(calls).toEqual(['commit', 'pull', 'push'])
  })

  it('says which files both devices changed, and re-reads what a pull brought', async () => {
    disk.write('/v/Daily/2026-09-24.md', '# Thursday\n')
    fake.pulled = { changed: ['Daily/2026-09-24.md', 'Daily/2026-09-24 (other).md'], conflicts: ['Daily/2026-09-24.md'] }
    await openApp()
    fireEvent(window, new Event('focus'))
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('Both devices changed Daily/2026-09-24.md')
    expect(banner.textContent).toContain('(other)')
  })

  /**
   * Typing during a pull keeps both. The round flushes before it pulls,
   * but the pull takes seconds; a save queued meanwhile wrote the pre-pull
   * text over the other device's edit, and the next round pushed it. The
   * other version is now kept beside the note, as a merge conflict is.
   */
  it('keeps the other device’s edit beside a note typed into during the pull', async () => {
    disk.write('/v/Daily/2026-09-24.md', '# Thursday\n')
    await openAppSettled()
    fireEvent.click(pane().getByText('Daily'))
    fireEvent.click(await waitFor(() => pane().getByText('2026-09-24')))
    await waitFor(() => expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('# Thursday\n'))
    fake.duringPull = () => {
      fireEvent.change(screen.getByTestId('editor'), { target: { value: '# Thursday\nmine\n' } })
      disk.write('/v/Daily/2026-09-24.md', '# Thursday\ntheirs\n')
    }
    fake.pulled = { changed: ['Daily/2026-09-24.md'], conflicts: [] }
    fireEvent(window, new Event('focus'))

    await waitFor(() => expect(disk.read('/v/Daily/2026-09-24 (other).md')).toBe('# Thursday\ntheirs\n'))
    await waitFor(() => expect(disk.read('/v/Daily/2026-09-24.md')).toBe('# Thursday\nmine\n'))
    expect((await screen.findByRole('alert')).textContent).toContain('2026-09-24 (other)')
  })

  it('takes a pulled edit into a note nobody is typing into, and keeps no copy', async () => {
    disk.write('/v/Daily/2026-09-24.md', '# Thursday\n')
    await openAppSettled()
    fireEvent.click(pane().getByText('Daily'))
    fireEvent.click(await waitFor(() => pane().getByText('2026-09-24')))
    await waitFor(() => expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('# Thursday\n'))
    fake.duringPull = () => disk.write('/v/Daily/2026-09-24.md', '# Thursday\ntheirs\n')
    fake.pulled = { changed: ['Daily/2026-09-24.md'], conflicts: [] }
    fireEvent(window, new Event('focus'))

    await waitFor(() => expect((screen.getByTestId('editor') as HTMLTextAreaElement).value).toBe('# Thursday\ntheirs\n'))
    await new Promise((r) => setTimeout(r, 1000))
    expect(disk.has('/v/Daily/2026-09-24 (other).md')).toBe(false)
    expect(disk.read('/v/Daily/2026-09-24.md')).toBe('# Thursday\ntheirs\n')
  })

  it('leaves a vault that is not a repository alone', async () => {
    fake.status = { ...backedUp, isRepo: false, remote: null, hasToken: false, name: '', email: '', lastCommit: null }
    await openApp()
    const row = await pane().findByLabelText('Sync')
    await waitFor(() => expect(row.textContent).toContain('Not backed up'))
    fireEvent(window, new Event('focus'))
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toEqual([])
  })

  it('pushes nothing when there is history but no repository address', async () => {
    fake.status = { ...backedUp, remote: null, hasToken: false }
    await openAppSettled()
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(calls).toContain('commit'))
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toEqual(['commit'])
    expect((await pane().findByLabelText('Sync')).textContent).toContain('History on this device only')
  })
})

/**
 * The timer survives the caller's renders. `App` passes `useSync` new
 * callbacks each render, and while the timer depended on them it
 * restarted every time, so frequent renders meant no rounds at all.
 */
describe('the minute', () => {
  afterEach(() => vi.useRealTimers())

  it('is kept across renders that hand it new callbacks', async () => {
    vi.useFakeTimers()
    const props = () => ({
      vaultPath: '/v',
      everySeconds: 60,
      flush: async () => {},
      onPulled: async () => {},
      onCommitted: async () => {},
      onError: () => {},
    })
    const { rerender } = renderHook((p: ReturnType<typeof props>) => useSync(p), { initialProps: props() })
    for (let tick = 0; tick < 5; tick++) {
      await act(() => vi.advanceTimersByTimeAsync(20_000))
      rerender(props())
    }
    // The round the vault's opening runs, and one timer round: two.
    expect(calls.filter((one) => one === 'commit')).toHaveLength(2)
  })
})

/**
 * Offline is the network not being there, and nothing else. A bare `SSL|TLS`
 * once classed an untrusted certificate as offline, so a sync that could
 * never work said only "offline". Real messages from libgit2 and curl.
 */
describe('what counts as offline', () => {
  it('is a name that does not resolve, a connection that fails, drops or times out', () => {
    for (const message of [
      'failed to resolve address for github.com: nodename nor servname provided, or not known; class=Net (12)',
      'failed to connect to github.com: Network is unreachable; class=Os (2)',
      'SSL error: syscall failure: Connection reset by peer; class=Ssl (16)',
      'error receiving data from socket: Broken pipe; class=Net (12)',
      'curl: (6) Could not resolve host: calendar.example',
      'curl: (28) Operation timed out after 30001 milliseconds',
    ]) {
      expect(isOffline(message), message).toBe(true)
    }
  })

  it('is not a certificate the machine does not trust, nor a refused token', () => {
    for (const message of [
      'the SSL certificate is invalid; class=Ssl (16); code=Certificate (-17)',
      'SSL error: error:0A000086:SSL routines::certificate verify failed; class=Ssl (16)',
      'curl: (60) SSL certificate problem: unable to get local issuer certificate',
      'unexpected http status code: 401; class=Http (34)',
    ]) {
      expect(isOffline(message), message).toBe(false)
    }
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'
import type { SyncStatus } from '../sync'
import { isOffline, useSync } from '../useSync'

/**
 * The sync from the shell's side, over a mocked bridge: the row under
 * Applications says the one sentence, a window focus runs a round in order —
 * flush, commit, pull, push — a pull's conflicts are said once, and a vault that
 * is not a repository is left alone. `sync.rs` has its own tests for what git does.
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
  /** What a round's commit answers — or throws, as the mass-deletion guard does. */
  commit: async (_byHand: boolean) => true,
  /** What happens while the pull runs: the checkout's writes, the user's typing. */
  duringPull: () => {},
}
const calls: string[] = []
vi.mock('../sync', () => ({
  syncStatus: vi.fn(async () => fake.status),
  syncCommit: vi.fn(async (_vault: string, byHand: boolean) => (calls.push(`commit${byHand ? ':by-hand' : ''}`), fake.commit(byHand))),
  syncPull: vi.fn(async () => (calls.push('pull'), fake.duringPull(), fake.pulled)),
  syncPush: vi.fn(async () => void calls.push('push')),
  // Configuring the address is what makes the status carry it — as on disk.
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

async function openApp() {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
}

/** The app, with the round that opening the vault runs already finished and
 *  forgotten, so a test sees only the rounds it asks for. */
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
   * **The first backup, in one press, as the owner did it.** The token asked for
   * the address from the panel's state before that state had caught up with the
   * address just typed, so it was not stored; the round saw no token, committed
   * locally and said Synced, and GitHub stayed empty. The token's remote is read
   * fresh now, and the whole sequence lands: configure, token, commit, pull, push.
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

  /** A folder emptied by hand is not pushed to every device by the minute's round;
   *  it is said, once, and waits for Sync now. */
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
    // The same refusal on the next round is not a second banner.
    fireEvent(window, new Event('focus'))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    // By hand, it goes.
    fireEvent.click(await pane().findByLabelText('Sync'))
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(calls).toContain('commit:by-hand'))
    await waitFor(() => expect(calls).toContain('push'))
  })

  /** Leaving the app is leaving for the other device: this one's last edits go up
   *  then, rather than whenever a throttled background timer gets round to it. */
  /** Opening the vault is coming back to it: a round, without waiting for a focus
   *  that may arrive before the vault has loaded. */
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
   * **Typing during a pull keeps both.** The round flushes before it pulls, but the
   * pull takes seconds; a save queued inside them used to write the pre-pull text
   * back over the other device's edit, and the next round pushed that to it. The
   * other side is kept beside the note now, as the merge keeps a conflict.
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
 * **The minute survives the caller's renders.** `App` hands `useSync` callbacks it
 * makes afresh every render, and while the timer depended on them it was torn down
 * and started again on each one — a render more often than once a minute meant no
 * round at all. Rendered every twenty seconds here, the old hook ran nothing in a
 * hundred, past the round the vault's opening runs.
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
    // The round the vault's opening runs, and one minute's: two.
    expect(calls.filter((one) => one === 'commit')).toHaveLength(2)
  })
})

/**
 * **Offline is the network not being there, and nothing else.** A certificate that
 * is not trusted was classed with it by a bare `SSL|TLS`, so a sync that could never
 * succeed said "offline" and nothing more. Real messages, libgit2's and curl's.
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

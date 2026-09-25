/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  disk,
  fsModule,
  markdownEditorModule,
  rememberVault,
  resetFakeVault,
} from './fakeVault'

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
const picked = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: picked, confirm: vi.fn(async () => true) }))

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  rememberVault('/v')
  picked.mockClear()
  picked.mockResolvedValue(null)
})

const row = (n: string) => within(document.querySelector('.file-list')!).getByText(n)

it('closes the open note when the vault underneath it is replaced', async () => {
  disk.write('/w/other.md', '# Other\n')
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(row('roadmap')).toBeTruthy())
  fireEvent.click(row('roadmap'))
  await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy())

  picked.mockResolvedValue('/w')
  fireEvent.click(document.querySelector('.vault-name')!)

  await waitFor(() => expect(row('other')).toBeTruthy())
  expect(screen.queryByTestId('editor')).toBeNull()
})

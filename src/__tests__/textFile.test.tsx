/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { disk, fsModule, markdownEditorModule, rememberVault, resetFakeVault } from './fakeVault'

/**
 * **A text file that is not markdown opens as text.** A `.conf`, a `.yaml`, a
 * `.txt` went to the markdown editor, so every `# comment` in the tmux config the
 * app writes came out a heading with its `#` hidden. Each opens in the plain editor
 * now: the same box, face and line numbers, and nothing that reads the text.
 *
 * The markdown editor is the textarea stub here, so reaching it at all is the
 * failure; the plain one mounts CodeMirror for real — see `jsonFile.test.tsx` for
 * the two shims that takes.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))

Object.defineProperty(globalThis, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (media: string) => ({
    media,
    matches: false,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

Range.prototype.getClientRects = () =>
  [{ top: 0, bottom: 14, left: 0, right: 0, width: 0, height: 14 }] as unknown as DOMRectList

const FILES = {
  'session.conf': '# The bench session.\nset -g status off\n',
  'deploy.yaml': '# Where it goes\nregion: lakeside\n',
  'errands.txt': '# not a heading\n- not a list item either\n',
}

afterEach(cleanup)
beforeEach(() => {
  resetFakeVault()
  for (const [name, text] of Object.entries(FILES)) disk.write(`/v/${name}`, text)
  rememberVault('/v')
})

async function open(name: string): Promise<EditorView> {
  const { default: App } = await import('../App')
  render(<App />)
  await waitFor(() => expect(screen.getByText('roadmap')).toBeTruthy())
  fireEvent.click(within(document.querySelector('.file-list')!).getByText(name))
  const content = await waitFor(() => screen.getByLabelText(`${name} source`))
  return EditorView.findFromDOM(content.closest('.cm-editor') as HTMLElement)!
}

describe('a text file that is not markdown', () => {
  for (const [name, text] of Object.entries(FILES)) {
    it(`opens ${name} as its own text, with nothing drawn over it`, async () => {
      const view = await open(name)
      expect(view.state.doc.toString()).toBe(text)
      expect(screen.queryByTestId('editor')).toBeNull()
      expect(view.contentDOM.querySelector('[class*="cm-md"]')).toBeNull()
    })
  }

  it('is written as it is typed, verbatim', async () => {
    const view = await open('session.conf')
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'set -g mouse off\n' } })
    })
    await waitFor(() =>
      expect(disk.read('/v/session.conf')).toBe('# The bench session.\nset -g status off\nset -g mouse off\n')
    )
  })
})

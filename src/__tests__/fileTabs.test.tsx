/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { clickBeside, disk, fsModule, markdownEditorModule, openApp, rememberVault, resetFakeVault } from './fakeVault'
import { readProperty } from '../properties'
import JSZip from 'jszip'

/**
 * A vault is a folder of files, and the tree shows them: PDFs, photos and exports sit
 * beside the notes. The pane shows what it can and says when it cannot. `files.test.ts`
 * covers what a file is and how a delimited one is coloured; this drives the app.
 */

vi.mock('@tauri-apps/plugin-fs', () => fsModule())
vi.mock('../MarkdownEditor', () => markdownEditorModule())
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  confirm: vi.fn(async () => true),
}))
// A CSV's editor is the real CodeMirror, which jsdom cannot lay
// out. What a CSV tab is comes from the model.
vi.mock('../SourceEditor', () => ({
  SourceEditor: ({ kind, initialText }: { kind: string; initialText: string }) => (
    <div data-testid={kind}>{initialText}</div>
  ),
}))

/**
 * The Word editor stood in for: jsdom lays out no pages. Each mount is kept, with what
 * it was given, what its save will hand back (`next`, null for nothing) and whether it
 * has been let go, and in what order.
 */
const editors = vi.hoisted(() => [] as { bytes: Uint8Array; options: { onChange: () => void }; next: Uint8Array | null; slow: boolean; events: string[] }[])
vi.mock('@eigenpal/docx-editor-react', async () => {
  const { forwardRef, useEffect, useImperativeHandle, useState } = await import('react')
  return {
    DocxEditor: forwardRef(({ documentBuffer, ...options }: { documentBuffer: Uint8Array; onChange: () => void }, ref) => {
      const [one] = useState(() => ({ bytes: documentBuffer, options, next: null as Uint8Array | null, slow: false, events: [] as string[] }))
      one.options = options
      useEffect(() => {
        editors.push(one)
        return () => void one.events.push('destroy')
      }, [one])
      useImperativeHandle(ref, () => ({
        save: async () => {
          one.events.push('save')
          // A real save takes its time: long enough for the pages to read the file first.
          if (one.slow) await new Promise((done) => setTimeout(done, 200))
          return one.next && new Uint8Array(one.next).buffer
        },
      }))
      return <div>the editor</div>
    }),
  }
})
vi.mock('@eigenpal/docx-editor-core', () => ({ setGoogleFontsEnabled: () => {} }))
vi.mock('@eigenpal/docx-editor-react/styles.css?inline', () => ({
  default: '.ep-root .x{color:red}[contenteditable=true]{display:inline}[contenteditable=true]:focus{outline:none}',
}))

afterEach(cleanup)
beforeEach(() => {
  editors.length = 0
  resetFakeVault()
  rememberVault('/v')
  disk.write('/v/deck.pdf', '%PDF-1.7 pretend')
  disk.write('/v/whiteboard.png', 'pretend pixels')
  disk.write('/v/spend.csv', 'day,amount\n2026-09-18,480\n')
  disk.write('/v/archive.zip', 'pretend')
})


const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const RELATIONSHIPS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
const RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** A Word document of these paragraphs, the least a `.docx` holds; a `- ` paragraph is in Word's own bullet list. */
async function wordDocument(...paragraphs: string[]) {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  )
  zip.file('_rels/.rels', `${XML}<Relationships ${RELATIONSHIPS}><Relationship Id="rId1" Type="${RELATIONSHIP}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/_rels/document.xml.rels', `${XML}<Relationships ${RELATIONSHIPS}><Relationship Id="rId1" Type="${RELATIONSHIP}/numbering" Target="numbering.xml"/></Relationships>`)
  // Word's default first bullet: the Symbol font's U+F0B7.
  zip.file(
    'word/numbering.xml',
    `${XML}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="\uF0B7"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
  )
  const body = paragraphs
    .map((one) => {
      const item = one.startsWith('- ') ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' : ''
      return `<w:p>${item}<w:r><w:t>${one.replace(/^- /, '')}</w:t></w:r></w:p>`
    })
    .join('')
  zip.file('word/document.xml', `${XML}<w:document ${W}><w:body>${body}</w:body></w:document>`)
  return zip.generateAsync({ type: 'uint8array' })
}

const sidebar = () => within(document.querySelector('.sidebar')!)
const title = () => document.querySelector('.viewer:not([hidden]) .viewer-title')?.textContent ?? null
const tabs = () => [...document.querySelectorAll('[role="tab"] .tab-name')].map((el) => el.textContent)

describe('the tree', () => {
  it('lists every file, extension and all', async () => {
    await openApp()
    for (const name of ['deck.pdf', 'whiteboard.png', 'spend.csv', 'archive.zip']) {
      expect(sidebar().getByText(name), name).toBeTruthy()
    }
  })
})

describe('the reading pane', () => {
  it('shows an image, and writes nothing', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('whiteboard.png'))
    await waitFor(() => expect(title()).toBe('whiteboard.png'))
    const image = document.querySelector('img.file-image') as HTMLImageElement
    expect(image).toBeTruthy()
    expect(image.getAttribute('src')).toContain('whiteboard.png')
    // No editor and no buffer: the bytes stay as they were.
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(disk.read('/v/whiteboard.png')).toBe('pretend pixels')
  })

  it('shows a PDF in a frame of its own', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('deck.pdf'))
    await waitFor(() => expect(title()).toBe('deck.pdf'))
    const frame = document.querySelector('iframe.file-frame') as HTMLIFrameElement
    expect(frame).toBeTruthy()
    expect(frame.getAttribute('src')).toContain('deck.pdf')
  })

  /** Read only: the vault's agent edits the file, and the pane draws what it wrote. */
  it('draws a Word document as its pages, again when it is written outside the app', async () => {
    disk.writeBytes('/v/letter.docx', await wordDocument('Dear Mira Vance,'))
    await openApp()
    fireEvent.click(sidebar().getByText('letter.docx'))
    const pages = () => document.querySelector('.viewer:not([hidden]) .word-pages')?.textContent
    await waitFor(() => expect(pages()).toContain('Dear Mira Vance,'))
    expect(screen.queryByTestId('editor')).toBeNull()
    disk.writeBytes('/v/letter.docx', await wordDocument('Dear Mira Vance,', 'The boats are ready.'))
    fireEvent.focus(window)
    await waitFor(() => expect(pages()).toContain('The boats are ready.'))
    // And on a return to its tab, as after an agent in the app's own terminal.
    clickBeside(sidebar().getByText('whiteboard.png'))
    await waitFor(() => expect(title()).toBe('whiteboard.png'))
    disk.writeBytes('/v/letter.docx', await wordDocument('Yours, Northwind'))
    fireEvent.mouseDown(screen.getByRole('tab', { name: /letter\.docx/ }))
    await waitFor(() => expect(pages()).toContain('Yours, Northwind'))
    expect(pages()).not.toContain('Dear Mira Vance,')
  })

  /** Its tab to the text drawn as a space, an item's first line started short of the rest. */
  it('draws Word’s bullet as a bullet, its text at the item’s indent', async () => {
    disk.writeBytes('/v/letter.docx', await wordDocument('Packed:', '- oars'))
    await openApp()
    fireEvent.click(sidebar().getByText('letter.docx'))
    await waitFor(() => expect(document.querySelector('.word-pages')?.textContent).toContain('oars'))
    const styles = [...document.querySelectorAll('.word-pages style')].map((one) => one.textContent).join('')
    expect(styles).toMatch(/content: "•/)
    expect(styles).not.toContain('\uF0B7')
    expect(styles).toMatch(/p\.word-\d+-num-1-0:before \{ display: inline-block; min-width: 18\.00pt; text-indent: 0 \}/)
  })

  it('draws Calibri and Cambria by their metric twins, unless they are installed', async () => {
    const faces: { family: string; source: string; weight?: string; style?: string }[] = []
    vi.stubGlobal(
      'FontFace',
      class {
        constructor(family: string, source: string, { weight, style }: FontFaceDescriptors) {
          faces.push({ family, source, weight, style })
        }
        load = async () => this
      }
    )
    Object.defineProperty(document, 'fonts', { value: { add: () => undefined }, configurable: true })
    disk.writeBytes('/v/letter.docx', await wordDocument('Dear Mira Vance,'))
    await openApp()
    fireEvent.click(sidebar().getByText('letter.docx'))
    await waitFor(() => expect(document.querySelector('.word-pages')?.textContent).toContain('Dear Mira Vance,'))
    expect(faces.map(({ family, weight, style }) => `${family} ${weight} ${style}`)).toEqual([
      'Calibri 400 normal',
      'Calibri 700 normal',
      'Calibri 400 italic',
      'Calibri 700 italic',
      'Cambria 400 normal',
      'Cambria 700 normal',
      'Cambria 400 italic',
      'Cambria 700 italic',
    ])
    expect(faces[3].source).toMatch(/^local\('Calibri Bold Italic'\), url\(.*carlito-latin-700-italic\.woff2\)$/)
    vi.unstubAllGlobals()
  })

  it('says a Word document it cannot read, and keeps what it drew', async () => {
    disk.writeBytes('/v/letter.docx', await wordDocument('Dear Mira Vance,'))
    await openApp()
    fireEvent.click(sidebar().getByText('letter.docx'))
    await waitFor(() => expect(document.querySelector('.word-pages')?.textContent).toContain('Dear Mira Vance,'))
    disk.write('/v/letter.docx', 'half written')
    fireEvent.focus(window)
    await waitFor(() => expect(document.querySelector('.word-failed')?.textContent).toMatch(/^letter\.docx could not be read/))
    expect(document.querySelector('.word-pages')?.textContent).toContain('Dear Mira Vance,')
  })

  it('says so for a file it has nothing to say about, and offers Finder', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('archive.zip'))
    await waitFor(() => expect(title()).toBe('archive.zip'))
    expect(screen.getByText(/archive\.zip is not a kind of file this app shows/)).toBeTruthy()
    expect(screen.getByText('Reveal in Finder')).toBeTruthy()
  })

  it('opens a CSV as a table, and as its own text in the editor that colours its columns', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('spend.csv'))
    await waitFor(() => expect(title()).toBe('spend.csv'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Amount, row 1' }).textContent).toBe('480'))
    fireEvent.click(screen.getByRole('button', { name: 'Text' }))
    await waitFor(() => expect(screen.getByTestId('csv').textContent).toBe('day,amount\n2026-09-18,480\n'))
  })

  /** A file tab is a tab: it sits beside the notes and follows its file. */
  it('opens beside a note, and closes when the file is deleted', async () => {
    await openApp()
    fireEvent.click(sidebar().getByText('roadmap'))
    await waitFor(() => expect(tabs()).toEqual(['roadmap']))
    clickBeside(sidebar().getByText('deck.pdf'))
    await waitFor(() => expect(tabs()).toEqual(['roadmap', 'deck.pdf']))

    fireEvent.contextMenu(sidebar().getByText('deck.pdf'))
    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(disk.has('/v/deck.pdf')).toBe(false))
    await waitFor(() => expect(tabs()).toEqual(['roadmap']))
  })
})

/**
 * A file moves the way a note does: the same drag, targets and
 * `moveFile`. Only a note's own parts (its `path` and links) are
 * rewritten, and only for files that have them.
 */
describe('a Word document edited', () => {
  const bytesOf = (path: string) => fsModule().readFile(path)
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, at) => byte === b[at])
  async function openEditor() {
    disk.writeBytes('/v/letter.docx', await wordDocument('Dear Mira Vance,'))
    await openApp()
    fireEvent.click(sidebar().getByText('letter.docx'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(editors).toHaveLength(1))
    return editors[0]
  }

  it('opens the file in the editor, and writes a change a moment after it', async () => {
    const editor = await openEditor()
    expect(same(editor.bytes, await bytesOf('/v/letter.docx'))).toBe(true)
    const edited = await wordDocument('Dear Mira Vance,', 'The boats are ready.')
    editor.next = edited
    editor.options.onChange()
    await waitFor(() => expect(same(disk.bytes('/v/letter.docx')!, edited)).toBe(true))
    expect(disk.paths()).not.toContain('/v/letter (other).docx')
  })

  /** As a note's save does: what the agent wrote meanwhile is not written over unseen. */
  it('keeps beside it what was written there meanwhile, and says so', async () => {
    const editor = await openEditor()
    const theirs = await wordDocument('Yours, Northwind')
    disk.writeBytes('/v/letter.docx', theirs)
    editor.next = await wordDocument('Dear Mira Vance, again')
    editor.options.onChange()
    await waitFor(() => expect(same(disk.bytes('/v/letter (other).docx')!, theirs)).toBe(true))
    expect(same(disk.bytes('/v/letter.docx')!, editor.next)).toBe(true)
    expect(await screen.findByText(/letter\.docx changed elsewhere while you edited/)).toBeTruthy()
  })

  it('writes what was changed before the pages are drawn again', async () => {
    const editor = await openEditor()
    editor.next = await wordDocument('The boats are ready.')
    editor.slow = true
    editor.options.onChange()
    fireEvent.click(screen.getByRole('button', { name: 'Pages' }))
    await waitFor(() => expect(document.querySelector('.word-pages')?.textContent).toContain('The boats are ready.'))
    expect(editor.events).toEqual(['save', 'destroy'])
  })

  /** Unmounted under a save, the editor handed back nothing: it goes only once the save is written. */
  it('writes what was changed when its tab closes, before the editor goes', async () => {
    const editor = await openEditor()
    editor.next = await wordDocument('The boats are ready.')
    editor.options.onChange()
    fireEvent.click(screen.getByRole('button', { name: 'Close letter.docx' }))
    await waitFor(() => expect(editor.events).toEqual(['save', 'destroy']))
    expect(same(disk.bytes('/v/letter.docx')!, editor.next)).toBe(true)
  })

  it('writes nothing it was not asked to', async () => {
    const editor = await openEditor()
    const before = disk.bytes('/v/letter.docx')!
    fireEvent.click(screen.getByRole('button', { name: 'Pages' }))
    await waitFor(() => expect(editor.events).toEqual(['destroy']))
    expect(disk.bytes('/v/letter.docx')).toBe(before)
  })

  /** Its sheet set every editable element in the page to `display: inline`, the note's editor among them. */
  it('keeps the editor’s sheet to the editor', async () => {
    await openEditor()
    const sheet = [...document.head.querySelectorAll('style')].map((one) => one.textContent).find((text) => text?.includes('.ep-root'))!
    expect(sheet).toContain(':is(.ep-root, .paged-editor__hidden-pm) [contenteditable=true]{display:inline}')
    expect(sheet.replaceAll(':is(.ep-root, .paged-editor__hidden-pm) [contenteditable=true]', '')).not.toContain('[contenteditable=true]')
  })
})

describe('moving a file that is not a note', () => {
  const FILE_MIME = 'application/x-journeys-file'
  const tree = () => document.querySelector('.pane-section .file-list') as HTMLElement
  const rowFor = (name: string) =>
    [...tree().querySelectorAll('.folder-header')].find((row) => row.textContent?.startsWith(name))!

  it('drags into a folder, keeping its bytes and its name', async () => {
    await openApp()
    const carried = {
      path: 'deck.pdf',
      absolutePath: '/v/deck.pdf',
      name: 'deck.pdf',
    }
    fireEvent.drop(rowFor('Ideas'), {
      dataTransfer: {
        types: [FILE_MIME],
        getData: (asked: string) => (asked === FILE_MIME ? JSON.stringify(carried) : ''),
      },
    })
    await waitFor(() => expect(disk.has('/v/Ideas/deck.pdf')).toBe(true))
    expect(disk.has('/v/deck.pdf')).toBe(false)
    // Its bytes are its own: a move writes no `path` into a file that is not a note.
    expect(disk.read('/v/Ideas/deck.pdf')).toBe('%PDF-1.7 pretend')
  })
})

/**
 * A file dragged in from outside is filed where it is dropped. The webview's default is
 * to open a dropped file in place of the app, so a PDF that missed the left pane
 * replaced everything. Now nothing outside a drop target acts, and a target copies.
 */
describe('a file dragged in from outside', () => {
  const dropping = (...files: File[]) => ({
    types: ['Files'],
    files,
    getData: () => '',
  })
  const tree = () => document.querySelector('.pane-section .file-list') as HTMLElement
  const rowFor = (name: string) =>
    [...tree().querySelectorAll('.folder-header')].find((row) => row.textContent?.startsWith(name))!

  it('copies it into the folder it was dropped on', async () => {
    await openApp()
    fireEvent.drop(rowFor('Ideas'), {
      dataTransfer: dropping(new File(['%PDF pretend'], 'lease.pdf', { type: 'application/pdf' })),
    })
    await waitFor(() => expect(disk.read('/v/Ideas/lease.pdf')).toBe('%PDF pretend'))
    // And it is a row, once its folder is open.
    fireEvent.click(within(tree()).getByText('Ideas'))
    await waitFor(() => expect(within(tree()).getByText('lease.pdf')).toBeTruthy())
  })

  it('copies several onto the vault itself', async () => {
    await openApp()
    fireEvent.drop(tree(), {
      dataTransfer: dropping(
        new File(['one'], 'a.png', { type: 'image/png' }),
        new File(['two'], 'b.png', { type: 'image/png' })
      ),
    })
    await waitFor(() => expect(disk.read('/v/a.png')).toBe('one'))
    expect(disk.read('/v/b.png')).toBe('two')
  })

  /**
   * Said as it starts and when it is done: a drop that said nothing until the end, and
   * only of a failure, looked like one that had not worked, and was made again. Two of
   * one name in a drop copy the first, and the second is already here.
   */
  it('says it is copying, then what it copied, and copies one name once', async () => {
    await openApp()
    fireEvent.drop(tree(), {
      dataTransfer: dropping(
        new File(['one'], 'a.png', { type: 'image/png' }),
        new File(['two'], 'b.png', { type: 'image/png' }),
        new File(['again'], 'A.png', { type: 'image/png' })
      ),
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Copied 2 files into the vault.'))
    expect(screen.getByRole('alert').textContent).toContain('A.png is already here')
    expect(disk.read('/v/a.png')).toBe('one')
    expect(disk.read('/v/b.png')).toBe('two')
  })

  /**
   * A failed copy is not one that was already there. When both were one list and every
   * write was refused, the app said "already in the vault" for files it never wrote.
   */
  it('says a refused copy failed, and does not claim the file is there', async () => {
    await openApp()
    disk.forbid('/v/', 'no writing here')
    fireEvent.drop(tree(), {
      dataTransfer: dropping(new File(['pixels'], 'new.png', { type: 'image/png' })),
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not copy new.png'))
    expect(screen.getByRole('alert').textContent).not.toContain('already here')
    expect(disk.has('/v/new.png')).toBe(false)
  })

  /**
   * Never over an existing file: a same-named file is reported
   * and the one on disk is left alone.
   */
  it('refuses to copy over a file already there, and says which', async () => {
    await openApp()
    fireEvent.drop(tree(), {
      dataTransfer: dropping(new File(['different'], 'deck.pdf', { type: 'application/pdf' })),
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('deck.pdf'))
    expect(disk.read('/v/deck.pdf')).toBe('%PDF-1.7 pretend')
  })
})

/**
 * A file dropped on a plain note gives that note children: the note
 * becomes a folder with its own note, as the row's `+` does for a typed
 * name. A PDF dropped on a note once landed at the top of the vault.
 */
describe('a file dropped on a note', () => {
  const dropping = (...files: File[]) => ({ types: ['Files'], files, getData: () => '' })
  const tree = () => document.querySelector('.pane-section .file-list') as HTMLElement
  const rowFor = (name: string) =>
    within(tree()).getByText(name).closest('button') as HTMLElement

  it('makes it a nested note and puts the file inside', async () => {
    await openApp()
    fireEvent.drop(rowFor('roadmap'), {
      dataTransfer: dropping(new File(['%PDF plan'], 'plan.pdf', { type: 'application/pdf' })),
    })

    // The note became a folder with its own note inside…
    await waitFor(() => expect(disk.has('/v/roadmap/roadmap.md')).toBe(true))
    expect(disk.has('/v/roadmap.md')).toBe(false)
    // …and the file is in there with it.
    expect(disk.read('/v/roadmap/plan.pdf')).toBe('%PDF plan')
    // The moved note knows where it is now.
    expect(readProperty(disk.read('/v/roadmap/roadmap.md') ?? '', 'path')).toBe('roadmap')
  })

  /**
   * And the tab follows it. Converting a note moved the buffer
   * but left the tab on a missing file.
   */
  it('carries the open tab with it', async () => {
    await openApp()
    fireEvent.click(within(tree()).getByText('roadmap'))
    await waitFor(() => expect(tabs()).toEqual(['roadmap']))

    fireEvent.drop(rowFor('roadmap'), {
      dataTransfer: dropping(new File(['%PDF plan'], 'plan.pdf', { type: 'application/pdf' })),
    })
    await waitFor(() => expect(disk.has('/v/roadmap/roadmap.md')).toBe(true))
    // One tab, still open, still the same note, at its new path.
    expect(tabs()).toEqual(['roadmap'])
    expect(screen.getByRole('tab', { name: /roadmap/ }).getAttribute('title')).toBe(
      'roadmap/roadmap.md'
    )
  })

  /**
   * A file that is not a note cannot hold one: the drop falls
   * through to the tree, the vault itself.
   */
  it('falls through to the vault when the row is not a note', async () => {
    await openApp()
    fireEvent.drop(rowFor('deck.pdf'), {
      dataTransfer: dropping(new File(['pixels'], 'scan.png', { type: 'image/png' })),
    })
    await waitFor(() => expect(disk.read('/v/scan.png')).toBe('pixels'))
    expect(disk.has('/v/deck/scan.png')).toBe(false)
  })
})

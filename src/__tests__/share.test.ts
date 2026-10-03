import { describe, expect, it } from 'vitest'
import { localTimeStamp } from '../clock'
import { shareEntry, type Share } from '../share'

/** A share as the day's entry an agent on the laptop will find by its tag. */
describe('a share’s entry', () => {
  const at = new Date(2026, 9, 2, 14, 5).getTime()
  const entry = (share: Partial<Share>, files: string[] = []) => shareEntry({ at, files: [], ...share }, files)

  it('is the time it arrived, the tag, its first line and a link to each file', () => {
    expect(entry({ text: 'Lunch spot' }, ['Files/photo.jpg', 'Files/menu.pdf'])).toBe(
      `${localTimeStamp(new Date(at))} #shared Lunch spot [[Files/photo.jpg]] [[Files/menu.pdf]]`
    )
    expect(entry({}, ['Files/photo.jpg'])).toBe('14:05 #shared [[Files/photo.jpg]]')
  })

  it('nests the rest of a message under it, a line each, blank lines left out', () => {
    expect(entry({ text: 'Meet at the ferry\r\n\r\n  bring the map\nand tea  ' })).toBe('14:05 #shared Meet at the ferry\nbring the map\nand tea')
  })

  /** A browser shares a page as its title and its address. */
  it('puts a subject before the text, unless the text already says it', () => {
    expect(entry({ subject: 'Tide tables', text: 'https://example.com/tides' })).toBe('14:05 #shared Tide tables https://example.com/tides')
    expect(entry({ subject: 'Tide tables', text: 'Tide tables https://example.com/tides' })).toBe(
      '14:05 #shared Tide tables https://example.com/tides'
    )
  })
})

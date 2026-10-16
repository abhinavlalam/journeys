import carlito from '@fontsource/carlito/files/carlito-latin-400-normal.woff2'
import carlitoBold from '@fontsource/carlito/files/carlito-latin-700-normal.woff2'
import carlitoItalic from '@fontsource/carlito/files/carlito-latin-400-italic.woff2'
import carlitoBoldItalic from '@fontsource/carlito/files/carlito-latin-700-italic.woff2'
import caladea from '@fontsource/caladea/files/caladea-latin-400-normal.woff2'
import caladeaBold from '@fontsource/caladea/files/caladea-latin-700-normal.woff2'
import caladeaItalic from '@fontsource/caladea/files/caladea-latin-400-italic.woff2'
import caladeaBoldItalic from '@fontsource/caladea/files/caladea-latin-700-italic.woff2'

/**
 * Word's own faces, which a Mac without Office has not got, each by its metric twin,
 * drawn to the same widths, so a line breaks where Word breaks it: in a fallback, a
 * document in Calibri was drawn in Times, and each line spaced out to the margin wrapped.
 */
const TWINS: [string, string[]][] = [
  ['Calibri', [carlito, carlitoBold, carlitoItalic, carlitoBoldItalic]],
  ['Cambria', [caladea, caladeaBold, caladeaItalic, caladeaBoldItalic]],
]
const FACES = [
  { weight: '400', style: 'normal', name: '' },
  { weight: '700', style: 'normal', name: ' Bold' },
  { weight: '400', style: 'italic', name: ' Italic' },
  { weight: '700', style: 'italic', name: ' Bold Italic' },
]
let twins: Promise<unknown> | null = null

/**
 * Loaded before the first document is drawn, since its tabs are measured once, in the
 * face there then. The real one is taken when it is installed. A face that does not load
 * leaves the fallback, and is tried again next time: the document is still drawn.
 */
export function loadTwins() {
  twins ??= (async () => {
    const faces = TWINS.flatMap(([family, urls]) =>
      FACES.map(({ name, ...face }, at) => new FontFace(family, `local('${family}${name}'), url(${urls[at]})`, face))
    )
    for (const face of faces) document.fonts.add(face)
    await Promise.all(faces.map((face) => face.load()))
  })().catch(() => {
    twins = null
  })
  return twins
}

import { configure } from '@testing-library/dom'

/**
 * One async budget for the whole suite. `waitFor`'s default is
 * 1000ms, and these tests drive the real app (walk the vault, read
 * every note, debounce, render), which under load does not fit in a
 * second. Flaky failures that pass on rerun teach you to ignore red.
 *
 * Raised once here, not at each call site. A generous ceiling costs nothing
 * while tests pass: `waitFor` returns as soon as its condition holds.
 *
 * Safe in both environments: most files run in `node` and opt
 * into `jsdom` with a docblock.
 */
configure({ asyncUtilTimeout: 5000 })

/**
 * jsdom has no `Range.getClientRects`, which CodeMirror reads to place a
 * caret on a press or a popup by the text. One zero-width rect gets past
 * it; no test reads a coordinate. Here once instead of in six files.
 */
if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects = () =>
    [{ top: 0, bottom: 14, left: 0, right: 0, width: 0, height: 14 }] as unknown as DOMRectList
}

/**
 * jsdom has no `matchMedia`, which CodeMirror calls when an editor is made. A query
 * that matches nothing; a test about dark mode or reduced motion puts its own in place.
 */
if (typeof window !== 'undefined') {
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
}

import { configure } from '@testing-library/dom'

/**
 * **One async budget for the whole suite.**
 *
 * `waitFor`'s own default is 1000ms, and these tests drive the real app: opening a
 * note is a walk of the vault, a read for every note in it, a debounce and a
 * re-render, and on a loaded machine that does not fit in a second. Two tests
 * failed that way in one afternoon and passed alone and in every rerun — a flake
 * that says nothing about the code, which is the worst kind of red, because it
 * teaches you to ignore it.
 *
 * Raised **once, here**, rather than at the 74 call sites that had learnt to ask
 * for five seconds and not at the 137 that had not. A generous ceiling costs
 * nothing while tests pass: `waitFor` returns the moment its condition holds, so
 * the budget is only ever spent on a failure that was going to fail anyway.
 *
 * Safe in both environments: most files here run in `node` and opt into `jsdom`
 * with a docblock, and this only sets a number in a config object.
 */
configure({ asyncUtilTimeout: 5000 })

/**
 * **jsdom has no `Range.getClientRects`**, and CodeMirror reads it to place a caret
 * from a press or a popup beside the text. One zero-width rect gets past it; no test
 * reads a coordinate. Here once: six files had their own copy, and the one that had
 * none threw on a press, reported as an error beside a passing run.
 */
if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects = () =>
    [{ top: 0, bottom: 14, left: 0, right: 0, width: 0, height: 14 }] as unknown as DOMRectList
}

/**
 * **jsdom has no `matchMedia`**, and CodeMirror calls it as an editor is made. A
 * query that matches nothing, everywhere a window is; a test about dark mode or
 * reduced motion puts its own in place of this one.
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

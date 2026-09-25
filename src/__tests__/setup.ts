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

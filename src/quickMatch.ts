// Quick open's matching (⌘P, `QuickOpen`): what is typed against every name the app
// can open, best first. Pure, so the order is decided and tested here.

/** Something quick open can open: its name, and what it is matched by besides (an alias). */
export interface Openable {
  key: string
  name: string
  /** Other names it answers to: a note's aliases. */
  also?: readonly string[]
}

/**
 * How well `query` names `name`, lower is better, or null when it does not: the name
 * starting with it, then a word in it starting with it, then holding it anywhere, then
 * holding its letters in order (`rdmp` for roadmap).
 */
export function matchOf(name: string, query: string): number | null {
  const [text, typed] = [name.toLowerCase(), query.trim().toLowerCase()]
  if (typed === '') return 0
  if (text.startsWith(typed)) return 0
  if (text.split(/[\s/._-]+/).some((word) => word.startsWith(typed))) return 1
  if (text.includes(typed)) return 2
  let at = 0
  for (const letter of typed) {
    at = text.indexOf(letter, at)
    if (at === -1) return null
    at++
  }
  return 3
}

/** The items `query` names, best first: by how well, then the shorter name, then as given. */
export function ranked<T extends Openable>(items: readonly T[], query: string, limit: number): T[] {
  return items
    .flatMap((item, at) => {
      const scores = [item.name, ...(item.also ?? [])].map((one) => matchOf(one, query)).filter((one): one is number => one !== null)
      return scores.length ? [{ item, score: Math.min(...scores), at }] : []
    })
    .sort((a, b) => a.score - b.score || a.item.name.length - b.item.name.length || a.at - b.at)
    .slice(0, limit)
    .map(({ item }) => item)
}

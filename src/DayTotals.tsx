import type { PropertyType } from './properties'
import type { DayTotal } from './tags'
import { totalsOf } from './timeline'

/**
 * A day's totals as tiles: the number large, its label under it. The same tiles
 * close a day's card in the timeline and a day's note; each total says where it
 * shows, set on its tag's page.
 */
export function DayTotals({
  text,
  totals,
  colours,
  typeOf,
  place,
}: {
  /** The day's note as written. */
  text: string
  totals: Readonly<Record<string, readonly DayTotal[]>>
  /** Each tag's colour, which its tiles take. */
  colours: Readonly<Record<string, string>>
  typeOf: (name: string) => PropertyType
  place: 'timeline' | 'note'
}) {
  const shown = totalsOf(text, totals, typeOf, place)
  if (shown.length === 0) return null
  return (
    <ul className="day-totals" aria-label="The day’s totals">
      {shown.map((one) => (
        <li key={one.key} className="day-total" data-hue={colours[one.tag]}>
          <span className="day-total-number">{one.value}</span>
          <span className="day-total-name">{one.label}</span>
        </li>
      ))}
    </ul>
  )
}

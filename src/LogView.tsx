import { useEffect, useRef } from 'react'
import { localDateStamp, localTimeStamp } from './clock'
import { EmptyRow, Section, stepIn, statusCount } from './rows'
import type { LogItem } from './useLog'
import { ViewerHeader } from './ViewerHeader'

/** Everything the app has said in this window, oldest first. Opens at the bottom. */
export function LogView({ items }: { items: readonly LogItem[] }) {
  const end = useRef<HTMLLIElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [items.length])
  const today = localDateStamp()
  return (
    <>
      <ViewerHeader name="Log" status={statusCount(items.length, 'message')} />
      <Section title="This window" count={items.length} startOpen>
        {items.length === 0 ? (
          <EmptyRow text="Nothing said yet." />
        ) : (
          items.map((item, at) => {
            const when = new Date(item.at)
            return (
              <li
                key={at}
                className="log-item"
                style={{ paddingLeft: stepIn(1) }}
                ref={at === items.length - 1 ? end : undefined}
              >
                <span className="log-when">
                  {localDateStamp(when) === today ? localTimeStamp(when) : `${localDateStamp(when)} ${localTimeStamp(when)}`}
                </span>
                <span className="log-text">{item.text}</span>
              </li>
            )
          })
        )}
      </Section>
    </>
  )
}

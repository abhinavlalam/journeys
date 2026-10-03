import { useEffect, useRef, useState, type ReactNode } from 'react'
import { onBackButtonPress } from '@tauri-apps/api/app'
import { onAndroid } from './platform'
import { sameTab, type Tab, type TabRequest } from './workspace'

/** Where the phone is: a page (the workspace's one tab), or Browse, the left pane at full width. */
export type Place = 'browse' | TabRequest

/** How many places back are remembered. */
const TRAIL = 30

const samePlace = (a: Place, b: Place) => (a === 'browse' || b === 'browse' ? a === b : sameTab(a, b))

/**
 * The phone shows one place at a time. Each move keeps where it came from, and
 * Android's back gesture goes there, closing what is open over the page first.
 * With nowhere left the gesture is Android's own, which leaves the app.
 */
export function usePhoneNav({
  page,
  show,
  exists,
  overlay,
}: {
  /** The page on screen: the workspace's active tab. */
  page: Tab | null
  /** Puts a page on screen. */
  show: (tab: TabRequest) => void
  /** Whether a page can still be shown: a note deleted or moved since is passed over. */
  exists: (tab: TabRequest) => boolean
  /** Closes what is open over the page (the settings), when something is. */
  overlay: (() => void) | null
}) {
  const [browsing, setBrowsing] = useState(false)
  const [trail, setTrail] = useState<Place[]>([])
  const here: Place | null = browsing ? 'browse' : page

  const arrive = (to: Place) => {
    setBrowsing(to === 'browse')
    if (to !== 'browse') show(to)
  }

  function go(to: Place) {
    if (here && samePlace(here, to)) return arrive(to)
    if (here) setTrail((was) => [...was, here].slice(-TRAIL))
    arrive(to)
  }

  function back() {
    if (overlay) return overlay()
    const left = trail.filter((one) => one === 'browse' || exists(one))
    const to = left.pop()
    setTrail(left)
    if (to) arrive(to)
  }

  // Listened for only while there is somewhere to go back to, so that
  // with none Android does what it does, rather than nothing.
  const latest = useRef(back)
  latest.current = back
  const deep = overlay !== null || trail.length > 0
  useEffect(() => {
    if (!onAndroid || !deep) return
    const listening = onBackButtonPress(() => latest.current()).catch(() => null)
    return () => void listening.then((one) => one?.unregister())
  }, [deep])

  return { browsing, go, back }
}

/** The phone's bottom bar: the places it starts from. */
export function PhoneBar({
  items,
}: {
  items: { name: string; icon: ReactNode; current: boolean; onPress: () => void }[]
}) {
  return (
    <nav className="phone-bar" aria-label="Places">
      {items.map((one) => (
        <button key={one.name} aria-pressed={one.current} onClick={one.onPress}>
          {one.icon}
          <span>{one.name}</span>
        </button>
      ))}
    </nav>
  )
}

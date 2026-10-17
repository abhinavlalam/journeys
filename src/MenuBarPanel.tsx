import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { localTimeStamp } from './clock'
import { ASK, elapsedText, TELL, type Said, type Tracking } from './menuBar'
import { applySettingsLive, loadSettings } from './settings'

/** The window that writes: the panel only asks it. */
const MAIN = 'main'

/**
 * The menu bar's panel: what is being done, timed from when it is said, and a line for
 * today. Enter in either field asks the main window; Escape, or a press anywhere else,
 * puts the panel away. It opens on the line for today, the thing most often wanted.
 */
export function MenuBarPanel() {
  const [tracking, setTracking] = useState<Tracking | null>(null)
  const [said, setSaid] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [what, setWhat] = useState('')
  const [line, setLine] = useState('')
  const lineField = useRef<HTMLTextAreaElement>(null)

  // Dressed as the window was last, from the settings it keeps for its first paint.
  useEffect(() => applySettingsLive(loadSettings()), [])
  useEffect(() => {
    const off = [
      listen<Tracking | null>(TELL.state, ({ payload }) => setTracking(payload)),
      listen<Said>(TELL.said, ({ payload }) => {
        setSaid(payload.said)
        if (payload.now) setWhat(payload.now)
        if (payload.line) setLine(payload.line)
      }),
    ]
    // Each time it is opened: what runs now, and the keyboard in the line for today.
    const opened = () => {
      setSaid('')
      setNow(Date.now())
      void emitTo(MAIN, ASK.hello)
      lineField.current?.focus()
    }
    opened()
    window.addEventListener('focus', opened)
    return () => {
      window.removeEventListener('focus', opened)
      off.forEach((one) => void one.then((unlisten) => unlisten()))
    }
  }, [])
  useEffect(() => {
    if (!tracking) return
    const every = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(every)
  }, [tracking])

  const onEnter = (send: () => void) => (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    send()
  }

  return (
    <main className="menubar-panel" onKeyDown={(event) => event.key === 'Escape' && void getCurrentWindow().hide()}>
      <label className="menubar-field">
        <span>Add to today</span>
        {/* A brain dump: ⇧↩ for another line, ↩ adds them all, each its own line in the day. */}
        <textarea
          ref={lineField}
          value={line}
          rows={3}
          placeholder="A thought a line: ⇧↩ for the next, ↩ adds them"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setLine(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.shiftKey) return
            onEnter(() => {
              if (!line.trim()) return
              void emitTo(MAIN, ASK.line, { text: line })
              setLine('')
            })(event)
          }}
        />
      </label>
      <label className="menubar-field">
        <span>Now</span>
        <input
          value={what}
          placeholder={tracking ? 'Something else: its time starts now' : 'What you are doing: its time starts now'}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setWhat(event.currentTarget.value)}
          onKeyDown={onEnter(() => {
            if (!what.trim()) return
            void emitTo(MAIN, ASK.start, { what })
            setWhat('')
          })}
        />
      </label>
      {tracking && (
        <p className="menubar-tracking">
          <span className="menubar-what">{tracking.what}</span>
          <span className="menubar-since">
            since {localTimeStamp(new Date(tracking.since))}, {elapsedText(tracking.since, now)}
          </span>
          <button className="header-action" onClick={() => void emitTo(MAIN, ASK.stop)}>
            Stop
          </button>
        </p>
      )}
      <p className="menubar-foot">
        <span className="menubar-said" role="status">
          {said}
        </span>
        {/* The agent, in the main window, put the days' lines where they belong. */}
        <button className="header-action" onClick={() => void emitTo(MAIN, ASK.organise)}>
          Organise
        </button>
      </p>
    </main>
  )
}

// The menu bar's Journeys: a panel of its own window (`MenuBarPanel`) that tracks the
// time spent on something and adds a line to today. The panel only asks, by events; the
// main window writes (`useMenuBar`), through the one funnel every line into a day goes
// through, so the open note, the tree and the sync see it.

import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emitTo, listen } from '@tauri-apps/api/event'
import { localDateStamp, localTimeStamp } from './clock'
import { onAndroid } from './platform'
import { readConfigFile, writeConfigFile } from './vault'

/** What is being done, and since when (ms): the time tracker running. */
export interface Tracking {
  what: string
  since: number
}

/** The panel's window, `menubar::PANEL` in `lib.rs`. */
export const PANEL = 'capture'

/** What the panel asks and is told, and what the main window answers it with. */
export const ASK = { start: 'menubar:start', stop: 'menubar:stop', line: 'menubar:line', hello: 'menubar:hello' } as const
export const TELL = { state: 'menubar:state', said: 'menubar:said' } as const

/** What the panel is told after it asked: what to say, and what to put back in a field when it was not written. */
export interface Said {
  said: string
  now?: string
  line?: string
}

/** Only in the desktop app: a test has no other window, and the phone no menu bar. */
const present = () => !onAndroid && '__TAURI_INTERNALS__' in window

/** Kept in the vault, as everything is, so a tracker running survives a quit. */
const TIMER_FILE = 'timer.json'

/** The tracker as the file has it, or none: `{}` when nothing runs. */
export function readTracking(text: string | null): Tracking | null {
  try {
    const read = JSON.parse(text ?? '{}') as Partial<Tracking>
    return typeof read.what === 'string' && read.what.trim() !== '' && typeof read.since === 'number' ? { what: read.what, since: read.since } : null
  } catch {
    return null
  }
}

/**
 * The line a stopped time goes into its day as: its start and end clocks and what it
 * was, a block the timeline draws as long as it lasted; one clock when under a minute.
 */
export function trackedLine({ what, since }: Tracking, until: Date): string {
  const [from, to] = [localTimeStamp(new Date(since)), localTimeStamp(until)]
  return from === to ? `${from} ${what}` : `${from} to ${to} ${what}`
}

/** The time tracked so far, as the menu bar shows it: `0:42`, `1:05`. */
export function elapsedText(since: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60000))
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * The main window's half: the tracker kept in `.config/timer.json`, its time beside the
 * menu bar's icon, and what the panel asks for written into a day by `file` (the
 * page's `fileEntry`, saying whether it went through). Stopping writes the time into
 * the day it started; starting something else stops what was running first.
 */
export function useMenuBar({
  vaultPath,
  file,
  say,
}: {
  vaultPath: string | null
  file: (day: string, text: string) => Promise<boolean>
  say: (message: string) => void
}) {
  const [tracking, setTracking] = useState<Tracking | null>(null)
  const latest = useRef({ vaultPath, file, say, tracking })
  latest.current = { vaultPath, file, say, tracking }

  useEffect(() => {
    if (!vaultPath) return
    readConfigFile(vaultPath, TIMER_FILE).then(
      (text) => setTracking(readTracking(text)),
      (err: unknown) => say(`The time tracker could not be read: ${String(err)}`)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath])

  useEffect(() => {
    if (!present()) return
    const tell = (said?: Said | void) => {
      void emitTo(PANEL, TELL.state, latest.current.tracking)
      if (said) void emitTo(PANEL, TELL.said, said)
    }
    const keep = async (next: Tracking | null) => {
      const { vaultPath } = latest.current
      if (!vaultPath) return
      await writeConfigFile(vaultPath, TIMER_FILE, `${JSON.stringify(next ?? {})}\n`)
      latest.current.tracking = next
      setTracking(next)
    }
    const stop = async () => {
      const { tracking, file } = latest.current
      if (!tracking) return true
      const went = await file(localDateStamp(new Date(tracking.since)), trackedLine(tracking, new Date()))
      if (went) await keep(null)
      return went
    }
    const handlers: [string, (payload: unknown) => Promise<Said | void>][] = [
      [ASK.hello, async () => {}],
      [ASK.stop, async () => ({ said: (await stop()) ? 'Written into the day’s log.' : 'The time could not be written; it is still running.' })],
      [
        ASK.start,
        async (payload) => {
          const what = String((payload as { what?: string })?.what ?? '').trim()
          if (!what) return
          if (!(await stop())) return { said: 'The time running could not be written, so nothing new was started.', now: what }
          await keep({ what, since: Date.now() })
        },
      ],
      [
        ASK.line,
        async (payload) => {
          const text = String((payload as { text?: string })?.text ?? '').trim()
          if (!text) return
          return (await latest.current.file(localDateStamp(), text)) ? { said: 'Added to today.' } : { said: 'It could not be added.', line: text }
        },
      ],
    ]
    const off = handlers.map(([event, handle]) =>
      listen(event, ({ payload }) =>
        handle(payload).then(tell, (err: unknown) => {
          latest.current.say(String(err))
          tell({ said: String(err) })
        })
      )
    )
    return () => off.forEach((one) => void one.then((unlisten) => unlisten()))
  }, [])

  // The time so far beside the icon, each half minute, and nothing when none runs. Only
  // a label: a refusal changes nothing written, so it is not said each time.
  useEffect(() => {
    if (!present()) return
    const show = () => void invoke('tray_title', { title: tracking ? elapsedText(tracking.since, Date.now()) : null }).catch(() => {})
    show()
    if (!tracking) return
    const every = setInterval(show, 30000)
    return () => clearInterval(every)
  }, [tracking])
}

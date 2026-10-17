import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import App from './App.tsx'
import { MenuBarPanel } from './MenuBarPanel'
import { PANEL } from './menuBar'
import { onAndroid, relayVisibility } from './platform'

if (onAndroid) relayVisibility()

/** The menu bar's panel is a window of its own over this page; outside Tauri there is none. */
const inPanel = (() => {
  try {
    return getCurrentWindow().label === PANEL
  } catch {
    return false
  }
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {inPanel ? <MenuBarPanel /> : <App />}
  </StrictMode>,
)

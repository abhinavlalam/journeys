import { invoke } from '@tauri-apps/api/core'

/**
 * Whether the app runs on Android, from the webview's user agent.
 * Android cannot pick a folder, run a shell or reveal a file in Finder.
 */
export const onAndroid = /Android/i.test(navigator.userAgent)

/**
 * On Android an app switch is only `visibilitychange`: the WebView sends no
 * focus or blur, and the vault read, the sync, the calendar and the lock each
 * wait for one. So each is sent from it.
 */
export function relayVisibility() {
  document.addEventListener('visibilitychange', () =>
    window.dispatchEvent(new Event(document.visibilityState === 'visible' ? 'focus' : 'blur'))
  )
}

/**
 * Paints behind Android's system bars with the page's ground, `--bg-viewer`, and
 * picks icons that read on it. The page is laid out between them (`MainActivity`).
 * The token is read through a pixel, which is sRGB bytes whatever a mix is written in.
 */
export function paintBars() {
  const probe = document.createElement('div')
  probe.style.background = 'var(--bg-viewer)'
  document.body.append(probe)
  const ground = getComputedStyle(probe).backgroundColor
  probe.remove()
  const pixel = document.createElement('canvas').getContext('2d')
  if (!pixel) return
  pixel.fillStyle = ground
  pixel.fillRect(0, 0, 1, 1)
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data
  const color = `#${[r, g, b].map((one) => one.toString(16).padStart(2, '0')).join('')}`
  // Relative luminance's weights: a light ground takes dark icons.
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 128
  void invoke('phone_paint', { color, light }).catch(() => {})
}

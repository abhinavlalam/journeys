/**
 * Whether the app runs on Android, from the webview's user agent.
 * Android cannot pick a folder, run a shell or reveal a file in Finder.
 */
export const onAndroid = /Android/i.test(navigator.userAgent)

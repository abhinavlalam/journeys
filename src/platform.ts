/**
 * Whether the app is running on Android, read off the webview's user agent: the one
 * fact wanted is which of two platforms this is, and a plugin to answer a string
 * test would be a package for nothing. What differs there is what Android has no
 * way to do — pick a folder, run a shell, reveal a file in Finder.
 */
export const onAndroid = /Android/i.test(navigator.userAgent)

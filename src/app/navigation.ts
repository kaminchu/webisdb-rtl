import { Screen, store } from './store'

const VALID_SCREENS = new Set<string>(Object.values(Screen))

function parseHash(hash: string): Screen | null {
  const value = hash.replace(/^#\/?/, '')
  return VALID_SCREENS.has(value) ? (value as Screen) : null
}

/** Navigate to a screen by updating the URL hash (SPA, single URL — 要件定義書 7). */
export function navigate(screen: Screen): void {
  if (parseHash(location.hash) === screen) return
  location.hash = screen
}

function applyHashToStore(): void {
  const screen = parseHash(location.hash)
  if (screen) store.setState({ screen })
}

/** Sync the store with the current hash and listen for changes. */
export function startHashNavigation(): () => void {
  applyHashToStore()
  window.addEventListener('hashchange', applyHashToStore)
  return () => window.removeEventListener('hashchange', applyHashToStore)
}

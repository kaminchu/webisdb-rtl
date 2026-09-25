/** Registers the PWA service worker in production builds. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  if (window.crossOriginIsolated) {
    sessionStorage.removeItem('coi-reloaded')
  }

  window.addEventListener('load', () => {
    const swUrl = new URL('sw.js', document.baseURI).href
    navigator.serviceWorker
      .register(swUrl, { scope: new URL('./', document.baseURI).pathname })
      .then(() => reloadForIsolation())
      .catch((error) => {
        console.warn('[sw] registration failed', error)
      })
  })
}

/**
 * The PWA worker injects COOP/COEP so WebAssembly threads work on hosts that
 * cannot set headers (GitHub Pages). Cross-origin isolation only applies to
 * pages loaded after the worker takes control, so reload once.
 */
function reloadForIsolation(): void {
  if (window.crossOriginIsolated) return
  if (sessionStorage.getItem('coi-reloaded') === '1') return
  if (navigator.serviceWorker.controller) {
    reloadOnce()
  } else {
    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true })
  }
}

function reloadOnce(): void {
  sessionStorage.setItem('coi-reloaded', '1')
  window.location.reload()
}

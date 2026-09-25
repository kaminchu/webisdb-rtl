/** Registers the PWA service worker in production builds. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    const swUrl = new URL('sw.js', document.baseURI).href
    navigator.serviceWorker
      .register(swUrl, { scope: new URL('./', document.baseURI).pathname })
      .catch((error) => {
        console.warn('[sw] registration failed', error)
      })
  })
}

/* WebISDB-RTL service worker (要件定義書 10, 43 Phase 8). */
/* Hand-written, no build step. Bump CACHE_VERSION to invalidate. */

const CACHE_VERSION = 'webisdb-rtl-v1'
const SHELL_CACHE = `${CACHE_VERSION}-shell`
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`
const DATA_CACHE = `${CACHE_VERSION}-data`

const BASE = new URL('./', self.location).pathname
const SHELL_ASSETS = [
  BASE,
  `${BASE}index.html`,
  `${BASE}manifest.webmanifest`,
  `${BASE}icons/icon.svg`,
  `${BASE}icons/icon-192.png`,
  `${BASE}icons/icon-512.png`,
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => !key.startsWith(CACHE_VERSION)).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

function isChannelData(url) {
  return url.pathname.includes('/data/japan/') && url.pathname.endsWith('.json')
}

// GitHub Pages cannot serve COOP/COEP headers, so inject them here to enable
// SharedArrayBuffer / WebAssembly threads (see registerServiceWorker).
function addIsolationHeaders(response) {
  if (!response || response.status === 0 || response.type === 'opaque') return response
  const headers = new Headers(response.headers)
  if (!headers.has('Cross-Origin-Opener-Policy')) {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  }
  if (!headers.has('Cross-Origin-Embedder-Policy')) {
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone())
      return response
    })
    .catch(() => cached)
  return cached || network
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request)
    if (response && response.ok) cache.put(`${BASE}index.html`, response.clone())
    return response
  } catch {
    return (await cache.match(`${BASE}index.html`)) || (await cache.match(BASE)) || Response.error()
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request).then(addIsolationHeaders))
    return
  }

  if (isChannelData(url)) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE).then(addIsolationHeaders))
    return
  }

  event.respondWith(
    caches
      .match(request)
      .then((cached) => {
        if (cached) return cached
        return fetch(request)
          .then((response) => {
            if (response && response.ok && url.pathname.startsWith(BASE)) {
              const copy = response.clone()
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy))
            }
            return response
          })
          .catch(() => cached || Response.error())
      })
      .then(addIsolationHeaders),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting()
})

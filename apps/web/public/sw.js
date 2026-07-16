const CACHE_PREFIX = 'p2p-transmission-'
 const CACHE_NAME = `${CACHE_PREFIX}static`
const STATIC_ASSETS = [
  '/favicon.svg',
  '/icons.svg',
  '/fonts/material-symbols-outlined.woff2',
]
const STATIC_ASSET_PATHS = new Set(STATIC_ASSETS)

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)),
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map(key => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (
    url.origin !== self.location.origin
    || url.search !== ''
    || request.headers.has('authorization')
    || !STATIC_ASSET_PATHS.has(url.pathname)
  ) return

  event.respondWith(
    caches.open(CACHE_NAME).then(cache => cache.match(request).then(cached => {
      if (cached) return cached

      return fetch(request).then(response => {
        if (response.ok && response.type === 'basic') {
          const clone = response.clone()
          void cache.put(request, clone)
        }
        return response
      })
    })),
  )
})

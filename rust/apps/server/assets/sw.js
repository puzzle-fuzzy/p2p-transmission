const CACHE_PREFIX = 'p2p-transmission-';
const CACHE_NAME = `${CACHE_PREFIX}v2-shell`;
const SHELL_ASSETS = [
  '/',
  '/app',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/shell/app-shell.js',
  '/shell/landing.css',
  '/shell/landing.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map(key => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

const networkFirst = async request => {
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const landing = await caches.match('/');
    if (landing) return landing;
    throw error;
  }
};

const staleWhileRevalidate = async request => {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  const refresh = fetch(request).then(response => {
    if (response.ok) void cache.put(request, response.clone());
    return response;
  }).catch(error => {
    if (cached) return cached;
    throw error;
  });
  return cached ?? refresh;
};

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(?:api|health|realtime)(?:\/|$)/u.test(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (/^\/(?:assets|shell)\//u.test(url.pathname)
      || url.pathname === '/favicon.svg'
      || url.pathname === '/manifest.webmanifest') {
    event.respondWith(staleWhileRevalidate(request));
  }
});

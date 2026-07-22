const CACHE_PREFIX = 'p2p-transmission-';
const RELEASE = '__P2P_RELEASE__';
const CACHE_NAME = `${CACHE_PREFIX}${RELEASE}`;
const SHELL_ASSET_PATHS = new Set([
  '/shell/app-shell.css',
  '/shell/room-restore.js',
  '/shell/app-shell.js',
]);
const CURRENT_SHELL_ASSETS = [...SHELL_ASSET_PATHS]
  .map(path => `${path}?v=${encodeURIComponent(RELEASE)}`);
const CORE_ASSETS = [
  '/',
  '/favicon.svg',
  '/favicon.ico',
  '/manifest.webmanifest',
  ...CURRENT_SHELL_ASSETS,
];

const offlineResponse = () => new Response('离线时无法访问此地址', {
  status: 503,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
});

const sameOriginAppAsset = value => {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return null;
    if (url.pathname === '/'
        || /^\/(?:assets|shell)\//u.test(url.pathname)
        || url.pathname === '/favicon.svg'
        || url.pathname === '/favicon.ico'
        || url.pathname === '/manifest.webmanifest') {
      return url.href;
    }
  } catch {
    // Ignore malformed or non-URL attributes in the generated shell.
  }
  return null;
};

const applicationShellMatchesRelease = html => {
  const expected = new Set(CURRENT_SHELL_ASSETS.map(value => new URL(
    value,
    self.location.origin,
  ).href));
  const observed = [];
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/gu)) {
    const asset = sameOriginAppAsset(match[1]);
    if (asset && SHELL_ASSET_PATHS.has(new URL(asset).pathname)) observed.push(asset);
  }
  return observed.length === expected.size
    && new Set(observed).size === expected.size
    && observed.every(asset => expected.has(asset));
};

const cacheAsset = async (cache, url) => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`unable to cache ${url}: ${response.status}`);
  await cache.put(url, response.clone());
  return response;
};

const cacheApplication = async () => {
  const cache = await caches.open(CACHE_NAME);
  const shell = await fetch('/', { cache: 'no-store' });
  if (!shell.ok) throw new Error(`unable to cache /: ${shell.status}`);
  const html = await shell.clone().text();
  if (!applicationShellMatchesRelease(html)) {
    throw new Error('application shell does not match this service worker release');
  }
  await cache.put('/', shell.clone());
  const assets = new Set(CORE_ASSETS.slice(1).map(value => new URL(
    value,
    self.location.origin,
  ).href));

  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/gu)) {
    const asset = sameOriginAppAsset(match[1]);
    if (asset) assets.add(asset);
  }

  const wasmAssets = new Set();
  for (const asset of assets) {
    const response = await cacheAsset(cache, asset);
    const pathname = new URL(asset).pathname;
    if (!/^\/assets\/.*\.js$/u.test(pathname)) continue;
    const source = await response.text();
    for (const match of source.matchAll(/["']([^"']*\/assets\/[^"']+\.wasm)["']/gu)) {
      const wasm = sameOriginAppAsset(match[1]);
      if (wasm) wasmAssets.add(wasm);
    }
  }
  await Promise.all([...wasmAssets].map(asset => cacheAsset(cache, asset)));
};

self.addEventListener('install', event => {
  event.waitUntil(cacheApplication().then(() => self.skipWaiting()));
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

const networkFirstApplication = async request => {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok && new URL(response.url).pathname === '/') {
      const html = await response.clone().text();
      if (applicationShellMatchesRelease(html)) {
        await cache.put('/', response.clone());
      }
    }
    return response;
  } catch {
    return await cache.match('/') ?? offlineResponse();
  }
};

const networkFirstAsset = async request => {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return await cache.match(request) ?? offlineResponse();
  }
};

const currentReleaseShellAsset = url => {
  const query = [...url.searchParams.entries()];
  return SHELL_ASSET_PATHS.has(url.pathname)
    && query.length === 1
    && query[0][0] === 'v'
    && query[0][1] === RELEASE;
};

const cacheFirstShellAsset = async request => {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return offlineResponse();
  }
};

const staleWhileRevalidate = async request => {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
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
    if (url.pathname === '/') {
      event.respondWith(networkFirstApplication(request));
    } else {
      event.respondWith(fetch(request).catch(offlineResponse));
    }
    return;
  }
  if (/^\/assets\//u.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (SHELL_ASSET_PATHS.has(url.pathname) && currentReleaseShellAsset(url)) {
    event.respondWith(cacheFirstShellAsset(request));
    return;
  }
  if (url.pathname === '/favicon.svg'
      || url.pathname === '/favicon.ico'
      || url.pathname === '/manifest.webmanifest') {
    event.respondWith(networkFirstAsset(request));
  }
});

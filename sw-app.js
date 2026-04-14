// Dynasty Tools iOS PWA — Service Worker
// Registered at ./sw-app.js so scope is /dynasty-tools/
const CACHE = 'dynasty-app-v76';

// Pre-cache the app shell on install
const SHELL = [
  './app.html',
  './manifest.json',
  './icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Proxy API calls — always network, never cache
  if (url.hostname === '100.85.44.43') {
    e.respondWith(fetch(e.request).catch(() => new Response('Offline', { status: 503 })));
    return;
  }

  // Google Fonts — network first, cache fallback
  if (url.hostname.includes('fonts.g')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // App shell — cache first, update in background (stale-while-revalidate)
  // This ensures offline always works even if not visited recently
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const networkFetch = fetch(e.request).then(res => {
          if (res.ok && e.request.method === 'GET') {
            cache.put(e.request, res.clone());
          }
          return res;
        }).catch(() => null);
        // Serve cache immediately if available; otherwise wait for network
        return cached || networkFetch;
      })
    )
  );
});

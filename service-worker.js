// Wotchly Service Worker v4.0
const CACHE_VERSION = 'wotchly-v4';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;

// Only cache non-CSS static assets on install
// CSS uses network-first so it's always fresh
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/room.html',
  '/manifest.json',
  '/favicon-32.png',
];

// Install — cache only essential shell assets
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'no-store' }))))
      .catch(() => {})
  );
});

// Activate — delete ALL old caches so stale CSS is wiped
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - CSS/JS assets → network-first (always fresh, cache as fallback)
// - Everything else → stale-while-revalidate
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Pass through non-GET and external requests
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;
  if (url.hostname.includes('firebase') || url.hostname.includes('firebaseio')) return;
  if (url.hostname.includes('youtube') || url.hostname.includes('youtu.be') || url.hostname.includes('vimeo')) return;
  if (url.hostname.includes('googleapis') || url.hostname.includes('gstatic')) return;
  if (!url.origin.includes(self.location.origin)) return;

  const isCSSorJS = url.pathname.endsWith('.css') || url.pathname.endsWith('.js');

  if (isCSSorJS) {
    // Network-first: always fetch fresh CSS/JS, fall back to cache only if offline
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(DYNAMIC_CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
  } else {
    // Stale-while-revalidate for HTML and other assets
    event.respondWith(
      caches.match(request).then(cached => {
        const networkFetch = fetch(request)
          .then(response => {
            if (response && response.status === 200 && response.type === 'basic') {
              const clone = response.clone();
              caches.open(DYNAMIC_CACHE).then(cache => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkFetch;
      })
    );
  }
});

// Message handler
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

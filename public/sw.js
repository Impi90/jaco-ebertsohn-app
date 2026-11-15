// Service worker: lets the app install to a phone's home screen and keeps exercise photos on the phone.
// The app page is always fetched fresh when online (so updates arrive straight away); the saved copy is
// only used when there's no connection. Sign-in and data requests (/api/) are never cached.
const SHELL = 'je-shell-v1';
const IMAGES = 'je-img-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/img/logo.png'])).catch(() => {}));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== IMAGES) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/_blob/') || p === '/healthz' || p === '/sw.js') return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then(res => {
      if (res.ok && p === '/') { const copy = res.clone(); caches.open(SHELL).then(c => c.put('/', copy)); }
      return res;
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }

  if (p.startsWith('/img/')) {
    event.respondWith(caches.open(IMAGES).then(async cache => {
      const hit = await cache.match(req);
      const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; });
      if (hit) { fresh.catch(() => {}); return hit; }
      return fresh;
    }));
  }
});

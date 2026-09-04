/* Boiler Route service worker: cache-first for the app shell, so the campus
   works offline once visited. The OSM data bundle uses stale-while-revalidate
   so a weekly refresh lands without blocking startup. */
const CACHE = 'boiler-route-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // weather + Overpass go to the network

  if (url.pathname.endsWith('boiler-route-data.json')) {
    // stale-while-revalidate
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const cached = await c.match(e.request);
        const fetching = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => cached);
        return cached || fetching;
      }),
    );
    return;
  }

  // app shell: cache-first, fill the cache from the network
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const cached = await c.match(e.request);
      if (cached) return cached;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }),
  );
});

/* Boiler Route service worker: cache-first for the app shell, so the campus
   works offline once visited. The OSM data bundle uses stale-while-revalidate
   so a weekly refresh lands without blocking startup. */
const CACHE = 'boiler-route-v12';

/* The whole campus is ~200 KB gzipped, so pull it down on install: after one
   visit the map, buildings, heights and canopy all work with no network. */
const PRECACHE = [
  './', './boiler-route-data.json', './campus-heights.json',
  './manifest.webmanifest', './icon.svg', './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // one missing file must not abort the install
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
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

  if (url.pathname.endsWith('boiler-route-data.json') || url.pathname.endsWith('campus-heights.json')) {
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

  if (e.request.mode === 'navigate') {
    // the HTML shell: network-first so deploys land, cache fallback for offline
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        try {
          const r = await fetch(e.request);
          if (r.ok) c.put(e.request, r.clone());
          return r;
        } catch {
          return (await c.match(e.request)) || (await c.match('./'));
        }
      }),
    );
    return;
  }

  // hashed assets: cache-first, fill the cache from the network
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

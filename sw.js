// Service worker: keeps the app itself available offline.
// When you change any file, raise the version number below so phones pick up the update.
const VERSION = 'stock-v4';
const SHELL = [
  './', 'index.html', 'runtime.js', 'config.js', 'manifest.webmanifest', 'd3.min.js',
  'sp500.json', 'watchlist.json', 'fundamentals.json',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only the app's own files; live prices from Google go straight to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Pages, the config and the SEC file (GitHub refreshes it twice a day): network first; cache when offline.
  if (req.mode === 'navigate' || url.pathname.endsWith('/config.js') || url.pathname.endsWith('/fundamentals.json')) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req.mode === 'navigate' ? 'index.html' : req, copy));
        return res;
      }).catch(() => caches.match(req.mode === 'navigate' ? 'index.html' : req))
    );
    return;
  }
  // Everything else: cache first, then network.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});

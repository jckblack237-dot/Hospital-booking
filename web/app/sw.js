// Minimal service worker: enough for "Add to Home Screen" and an offline shell.
// The shell is fetched from the network first so a new release reaches every
// phone on its next open; the cache is only a fallback for when the network
// is gone. Live queue data is never cached — a stale ETA presented as live is
// the one thing this product must never do.
const SHELL = 'vaguthu-shell-v2';
const ASSETS = ['/app/', '/app/index.html', '/app/app.js', '/app/app.css', '/shared/core.js', '/shared/tokens.css', '/shared/ui.css', '/app/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return; // network only
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && url.origin === location.origin) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request)),
  );
});

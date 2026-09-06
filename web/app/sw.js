// Minimal service worker: enough for "Add to Home Screen" and an offline shell.
// Live queue data is never cached — a stale ETA presented as live is the one
// thing this product must never do.
const SHELL = 'vaguthu-shell-v1';
const ASSETS = ['/app/', '/app/index.html', '/app/app.js', '/app/app.css', '/shared/core.js', '/shared/tokens.css', '/shared/ui.css', '/app/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return; // network only
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});

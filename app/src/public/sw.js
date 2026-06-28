// Minimal service worker — enables PWA install + offline-tolerant shell.
// Network-first for everything; falls back to cache. API and uploads are never cached
// (always fetched live), so dynamic data / sessions are never stale.
const CACHE = 'snapdini-v3';
const SHELL = ['/', '/app', '/css/style.css', '/js/util.js', '/icon.svg', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return; // live only
  // Always go to the network and BYPASS the browser HTTP cache ('reload') so a normal
  // refresh always pulls the latest build. The cache is only a fallback when offline.
  e.respondWith(
    fetch(e.request, { cache: 'reload' }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});

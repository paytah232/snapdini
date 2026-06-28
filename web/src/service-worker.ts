/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

// Offline app shell: precache the built app + static files so the camera/app loads with NO
// network once it's been opened — pairs with the IndexedDB capture queue (captures persist
// and upload when the server returns). API + uploads always go to the network (never cached).
const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `snapdini-${version}`;
const PRECACHE = [...build, ...files];

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await sw.clients.claim();
  })());
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  // Dynamic — must hit the network (and is what queues offline): API + media.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
  event.respondWith(handle(req, url));
});

async function handle(req: Request, url: URL): Promise<Response> {
  const cache = await caches.open(CACHE);
  // Immutable build assets → cache-first.
  if (PRECACHE.includes(url.pathname)) {
    const hit = await cache.match(url.pathname);
    if (hit) return hit;
  }
  // Otherwise network-first, caching successful page navigations for offline reload.
  try {
    const res = await fetch(req);
    if (res.ok && req.mode === 'navigate') cache.put(req, res.clone());
    return res;
  } catch {
    const cached = (await cache.match(req)) || (await cache.match('/'));
    if (cached) return cached;
    return new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}

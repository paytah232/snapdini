/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

// Offline app shell: precache the built app + static files so the camera/app loads with NO
// network once it's been opened — pairs with the IndexedDB capture queue (captures persist
// and upload when the server returns). API + uploads always go to the network (never cached).
const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE_PREFIX = 'snapdini-main-';
const CACHE = `${CACHE_PREFIX}${version}`;
const PRECACHE = [...build, ...files].filter((path) => path !== '/guest' && !path.startsWith('/guest/'));

sw.addEventListener('install', (event) => {
  // Let existing cameras finish on their loaded build, including pending uploads. The browser
  // activates this worker when the previous worker no longer has clients; never force a swap.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // CacheStorage is shared by all workers on this origin, including the /guest/ camera.
    // Historical `snapdini-${version}` names have no explicit owner; retain them rather than
    // guessing and deleting another application's cache. New main caches have this namespace.
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
    }
  })());
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname === '/guest' || url.pathname.startsWith('/guest/')) return;
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

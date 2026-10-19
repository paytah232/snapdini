/** Build inserts the exact public asset allowlist; no API, settings, or media is cached here. */
export function guestServiceWorker(version: string, assets: string[]): string {
  return `
const CACHE = ${JSON.stringify(`snapdini-guest-${version}`)};
const ASSETS = ${JSON.stringify([...new Set(['/guest/index.html', ...assets])])};
const SHELL = '/guest/index.html';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
// No skipWaiting, clients.claim, or cache deletion: an open camera finishes on its loaded build.
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigation = request.mode === 'navigate' && /^\\/guest\\/(?:$|(?:join|e|saved)\\/[^/]+\\/?$)/.test(url.pathname)
    || request.mode === 'navigate' && /^\\/(?:join|e)\\/[^/]+\\/?$/.test(url.pathname);
  if (navigation) {
    event.respondWith(fetch(request).then(response => {
      if (!response.ok) throw new Error('Guest shell unavailable');
      return response;
    }).catch(() => caches.open(CACHE).then(cache => cache.match(SHELL))));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(request)));
  }
});
`;
}

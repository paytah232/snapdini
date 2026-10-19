import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../guest-dist/sw.js', import.meta.url), 'utf8');
function harness() {
  const listeners = {};
  const cachedShell = new Response('<html>cached camera</html>');
  const cached = new Map();
  const cache = {
    match: async key => cached.get(key),
    addAll: async keys => { for (const key of keys) cached.set(key, key === '/guest/index.html' ? cachedShell : new Response('asset')); },
  };
  vm.runInNewContext(worker, {
    self: { location: { origin: 'https://example.test' }, addEventListener: (type, handler) => { listeners[type] = handler; } },
    caches: { open: async () => cache },
    URL,
    fetch: async () => { throw new Error('offline'); },
  });
  return { listeners, cachedShell, cached };
}
function request(listeners, pathname, mode = 'cors') {
  let response;
  listeners.fetch({ request: { method: 'GET', url: `https://example.test${pathname}`, mode }, respondWith: promise => { response = promise; } });
  return response;
}
test('offline guest deep links recover the camera shell', async () => {
  const { listeners, cachedShell, cached } = harness();
  let installed;
  listeners.install({ waitUntil: promise => { installed = promise; } });
  await installed;
  assert.ok(cached.has('/guest/index.html'), 'install must cache the shell, not assume it already exists');
  for (const path of ['/guest/', '/guest/join/ABCDEFGH', '/guest/e/wedding', '/guest/saved/ABCDEFGH', '/join/ABCDEFGH', '/e/wedding']) {
    assert.equal(await request(listeners, path, 'navigate'), cachedShell);
  }
});
test('API, recovery manifests, media, and other site routes never enter shell cache', () => {
  const { listeners } = harness();
  for (const path of ['/api/events/ABCDEFGH', '/guest/events/ABCDEFGH.json', '/uploads/event/photo.jpg', '/siteadmin']) {
    assert.equal(request(listeners, path), undefined);
    assert.equal(request(listeners, path, 'navigate'), undefined);
  }
});
test('updates do not force activation or delete previous build caches', () => {
  const { listeners } = harness();
  assert.equal(listeners.activate, undefined);
  assert.doesNotMatch(worker, /self\.skipWaiting\(|clients\.claim\(|caches\.delete\(/);
});

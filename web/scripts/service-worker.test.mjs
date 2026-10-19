import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { IDBFactory } from 'fake-indexeddb';

const mainSource = readFileSync(new URL('../src/service-worker.ts', import.meta.url), 'utf8');
const guestSource = readFileSync(new URL('../guest/service-worker.ts', import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function cacheStorage() {
  const stores = new Map();
  return {
    stores,
    keys: async () => [...stores.keys()],
    delete: async key => stores.delete(key),
    open: async key => {
      if (!stores.has(key)) stores.set(key, new Map());
      const entries = stores.get(key);
      return {
        addAll: async paths => { for (const path of paths) entries.set(path, new Response(`${key}:${path}`)); },
        match: async request => entries.get(typeof request === 'string' ? request : new URL(request.url).pathname)?.clone(),
        put: async (request, response) => entries.set(typeof request === 'string' ? request : new URL(request.url).pathname, response),
      };
    },
  };
}
function worker(source, caches, build = {}) {
  const listeners = {};
  const calls = { skipWaiting: 0, claim: 0 };
  const context = {
    exports: {}, require: name => { assert.equal(name, '$service-worker'); return build; },
    self: {
      location: { origin: 'https://example.test' },
      addEventListener: (type, listener) => { listeners[type] = listener; },
      skipWaiting: () => { calls.skipWaiting++; },
      clients: { claim: () => { calls.claim++; } },
    },
    caches, URL, Response,
    fetch: async () => { throw new Error('origin unavailable'); },
  };
  vm.runInNewContext(source, context);
  return {
    calls, listeners,
    lifecycle: async type => {
      let work;
      listeners[type]?.({ waitUntil: promise => { work = promise; } });
      await work;
    },
    request: (path, mode = 'navigate', method = 'GET') => {
      let result;
      listeners.fetch({ request: { method, mode, url: `https://example.test${path}` }, respondWith: promise => { result = promise; } });
      return result;
    },
  };
}
const main = (caches, version) => worker(compile(mainSource), caches, {
  version, build: [`/_app/immutable/${version}.js`], files: ['/favicon.png', '/guest/index.html', '/guest/assets/camera.js'],
});
function guest(caches, version) {
  const context = { exports: {} };
  vm.runInNewContext(compile(guestSource), context);
  return worker(context.exports.guestServiceWorker(version, [`/guest/assets/${version}.js`]), caches);
}
async function seedQueue() {
  const indexedDB = new IDBFactory();
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('snapdini-captures', 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('queue', { keyPath: 'id' });
      request.result.createObjectStore('progress', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const capture = { id: 'capture-pending', joinCode: 'TESTCODE', sessionToken: 'original-guest', blob: new Blob(['irreplaceable photo bytes']), capturedAt: 1234 };
  const progress = { id: capture.id, uploadId: 'upload-original', doneChunks: [0, 1] };
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['queue', 'progress'], 'readwrite');
    transaction.objectStore('queue').put(capture);
    transaction.objectStore('progress').put(progress);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  return { db, capture, progress };
}
async function assertQueue({ db, capture, progress }) {
  const get = store => new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(capture.id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const saved = await get('queue');
  assert.equal(db.version, 2);
  assert.equal(saved.sessionToken, capture.sessionToken);
  assert.equal(saved.capturedAt, capture.capturedAt);
  assert.equal(await saved.blob.text(), await capture.blob.text());
  assert.deepEqual(await get('progress'), progress);
}

test('main activation deletes only explicitly owned old main caches', async () => {
  const caches = cacheStorage();
  const retained = ['snapdini-guest-old', 'snapdini-guest-new', 'snapdini-1720000000000', 'snapdini-custom', 'other-app-cache'];
  for (const key of [...retained, 'snapdini-main-old']) await (await caches.open(key)).addAll(['/kept']);
  const next = main(caches, 'new');
  await next.lifecycle('install');
  await next.lifecycle('activate');
  assert.deepEqual((await caches.keys()).sort(), [...retained, 'snapdini-main-new'].sort());
  for (const key of retained) assert.ok(await (await caches.open(key)).match('/kept'));
  assert.equal(await (await caches.open('snapdini-main-new')).match('/guest/index.html'), undefined);
  assert.equal(await (await caches.open('snapdini-main-new')).match('/guest/assets/camera.js'), undefined);
  assert.deepEqual(next.calls, { skipWaiting: 0, claim: 0 });
});

test('installing main and guest updates leaves active camera assets and pending originals intact', async () => {
  const caches = cacheStorage();
  const pending = await seedQueue();
  try {
    const oldMain = main(caches, 'old');
    const oldGuest = guest(caches, 'old');
    await oldMain.lifecycle('install');
    await oldGuest.lifecycle('install');
    await (await caches.open('snapdini-main-old')).put('/join/TESTCODE',
      new Response('<script src="/_app/immutable/old.js"></script>'));
    const nextMain = main(caches, 'new');
    const nextGuest = guest(caches, 'new');
    await nextMain.lifecycle('install');
    await nextGuest.lifecycle('install');
    assert.deepEqual(nextMain.calls, { skipWaiting: 0, claim: 0 });
    assert.deepEqual(nextGuest.calls, { skipWaiting: 0, claim: 0 });
    // Reloading an already-open normal camera still receives HTML and immutable assets from
    // the same build, rather than an old document referring to assets removed by a new worker.
    const oldHtml = await (await oldMain.request('/join/TESTCODE')).text();
    assert.match(oldHtml, /src="\/_app\/immutable\/old\.js"/);
    assert.match(await (await oldMain.request('/_app/immutable/old.js', 'cors')).text(), /snapdini-main-old/);
    assert.match(await (await oldGuest.request('/guest/join/TESTCODE')).text(), /snapdini-guest-old/);
    await assertQueue(pending);
    // Once old main clients have closed, normal activation may clean their main cache. An
    // independently scoped guest camera can remain open and must still reload its old shell.
    await nextMain.lifecycle('activate');
    await nextGuest.lifecycle('activate');
    assert.match(await (await oldGuest.request('/guest/join/TESTCODE')).text(), /snapdini-guest-old/);
    assert.match(await (await oldGuest.request('/guest/assets/old.js', 'cors')).text(), /snapdini-guest-old/);
    await assertQueue(pending);
  } finally { pending.db.close(); }
});

test('main worker leaves guest cameras, API and media to their owners', () => {
  const current = main(cacheStorage(), 'current');
  for (const path of ['/guest', '/guest/join/TESTCODE', '/api/photos', '/uploads/event/photo.jpg']) {
    assert.equal(current.request(path), undefined, path);
  }
  assert.equal(current.request('/account', 'cors', 'POST'), undefined);
});

test('normal self-hosted links retain root-worker navigation caching without guest hosting', async () => {
  const caches = cacheStorage();
  const current = main(caches, 'current');
  const cache = await caches.open('snapdini-main-current');
  for (const path of ['/join/TESTCODE', '/e/wedding']) {
    await cache.put(path, new Response(`original session shell:${path}`));
    assert.equal(await (await current.request(path)).text(), `original session shell:${path}`);
  }
});

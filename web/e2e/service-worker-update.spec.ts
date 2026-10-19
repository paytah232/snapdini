import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { guestServiceWorker } from '../guest/service-worker';

test.skip(({ browserName }) => browserName !== 'chromium', 'Real Chromium worker lifecycle gate; phone acceptance is separate.');
test.use({ serviceWorkers: 'allow' });
test.setTimeout(60_000);

test('a waiting camera update preserves active assets, queued originals and chunk resume across activation', async ({ context }) => {
  let version = 'old';
  let refuseOldAsset = false;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/guest/sw.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.setHeader('Service-Worker-Allowed', '/');
      response.end(guestServiceWorker(version, [`/guest/assets/${version}.js`]));
    } else if (pathname.startsWith('/guest/assets/')) {
      if (refuseOldAsset && pathname.endsWith('/old.js')) { response.writeHead(503); response.end(); return; }
      response.setHeader('Content-Type', 'application/javascript');
      response.end(`window.cameraAsset = ${JSON.stringify(pathname)};`);
    } else if (pathname === '/guest/index.html' || pathname === '/join/TESTCODE') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Camera ${version}</title><script src="/guest/assets/${version}.js"></script>`);
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Worker monitor</title>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/join/TESTCODE`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/guest/sw.js', { scope: '/join/', updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('snapdini-captures', 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('queue', { keyPath: 'id' });
          request.result.createObjectStore('progress', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['queue', 'progress'], 'readwrite');
        transaction.objectStore('queue').put({ id: 'pending-capture', joinCode: 'TESTCODE',
          sessionToken: 'original-guest', blob: new Blob(['original camera bytes']), capturedAt: 123456,
          mediaType: 'photo', ext: 'jpg', createdAt: 123456 });
        transaction.objectStore('progress').put({ id: 'pending-capture', uploadId: 'original-upload', doneChunks: [0, 1] });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    });

    version = 'new';
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration('/join/'))!.update(); });
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/join/'))?.waiting?.state)).toBe('installed');
    refuseOldAsset = true;
    expect(await page.evaluate(async () => (await fetch('/guest/assets/old.js')).text())).toContain('/guest/assets/old.js');
    // Origin failure while the update waits must still reload the old shell and its matching
    // immutable asset. A forced worker replacement/cache cleanup breaks this exact sequence.
    await context.setOffline(true);
    await page.reload();
    await expect(page).toHaveTitle('Camera old');
    expect(await page.evaluate(() => (window as unknown as { cameraAsset: string }).cameraAsset)).toBe('/guest/assets/old.js');
    await assertOriginal(page);
    await context.setOffline(false);

    // A monitor outside the /join/ scope does not keep the previous guest worker alive.
    const monitor = await context.newPage();
    await monitor.goto(`${origin}/monitor`);
    await page.close();
    await expect.poll(() => monitor.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/join/');
      return { waiting: !!registration?.waiting, active: registration?.active?.state };
    })).toEqual({ waiting: false, active: 'activated' });
    const reopened = await context.newPage();
    await reopened.goto(`${origin}/join/TESTCODE`);
    await expect(reopened).toHaveTitle('Camera new');
    expect(await reopened.evaluate(() => (window as unknown as { cameraAsset: string }).cameraAsset)).toBe('/guest/assets/new.js');
    await assertOriginal(reopened);
    const names = await reopened.evaluate(() => caches.keys());
    expect(names).toEqual(expect.arrayContaining(['snapdini-guest-old', 'snapdini-guest-new']));
  } finally {
    await context.setOffline(false);
    for (const browserPage of context.pages()) await browserPage.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

async function assertOriginal(page: import('@playwright/test').Page) {
  const saved = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('snapdini-captures', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const get = (store: string) => new Promise<any>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get('pending-capture');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const capture = await get('queue');
      return { sessionToken: capture.sessionToken, capturedAt: capture.capturedAt,
        bytes: await capture.blob.text(), progress: await get('progress'), version: db.version };
    } finally { db.close(); }
  });
  expect(saved).toEqual({ sessionToken: 'original-guest', capturedAt: 123456,
    bytes: 'original camera bytes', version: 2,
    progress: { id: 'pending-capture', uploadId: 'original-upload', doneChunks: [0, 1] } });
}

import { test, expect } from '@playwright/test';

test.skip(({ browserName }) => browserName !== 'chromium', 'This fixture uses Chromium fake camera devices; physical Safari acceptance is separate.');
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['camera', 'microphone'], serviceWorkers: 'allow' });
test.setTimeout(120_000);
let code: string;
let organizer: string;

test.beforeEach(async ({ request }) => {
  code = ''; organizer = '';
  const response = await request.post('/api/events/demo');
  expect(response.ok()).toBeTruthy();
  const event = await response.json(); code = event.joinCode; organizer = event.organizerCode;
  await expect.poll(async () => (await request.get(`/guest/events/${code}.json`)).status(),
    { timeout: 75_000, intervals: [500, 1000, 2000] }).toBe(200);
});
test.afterEach(async ({ request }) => {
  if (code && organizer) {
    const response = await request.delete(`/api/events/${code}`, { headers: { 'x-organizer-code': organizer } });
    expect(response.status()).toBe(200);
  }
});
async function queued(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('snapdini-captures', 2);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    if (!db.objectStoreNames.contains('queue')) { db.close(); return []; }
    const rows = await new Promise<{ id: string; sessionToken: string }[]>((resolve, reject) => {
      const r = db.transaction('queue').objectStore('queue').getAll();
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    }); db.close(); return rows;
  });
}

test('fresh outage guest captures, reloads, reconciles once and drains durable queue', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Temporarily unavailable"}' }));
  await page.goto(`/guest/join/${code}`);
  await page.locator('#join-name').fill('Outage guest');
  await page.getByRole('button', { name: 'Join & open camera' }).click();
  const shutter = page.getByRole('button', { name: 'Take photo', exact: true });
  await expect(shutter).toBeEnabled();
  await expect.poll(() => page.locator('.viewfinder video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0); await shutter.click();
  await expect.poll(async () => (await queued(page)).length).toBe(1);
  const [original] = await queued(page); expect(original.sessionToken).toMatch(/^offline_/);
  await page.reload();
  await expect(shutter).toBeEnabled();
  await expect.poll(() => page.locator('.viewfinder video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await expect.poll(async () => (await queued(page)).map(row => row.id)).toEqual([original.id]);
  await shutter.click();
  await expect.poll(async () => (await queued(page)).length).toBe(2);
  for (let count = 3; count <= 12; count++) {
    await shutter.click();
    await expect.poll(async () => (await queued(page)).length).toBe(count);
  }
  await expect(shutter).toBeDisabled();
  await page.reload();
  await expect(shutter).toBeDisabled();
  await shutter.evaluate(button => (button as HTMLButtonElement).click());
  expect((await queued(page)).length).toBe(12); // Reload and another press cannot reset the roll.
  await page.unroute('**/api/**');
  // Admission succeeds while /me remains unavailable: the token handoff must survive reload.
  await page.route('**/api/participants/me', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await queued(page)).length, { timeout: 40_000 }).toBe(0);
  const token = await page.evaluate(code => localStorage.getItem(`session_${code}`), code);
  expect(token).not.toMatch(/^offline_/);
  const me = await (await request.get('/api/participants/me', { headers: { 'x-session-token': token! } })).json();
  expect(me.participant.photosTaken).toBe(12);
  const snapshot = await (await request.get(`/api/events/${code}`)).json();
  // A demo begins with its own seeded participant. Exactly one additional guest was admitted.
  expect(snapshot.participantCount).toBe(2); expect(snapshot.photoCount).toBe(12);
  await page.reload(); await expect(shutter).toBeDisabled();
  expect(await queued(page)).toEqual([]); expect(errors).toEqual([]);
});

test('returning guest keeps session and saved capture when origin fails and returns', async ({ page }) => {
  await page.goto(`/guest/join/${code}`); await page.locator('#join-name').fill('Returning guest');
  await page.getByRole('button', { name: 'Join & open camera' }).click();
  const shutter = page.getByRole('button', { name: 'Take photo', exact: true });
  await expect(shutter).toBeEnabled();
  await expect.poll(() => page.locator('.viewfinder video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  const token = await page.evaluate(code => localStorage.getItem(`session_${code}`), code);
  let uploadAttempts = 0;
  await page.route('**/api/**', route => {
    const upload = new URL(route.request().url()).pathname === '/api/photos';
    if (upload) uploadAttempts++;
    return route.fulfill({ status: upload ? 429 : 503, contentType: 'application/json', body: '{}' });
  });
  // A newly created event may not have reached the independent publisher yet.
  await page.route(`**/guest/events/${code}.json`, route => route.fulfill({ status: 404, body: 'Not published yet' }));
  await shutter.click(); await expect.poll(async () => (await queued(page)).length).toBe(1);
  await expect.poll(() => uploadAttempts).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('status').filter({ hasText: 'Photos are waiting in the queue' })).toHaveCount(1);
  await expect(page.getByText(/trying again in \d+s/)).toHaveCount(0);
  await page.getByRole('status').filter({ hasText: 'Photos are waiting in the queue' })
    .getByRole('button', { name: 'Dismiss notification' }).click();
  const attemptsAtDismissal = uploadAttempts;
  await expect.poll(() => uploadAttempts).toBeGreaterThan(attemptsAtDismissal);
  await expect(page.getByRole('status').filter({ hasText: 'Photos are waiting in the queue' })).toHaveCount(0);
  await page.reload(); await expect(shutter).toBeEnabled();
  await expect.poll(() => page.locator('.viewfinder video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  expect(await page.evaluate(code => localStorage.getItem(`session_${code}`), code)).toBe(token);
  await page.unroute('**/api/**'); await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await queued(page)).length, { timeout: 40_000 }).toBe(0);
  // Exercise a genuinely offline navigation: mocked API failures alone cannot
  // detect an installed worker that forgot to cache its HTML shell.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await page.context().setOffline(true);
  try {
    await page.reload();
    await expect(shutter).toBeEnabled();
    await expect.poll(() => page.locator('.viewfinder video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    await shutter.click();
    await expect.poll(async () => (await queued(page)).length).toBe(1);
  } finally { await page.context().setOffline(false); }
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await queued(page)).length, { timeout: 40_000 }).toBe(0);
});

test('saved captures remain exportable after authoritative event removal', async ({ page }) => {
  await page.goto(`/guest/join/${code}`); await page.locator('#join-name').fill('Saved guest');
  await page.getByRole('button', { name: 'Join & open camera' }).click();
  const shutter = page.getByRole('button', { name: 'Take photo', exact: true });
  await expect(shutter).toBeEnabled();
  await expect.poll(() => page.locator('.viewfinder video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await page.route('**/api/photos', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"This event is locked"}' }));
  await shutter.click(); await expect.poll(async () => (await queued(page)).length).toBe(1);
  await page.route(`**/api/events/${code}`, route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Event not found"}' }));
  await page.reload();
  await page.getByRole('link', { name: 'Saved captures on this device' }).click();
  await expect(page.getByRole('button', { name: /save a copy/i })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /save a copy/i }).click();
  expect((await download).suggestedFilename()).toMatch(/snapdini.*\.jpe?g$/);
  expect((await queued(page)).length).toBe(1); // Export never silently removes the durable original.
});

test('failed device storage is visible while the capture stays available in the open page', async ({ page }) => {
  await page.goto(`/guest/join/${code}`); await page.locator('#join-name').fill('Storage guest');
  await page.getByRole('button', { name: 'Join & open camera' }).click();
  const shutter = page.getByRole('button', { name: 'Take photo', exact: true });
  await expect(shutter).toBeEnabled();
  await expect.poll(() => page.locator('.viewfinder video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await page.route('**/api/photos', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'queue') throw new DOMException('Device storage full', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await shutter.click();
  await expect(page.getByRole('alert')).toContainText('could not save a capture');
  expect(await queued(page)).toEqual([]);
});

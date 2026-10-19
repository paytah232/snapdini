import { test, expect } from '@playwright/test';

const edge = process.env.E2E_GUEST_EDGE_URL;
test.skip(!edge, 'Opt-in independent edge acceptance requires E2E_GUEST_EDGE_URL.');
test.skip(({ browserName }) => browserName !== 'chromium', 'Fake camera fixture; physical mobile acceptance remains separate.');
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['camera', 'microphone'], serviceWorkers: 'allow' });
test.setTimeout(600_000);
let code = '', organizer = '';
test.beforeEach(async ({ request, baseURL }) => {
  if (!baseURL || !/^(localhost|127\.0\.0\.1)$/.test(new URL(baseURL).hostname))
    throw new Error('This destructive fixture requires the development origin');
  if (!edge || (!new URL(edge).hostname.startsWith('snapdini-guest-dev.') || !new URL(edge).hostname.endsWith('.workers.dev')))
    throw new Error('This fixture requires the isolated development Worker');
  const created = await request.post('/api/events/demo');
  expect(created.ok()).toBeTruthy();
  const event = await created.json(); code = event.joinCode; organizer = event.organizerCode;
  await expect.poll(async () => (await request.get(`${edge}/guest/events/${code}.json`)).status(),
    { timeout: 240_000, intervals: [2000, 5000] }).toBe(200);
});
test.afterEach(async ({ request }) => {
  if (code && organizer) {
    const response = await request.delete(`/api/events/${code}`, { headers: { 'x-organizer-code': organizer } });
    expect([200, 404]).toContain(response.status());
  }
});
async function queue(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('snapdini-captures', 2);
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const rows = await new Promise<any[]>((resolve, reject) => {
      const read = db.transaction('queue').objectStore('queue').getAll();
      read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
    }); db.close(); return rows.map(({ id, sessionToken, blob }) => ({ id, sessionToken, bytes: blob.size }));
  });
}

test('ordinary QR URL first opens during outage, preserves origin/queue on offline reload and reconciles once', async ({ page, context, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.goto(`${edge}/join/${code}`);
  expect(new URL(page.url()).pathname).toBe(`/join/${code}`);
  await page.locator('#join-name').fill('Normal edge outage guest');
  await page.getByRole('button', { name: 'Join & open camera' }).click();
  const shutter = page.getByRole('button', { name: 'Take photo', exact: true });
  await expect(shutter).toBeEnabled();
  await expect.poll(() => page.locator('.viewfinder video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await shutter.click();
  await expect.poll(async () => (await queue(page)).length).toBe(1);
  const original = (await queue(page))[0]; expect(original.bytes).toBeGreaterThan(0);
  expect(original.sessionToken).toMatch(/^offline_/);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); // Scope registration starts controlling the next navigation naturally.
  await expect(shutter).toBeEnabled();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain('/guest/sw.js');
  await context.setOffline(true);
  await page.reload();
  await expect(shutter).toBeEnabled();
  expect(await queue(page)).toEqual([original]);
  expect(new URL(page.url()).origin).toBe(edge);
  await context.setOffline(false); await page.unroute('**/api/**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await queue(page)).length, { timeout: 60_000 }).toBe(0);
  const final = await (await request.get(`/api/events/${code}`)).json();
  expect(final.photoCount).toBe(1);
  expect(errors).toEqual([]);
});

test('automatic publication carries settings edits and explicit withdrawal without camera redeployment', async ({ request }) => {
  const initial = await (await request.get(`${edge}/guest/release.json`)).json();
  const name = `Published update ${code}`;
  const changed = await request.put(`/api/events/${code}/settings`, { headers: { 'x-organizer-code': organizer }, data: { name } });
  expect(changed.ok()).toBeTruthy();
  await expect.poll(async () => {
    const response = await request.get(`${edge}/guest/events/${code}.json`);
    return response.ok() ? (await response.json()).event.name : null;
  }, { timeout: 240_000, intervals: [2000, 5000] }).toBe(name);
  expect(await (await request.get(`${edge}/guest/release.json`)).json()).toEqual(initial);
  expect((await request.delete(`/api/events/${code}`, { headers: { 'x-organizer-code': organizer } })).ok()).toBeTruthy();
  await expect.poll(async () => (await request.get(`${edge}/guest/events/${code}.json`)).status(),
    { timeout: 240_000, intervals: [2000, 5000] }).toBe(410);
  code = ''; organizer = '';
});

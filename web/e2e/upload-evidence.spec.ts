import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// This spec owns disposable dev fixtures and reads only the dev database.
test.skip(({ browserName }) => browserName !== 'chromium', 'Uses Chromium fake camera devices.');
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['camera', 'microphone'], serviceWorkers: 'allow' });
test.setTimeout(120_000);
let image: Buffer;
let code = '';
let organizer = '';

test.beforeAll(async () => {
  const require = createRequire(new URL('../../app/package.json', import.meta.url));
  const sharp = require('sharp');
  // Valid, deliberately incompressible JPEG above the 5 MiB chunk threshold.
  image = await sharp(randomBytes(2200 * 2200 * 3), { raw: { width: 2200, height: 2200, channels: 3 } })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  expect(image.length).toBeGreaterThan(5 * 1024 * 1024);
});
test.beforeEach(async ({ request, baseURL }) => {
  expect(new URL(baseURL!).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  const response = await request.post('/api/events/demo');
  expect(response.ok()).toBeTruthy();
  const event = await response.json(); code = event.joinCode; organizer = event.organizerCode;
});
test.afterEach(async ({ request }) => {
  if (code && organizer) expect((await request.delete(`/api/events/${code}`, {
    headers: { 'x-organizer-code': organizer },
  })).status()).toBe(200);
});
function evidence(captureId: string): { source: string; stage: string; reason: string | null; httpStatus: number | null }[] {
  expect(captureId).toMatch(/^[a-f0-9-]{36}$/);
  const query = `SELECT coalesce(json_agg(json_build_object('source',source,'stage',stage,'reason',reason,'httpStatus',http_status)),'[]'::json)
    FROM capture_evidence WHERE capture_id='${captureId}' AND event_id=(SELECT id FROM events WHERE join_code='${code}')`;
  return JSON.parse(execFileSync('docker', ['exec', 'snapdini-dev-db', 'psql', '-U', 'snapdini', '-d', 'snapdini', '-Atc', query], { encoding: 'utf8' }));
}
async function localCount(page: import('@playwright/test').Page, database: string, store: string) {
  return page.evaluate(async ({ database, store }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains(store)) { db.close(); return 0; }
    const count = await new Promise<number>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).count();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); db.close(); return count;
  }, { database, store });
}

test('rejected chunk, retry, stored photo and lost journal acknowledgement share one capture trail', async ({ page, request }) => {
  let captureId = '';
  let rejectedChunk = false;
  let lostJournalReply = false;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/evidence-fixture.jpg', route => route.fulfill({ contentType: 'image/jpeg', body: image }));
  await page.route('**/api/photos/chunk', async route => {
    const original = route.request().postDataBuffer();
    if (!rejectedChunk && route.request().headers()['x-upload-index'] === '0' && original) {
      captureId = route.request().headers()['x-capture-id'];
      const source = original.toString('latin1');
      const invalid = source.replace(/(name="index"\r\n\r\n)0(\r\n)/, '$1-1$2');
      expect(invalid).not.toBe(source);
      rejectedChunk = true;
      await route.continue({ postData: Buffer.from(invalid, 'latin1') });
    } else await route.continue();
  });
  await page.route('**/api/photos/evidence', async route => {
    const body = route.request().postDataJSON();
    const response = await route.fetch();
    if (!lostJournalReply && response.ok() && body.events.some((event: { stage: string }) => event.stage === 'server_acknowledged')) {
      lostJournalReply = true; // Server kept the evidence; the phone must retry the same event IDs.
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.goto(`/join/${code}`);
  await page.locator('#join-name').fill('Evidence browser guest');
  await page.getByRole('button', { name: 'Join & open camera' }).click();
  const shutter = page.getByRole('button', { name: 'Take photo', exact: true });
  await expect(shutter).toBeEnabled();
  await expect.poll(() => page.locator('.viewfinder video').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await page.evaluate(async () => {
    const fixture = await (await fetch('/evidence-fixture.jpg')).blob();
    const original = HTMLCanvasElement.prototype.toBlob;
    let replace = true;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (replace && type === 'image/jpeg' && this.width > 500) { replace = false; callback(fixture); }
      else original.call(this, callback, type, quality);
    };
  });
  await shutter.click();
  await expect.poll(async () => (await (await request.get(`/api/events/${code}`)).json()).photoCount,
    { timeout: 45_000 }).toBe(1);
  await expect.poll(() => localCount(page, 'snapdini-captures', 'queue')).toBe(0);
  expect(rejectedChunk).toBe(true);
  await expect.poll(() => lostJournalReply).toBe(true);
  await expect.poll(() => evidence(captureId).some(row => row.source === 'server' && row.stage === 'chunk_rejected'
    && row.reason === 'invalid_chunk_index' && row.httpStatus === 400)).toBe(true);
  await expect.poll(() => evidence(captureId).some(row => row.source === 'server' && row.stage === 'server_stored')).toBe(true);
  await expect.poll(() => evidence(captureId).some(row => row.source === 'client' && row.stage === 'server_acknowledged')).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => localCount(page, 'snapdini-capture-evidence', 'events'), { timeout: 20_000 }).toBe(0);
  const trail = evidence(captureId);
  expect(trail.some(row => row.source === 'client' && row.stage === 'local_saved')).toBe(true);
  expect(trail.some(row => row.source === 'client' && row.stage === 'upload_failed' && row.httpStatus === 400)).toBe(true);
  expect(trail.filter(row => row.source === 'client' && row.stage === 'server_acknowledged')).toHaveLength(1);
  expect((await (await request.get(`/api/events/${code}`)).json()).photoCount).toBe(1);
  expect(errors).toEqual([]);
});

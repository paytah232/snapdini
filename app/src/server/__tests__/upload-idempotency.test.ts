// Drive the actual upload handlers with real sharp/filesystem work. The database stand-in
// models a participant row lock so concurrent retries must recheck their receipt under it.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdini-idempotency-'));
process.env.UPLOADS_DIR = tmp;
process.env.MEDIA_DRIVER = 'local';
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const nameOf = (t: any) => t[Symbol.for('drizzle:Name')];
function valuesOf(n: any): unknown[] {
  if (!n || typeof n !== 'object') return [];
  if (Array.isArray(n)) return n.flatMap(valuesOf);
  if ('value' in n) return [n.value];
  return Array.isArray(n.queryChunks) ? n.queryChunks.flatMap(valuesOf) : [];
}
let shots = 0;
let afterParticipantRead: (() => void) | undefined;
let locked = false;
let ended = false;
let rows: any[] = [];
let tombstones: any[] = [];
let beforeAcquire: (() => void) | undefined;
let lockTail: Promise<void> = Promise.resolve();
const roll = (id = 'guest-a') => ({
  id, eventId: 'event-a', photosTaken: shots, maxPhotos: 1, extraPhotos: 0,
  isLocked: locked, startsAt: Date.now() - 2 * 86400_000,
  expiresAt: ended ? Date.now() - 86400_000 : Date.now() + 3600_000,
  moderationEnabled: false, videoSeconds: 0, challengeSet: null,
  eventChallenges: null, aspectRatios: '["1:1"]', purgeAt: null, purgedAt: null,
});
function chain(produce: (o: any) => any) {
  const o: any = {
    where(condition: any) { o.args = valuesOf(condition); return o; },
    set(value: any) { o.value = value; return o; },
    values(value: any) { o.value = value; return o; },
    returning() { return o; },
    innerJoin() { return o; },
    for() { o.lock = true; return o; },
    then(resolve: any, reject: any) { return Promise.resolve().then(() => produce(o)).then(resolve, reject); },
  };
  return o;
}
function connection(acquire?: () => Promise<void>): any {
  return {
    select() { return { from(table: any) { return chain(async (o) => {
      if (o.lock) { assert.ok(acquire, 'row lock outside transaction'); beforeAcquire?.(); beforeAcquire = undefined; await acquire!(); }
      if (nameOf(table) === 'participants') {
        const args = o.args ?? [];
        if (args.includes('invalid-session')) return [];
        const snapshot = roll(args.includes('other-session') ? 'guest-b' : 'guest-a');
        const hook = afterParticipantRead; afterParticipantRead = undefined;
        hook?.();
        return [snapshot];
      }
      if (nameOf(table) === 'capture_upload_tombstones') return tombstones.filter((r) =>
        [r.id, r.participantId, r.eventId].every((v) => o.args.includes(v)))
        .map((r) => ({ ...r, photosTaken: shots, maxPhotos: 1, extraPhotos: 0, moderationEnabled: false }));
      if (nameOf(table) === 'photos') return rows.filter((r) =>
        [r.id, r.participantId, r.eventId].every((v) => o.args.includes(v)))
        .map((r) => ({ ...r, photosTaken: shots, maxPhotos: 1, extraPhotos: 0, moderationEnabled: false }));
      return [];
    }); } }; },
    update() { return chain(() => {
      if (shots >= 1) return [];
      shots++;
      return [{ photosTaken: shots, maxPhotos: 1, extraPhotos: 0 }];
    }); },
    insert() { return chain((o) => {
      assert.ok(!rows.some((r) => r.id === o.value.id), 'duplicate primary key');
      rows.push(o.value); return [];
    }); },
  };
}
const fakeDb = {
  ...connection(),
  async transaction(callback: (tx: any) => Promise<any>) {
    let release: (() => void) | undefined;
    const tx = connection(async () => {
      const previous = lockTail;
      lockTail = new Promise<void>((done) => { release = done; });
      await previous;
    });
    try { return await callback(tx); } finally { release?.(); }
  },
};
const dbPath = require.resolve('../db');
require(dbPath);
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {} };
const routes = require('../routes/photos') as typeof import('../routes/photos');
const { INCOMING_DIR } = require('../paths') as typeof import('../paths');

async function call(route: string, body: any, file?: any) {
  const layer = (routes.default as any).stack.find((l: any) => l.route?.path === route && l.route.methods.post);
  const result = { code: 200, body: undefined as any };
  const res: any = {
    status(code: number) { result.code = code; return res; },
    json(value: any) { result.body = value; return res; },
  };
  await layer.route.stack.at(-1).handle({ body, file, query: {}, params: {}, get: () => undefined }, res);
  return result;
}
let sequence = 0;
async function single(captureId?: unknown, sessionToken = 'session-a') {
  fs.mkdirSync(INCOMING_DIR, { recursive: true });
  const file = path.join(INCOMING_DIR, `still-${sequence++}.jpg`);
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } }).jpeg().toFile(file);
  const result = await call('/', { sessionToken, captureId },
    { path: file, size: fs.statSync(file).size, originalname: 'photo.jpg', mimetype: 'image/jpeg' });
  assert.equal(fs.existsSync(file), false, 'staged replay/refusal file was not reclaimed');
  return result;
}
beforeEach(() => {
  shots = 0; locked = false; ended = false; rows = []; tombstones = []; beforeAcquire = undefined; lockTail = Promise.resolve(); afterParticipantRead = undefined;
  fs.rmSync(path.join(tmp, 'event-a'), { force: true, recursive: true });
  routes.__resetListingCache();
});

const capture = 'capture-guest-a-123';
test('lost success response: replay acknowledges existing photo even after roll fills and event locks/ends', async () => {
  const first = await single(capture);
  assert.equal(first.code, 200);
  locked = true; ended = true;
  const replay = await single(capture);
  assert.equal(replay.code, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.photoId, first.body.photoId);
  assert.equal(replay.body.photosRemaining, 0);
  assert.equal(rows.length, 1);
  assert.equal(shots, 1);
});

test('concurrent retries both succeed, charge one shot and remove the losing media', async () => {
  const [first, second] = await Promise.all([single(capture), single(capture)]);
  assert.equal(first.code, 200, JSON.stringify(first.body));
  assert.equal(second.code, 200, JSON.stringify(second.body));
  assert.equal(first.body.photoId, second.body.photoId);
  assert.equal(rows.length, 1);
  assert.equal(shots, 1);
  const stored = path.join(tmp, rows[0].filename);
  assert.ok(fs.existsSync(stored));
  assert.equal(fs.readdirSync(path.dirname(stored)).length, 2, 'losing original/thumbnail leaked');
});

test('chunk completion replays an existing capture without its already-removed parts', async () => {
  const first = await single(capture);
  const replay = await call('/complete', {
    sessionToken: 'session-a', captureId: capture,
    uploadId: 'missing-parts-123', total: 1, ext: 'jpg', mediaType: 'photo',
  });
  assert.equal(replay.code, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.photoId, first.body.photoId);
  assert.equal(rows.length, 1);
  assert.equal(shots, 1);
});

test('a first chunked upload is committed once and repeated completion succeeds after parts disappear', async () => {
  fs.mkdirSync(INCOMING_DIR, { recursive: true });
  const uploadId = 'chunk-first-123';
  const dir = path.join(INCOMING_DIR, `chunks-${uploadId}`);
  fs.mkdirSync(dir, { recursive: true });
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } })
    .jpeg().toFile(path.join(dir, '0'));
  const body = { sessionToken: 'session-a', captureId: capture, uploadId, total: 1,
    ext: 'jpg', mediaType: 'photo' };
  const first = await call('/complete', body);
  assert.equal(first.code, 200, JSON.stringify(first.body));
  assert.equal(fs.existsSync(dir), false);
  const second = await call('/complete', body);
  assert.equal(second.code, 200, JSON.stringify(second.body));
  assert.equal(second.body.photoId, first.body.photoId);
  assert.equal(shots, 1);
  assert.equal(rows.length, 1);
});

test('capture ids cannot acknowledge another participant, and invalid sessions still fail', async () => {
  await single(capture);
  const other = await single(capture, 'other-session');
  assert.equal(other.code, 403);
  const invalid = await single(capture, 'invalid-session');
  assert.equal(invalid.code, 403);
  assert.equal(rows.length, 1);
});

test('malformed capture ids are rejected and legacy uploads remain supported', async () => {
  assert.equal((await single({ bad: true })).code, 400);
  assert.equal((await single('x')).code, 400);
  assert.equal((await single()).code, 200);
  assert.equal(rows.length, 1);
});

test('stable capture ids are separated by event and participant', () => {
  const a = routes.capturePhotoId(capture, { eventId: 'a', id: 'guest' });
  assert.equal(a, routes.capturePhotoId(capture, { eventId: 'a', id: 'guest' }));
  assert.notEqual(a, routes.capturePhotoId(capture, { eventId: 'a', id: 'other' }));
  assert.notEqual(a, routes.capturePhotoId(capture, { eventId: 'b', id: 'guest' }));
});

for (const route of ['single', 'complete']) {
  test(`${route} replay reads the winning counter when the authentication snapshot predates its commit`, async () => {
    await single(capture);
    shots = 0; // the authentication SELECT starts just before the winner commits
    afterParticipantRead = () => { shots = 1; };
    const reply = route === 'single' ? await single(capture) : await call('/complete', {
      sessionToken: 'session-a', captureId: capture, uploadId: 'already-gone-123', total: 1,
      ext: 'jpg', mediaType: 'photo',
    });
    assert.equal(reply.code, 200);
    assert.equal(reply.body.photosRemaining, 0, 'the receipt reused the stale authentication count');
    assert.equal(shots, 1);
    assert.equal(rows.length, 1);
  });
}

function deleteStoredCapture() {
  assert.equal(rows.length, 1);
  const photo = rows.pop();
  tombstones.push({ id: photo.id, participantId: photo.participantId, eventId: photo.eventId });
  shots--;
}
for (const route of ['single', 'complete']) {
  test(`${route} retries acknowledge deliberately deleted captures without recreating or recharging`, async () => {
    const first = await single(capture);
    deleteStoredCapture();
    locked = true; ended = true;
    const reply = route === 'single' ? await single(capture) : await call('/complete', {
      sessionToken: 'session-a', captureId: capture, uploadId: 'deleted-parts-123', total: 1,
      ext: 'jpg', mediaType: 'photo',
    });
    assert.equal(reply.code, 200);
    assert.equal(reply.body.photoId, first.body.photoId);
    assert.equal(reply.body.deleted, true);
    assert.equal(reply.body.status, 'deleted');
    assert.equal(reply.body.pendingModeration, false);
    assert.equal(reply.body.photosRemaining, 1);
    assert.equal(rows.length, 0);
    assert.equal(shots, 0);
  });
}
test('a tombstone committed after early lookup is rechecked under the allowance lock', async () => {
  const id = routes.capturePhotoId(capture, { eventId: 'event-a', id: 'guest-a' });
  beforeAcquire = () => { tombstones.push({ id, participantId: 'guest-a', eventId: 'event-a' }); };
  const result = await single(capture);
  assert.equal(result.code, 200);
  assert.equal(result.body.deleted, true);
  assert.equal(rows.length, 0);
  assert.equal(shots, 0);
  const files = fs.readdirSync(path.join(tmp, 'event-a'));
  assert.equal(files.length, 0, 'late upload published media after deletion tombstone');
});
test('deletion tombstones cannot acknowledge another authenticated participant', async () => {
  const first = await single(capture);
  deleteStoredCapture();
  const second = await single(capture, 'other-session');
  assert.equal(second.code, 200);
  assert.notEqual(second.body.photoId, first.body.photoId);
  assert.equal(second.body.deleted, undefined);
  assert.equal(rows.length, 1);
  assert.equal(shots, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { identifier, publicCameraEvent, publishOnce, main, sourceConfiguration, SOURCE_RECEIPT } from './publish.mjs';

const fixture = () => ({ id: 'event-public-id', name: 'Test event', joinCode: 'ABCD1234', slug: 'test-event',
  maxPhotos: 12, revealMode: 'instant', revealDelayHours: 0, videoSeconds: 0,
  startsAt: 1000, expiresAt: 100000, aspectRatios: ['1:1'], isLocked: false,
  theme: { accent: '#ffffff', organizerCode: 'hidden-nested' },
  organizerCode: 'secret', youManage: true, ownerUserId: 'private-user', email: 'private@example.test',
  participantCount: 1, photoCount: 3,
});
const response = event => ({ ok: true, status: 200, json: async () => event });
async function sandbox(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'guest-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('allowlist excludes authority, personal data and counts, including nested theme additions', () => {
  const clean = publicCameraEvent(fixture());
  for (const key of ['organizerCode', 'youManage', 'ownerUserId', 'email', 'participantCount', 'photoCount'])
    assert.equal(Object.hasOwn(clean, key), false);
  assert.deepEqual(clean.theme, { accent: '#ffffff' });
  assert.equal(clean.maxPhotos, 12);
  assert.equal(clean.expiresAt, 100000);
  assert.equal(clean.isLocked, false);
});

test('normalization refuses traversal, encoded paths, separators and empty identifiers', () => {
  assert.equal(identifier('abcd1234'), 'ABCD1234');
  assert.equal(identifier('Test-Event', 'slug'), 'test-event');
  for (const raw of ['', '../secret', 'foo/bar', '%2e%2e', 'a\\b', '.', '-a', 'a-', 'a--b']) {
    assert.throws(() => identifier(raw, 'slug'));
  }
});

test('count changes do not republish; settings and locks do, atomically for both aliases', async t => {
  const outputDir = await sandbox(t);
  let event = fixture();
  let time = 1;
  const opts = { source: async () => [event], fetchEvent: async () => response(event), outputDir, now: () => time };
  assert.deepEqual(await publishOnce(opts), { changed: 2, unchanged: 0, removed: 0, failed: 0 });
  const first = await readFile(path.join(outputDir, 'ABCD1234.json'), 'utf8');
  event = { ...event, participantCount: 99, photoCount: 999, isUpcoming: false, isExpired: true };
  time = 2;
  assert.equal((await publishOnce(opts)).unchanged, 2);
  assert.equal(await readFile(path.join(outputDir, 'ABCD1234.json'), 'utf8'), first);
  event = { ...event, maxPhotos: 24, isLocked: true };
  assert.equal((await publishOnce(opts)).changed, 2);
  const updated = JSON.parse(await readFile(path.join(outputDir, 'test-event.json'), 'utf8'));
  assert.equal(updated.event.maxPhotos, 24);
  assert.equal(updated.event.isLocked, true);
  assert.equal(updated.publishedAt, 2);
  assert.equal(updated.schema, 1);
  assert.deepEqual((await readdir(outputDir)).filter(name => !name.startsWith('.')), ['ABCD1234.json', 'test-event.json']);
});

test('renamed slug and removed/purged events remove obsolete files', async t => {
  const outputDir = await sandbox(t);
  let event = fixture();
  const opts = { source: async () => [event], fetchEvent: async () => response(event), outputDir };
  await publishOnce(opts);
  event = { ...event, slug: 'new-slug' };
  assert.equal((await publishOnce(opts)).removed, 1);
  assert.deepEqual((await readdir(outputDir)).filter(name => !name.startsWith('.')), ['ABCD1234.json', 'new-slug.json']);
  assert.equal((await publishOnce({ ...opts, source: async () => [] })).removed, 2);
  assert.deepEqual((await readdir(outputDir)).filter(name => !name.startsWith('.')), []);
});

test('database failure and temporary API failure preserve previously published settings', async t => {
  const outputDir = await sandbox(t);
  const event = fixture();
  const opts = { source: async () => [event], fetchEvent: async () => response(event), outputDir };
  await publishOnce(opts);
  await assert.rejects(publishOnce({ ...opts, source: async () => { throw new Error('db down'); } }));
  assert.equal((await publishOnce({ ...opts, fetchEvent: async () => { throw new Error('timeout'); } })).failed, 1);
  assert.equal(((await readdir(outputDir)).filter(name => !name.startsWith('.'))).length, 2);
  assert.equal((await publishOnce({ ...opts, fetchEvent: async () => ({ ok: false, status: 404 }) })).removed, 2);
});

test('invalid database identifiers cannot address files outside the output directory', async t => {
  const outputDir = await sandbox(t);
  await assert.rejects(publishOnce({ outputDir, source: async () => [{ joinCode: '../secret' }],
    fetchEvent: async () => assert.fail('must not request invalid identifiers') }), /Invalid recovery identifier/);
  assert.deepEqual((await readdir(outputDir)).filter(name => !name.startsWith('.')), []);
});

test('dev publisher requires explicit environment and refuses known production API before connecting', async () => {
  await assert.rejects(main({}), /must be dev/);
  await assert.rejects(main({ GUEST_RECOVERY_ENV: 'dev' }), /DATABASE_URL is required/);
  await assert.rejects(main({ GUEST_RECOVERY_ENV: 'dev', DATABASE_URL: 'not-used', OUTPUT_DIR: '/not-used',
    INTERNAL_API_BASE: 'https://snapdini.com' }), /Production API is forbidden/);
});

test('production source mode must be explicit, while dev still refuses production hosts', () => {
  const env = { GUEST_RECOVERY_ENV: 'production', DATABASE_URL: 'not-used', OUTPUT_DIR: '/not-used', INTERNAL_API_BASE: 'https://snapdini.com' };
  assert.equal(sourceConfiguration(env).origin, 'https://snapdini.com');
  assert.throws(() => sourceConfiguration({ ...env, GUEST_RECOVERY_ENV: 'dev' }), /Production API/);
  assert.throws(() => sourceConfiguration({ ...env, GUEST_RECOVERY_ENV: undefined }), /explicitly/);
});

test('source receipt is invalidated before database reads and completed only after all fetches succeed', async t => {
  const outputDir = await sandbox(t);
  const event = fixture();
  const opts = { outputDir, source: async () => [event], fetchEvent: async () => response(event) };
  await publishOnce(opts);
  assert.equal(JSON.parse(await readFile(path.join(outputDir, SOURCE_RECEIPT))).complete, true);
  await assert.rejects(publishOnce({ ...opts, source: async () => {
    assert.equal(JSON.parse(await readFile(path.join(outputDir, SOURCE_RECEIPT))).complete, false);
    throw Error('database unavailable');
  } }));
  assert.equal(JSON.parse(await readFile(path.join(outputDir, SOURCE_RECEIPT))).complete, false);
  await publishOnce({ ...opts, fetchEvent: async () => ({ ok: false, status: 503 }) });
  assert.equal(JSON.parse(await readFile(path.join(outputDir, SOURCE_RECEIPT))).complete, false);
  await publishOnce(opts);
  assert.equal(JSON.parse(await readFile(path.join(outputDir, SOURCE_RECEIPT))).complete, true);
});

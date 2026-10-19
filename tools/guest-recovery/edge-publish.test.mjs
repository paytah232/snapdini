import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration, collectSnapshots, planPublication, publishEdgeOnce, deployArtifact, WRANGLER_VERSION } from './edge-publish.mjs';
import { recordSourceReceipt, SOURCE_RECEIPT } from './publish.mjs';
import { handle } from './events-worker.mjs';
const fixture = () => ({ schema: 1, publishedAt: 1000, event: {
  id: 'public-id', name: 'Public event', joinCode: 'TEST1234', slug: null,
  maxPhotos: 12, revealMode: 'instant', revealDelayHours: 0, videoSeconds: 0,
  startsAt: 100, expiresAt: 200000, aspectRatios: ['1:1'],
  organizerCode: 'never-publish-secret', participantCount: 99, email: 'private@example.invalid',
  theme: { accent: '#fff', hidden: 'nested-secret' },
} });
async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guest-edge-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshotDir = path.join(root, 'snapshots');
  await mkdir(snapshotDir);
  const env = { GUEST_RECOVERY_ENV: 'dev', GUEST_EDGE_WORKER_NAME: 'snapdini-guest-events-dev',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), OUTPUT_DIR: snapshotDir,
    GUEST_EDGE_STATE_DIR: path.join(root, 'private'), GUEST_EDGE_TOKEN_FILE: path.join(root, 'token'),
    GUEST_EDGE_WRANGLER_PACKAGE: path.join(root, 'wrangler') };
  await writeFile(path.join(snapshotDir, 'TEST1234.json'), JSON.stringify(fixture()));
  await recordSourceReceipt(snapshotDir, true);
  return { root, env, config: configuration(env), snapshotDir };
}
test('configuration requires explicit account/lane/target/private paths and refuses witness', async t => {
  const { env } = await sandbox(t);
  assert.throws(() => configuration({}), /lane/);
  assert.throws(() => configuration({ ...env, GUEST_EDGE_WORKER_NAME: 'snapdini-witness' }), /event-only/);
  assert.throws(() => configuration({ ...env, GUEST_EDGE_WORKER_NAME: 'snapdini-guest-events-prod' }), /event-only/);
  assert.throws(() => configuration({ ...env, GUEST_RECOVERY_ENV: 'production' }), /event-only/);
  assert.equal(configuration({ ...env, GUEST_RECOVERY_ENV: 'production', GUEST_EDGE_WORKER_NAME: 'snapdini-guest-events' }).workerName, 'snapdini-guest-events');
  assert.throws(() => configuration({ ...env, GUEST_EDGE_STATE_DIR: env.OUTPUT_DIR }), /outside/);
  assert.throws(() => configuration({ ...env, GUEST_EDGE_MAX_DAILY_ATTEMPTS: 1000000 }), /budget/);
});
test('deployment boundary re-applies allowlist and refuses symlinks/extra files/oversized JSON', async t => {
  const { config, snapshotDir } = await sandbox(t);
  const files = await collectSnapshots(snapshotDir);
  const text = JSON.stringify(files);
  for (const forbidden of ['organizerCode', 'never-publish-secret', 'participantCount', 'private@example', 'nested-secret']) assert.equal(text.includes(forbidden), false);
  await symlink(path.join(snapshotDir, 'TEST1234.json'), path.join(snapshotDir, 'ALIAS123.json'));
  await assert.rejects(collectSnapshots(snapshotDir), /Unexpected/);
  await rm(path.join(snapshotDir, 'ALIAS123.json'));
  await writeFile(path.join(snapshotDir, 'TEST1234.json'), 'x'.repeat(65537));
  await assert.rejects(collectSnapshots(config.snapshotDir), /size limit/);
});
test('publication is automatic only for changed allowlisted content, atomic and independent of app code', async t => {
  const { config, snapshotDir } = await sandbox(t);
  let calls = 0;
  let time = 100000;
  const deploy = async (cfg, artifact) => {
    calls++;
    const metadata = JSON.parse(await readFile(path.join(artifact, 'wrangler.json')));
    assert.equal(metadata.name, 'snapdini-guest-events-dev');
    assert.deepEqual(metadata.routes, []);
    assert.equal(metadata.workers_dev, false);
    assert.equal(metadata.kv_namespaces, undefined);
    assert.equal(metadata.r2_buckets, undefined);
    assert.deepEqual((await readdir(artifact)).sort(), ['events-worker.mjs', 'public', 'wrangler.json']);
    const text = await readFile(path.join(artifact, 'public/guest/events/TEST1234.json'), 'utf8');
    assert.equal(text.includes('organizerCode'), false);
    const manifest = JSON.parse(await readFile(path.join(artifact, 'public/guest/publication.json')));
    assert.match(manifest.revision, /^[a-f0-9]{64}$/);
    assert.equal(manifest.events, undefined);
  };
  assert.equal((await publishEdgeOnce(config, { now: () => time, deploy })).status, 'published');
  assert.equal((await publishEdgeOnce(config, { now: () => time + 60000, deploy })).status, 'unchanged');
  const source = fixture(); source.event.participantCount = 999;
  await writeFile(path.join(snapshotDir, 'TEST1234.json'), JSON.stringify(source));
  await recordSourceReceipt(snapshotDir, true);
  assert.equal((await publishEdgeOnce(config, { now: () => time + 60000, deploy })).status, 'unchanged');
  source.event.maxPhotos = 24; source.publishedAt++;
  await writeFile(path.join(snapshotDir, 'TEST1234.json'), JSON.stringify(source));
  await recordSourceReceipt(snapshotDir, true);
  assert.equal((await publishEdgeOnce(config, { now: () => time + 1000, deploy })).status, 'coalesced');
  assert.equal((await publishEdgeOnce(config, { now: () => time + 60000, deploy })).status, 'published');
  assert.equal(calls, 2);
});
test('deletion and renamed slugs publish persistent 410 tombstones; recreated aliases replace them', async t => {
  const { config, snapshotDir } = await sandbox(t);
  const deploy = async () => {};
  await publishEdgeOnce(config, { now: () => 100000, deploy });
  await rm(path.join(snapshotDir, 'TEST1234.json'));
  await recordSourceReceipt(snapshotDir, true);
  assert.equal((await publishEdgeOnce(config, { now: () => 160000, deploy })).status, 'published');
  const tombstone = JSON.parse(await readFile(path.join(config.stateDir, 'artifact/public/guest/events/TEST1234.json')));
  assert.equal(tombstone.withdrawn, true);
  assert.equal(tombstone.event, undefined);
  assert.equal((await publishEdgeOnce(config, { now: () => 220000, deploy })).status, 'unchanged');
  await writeFile(path.join(snapshotDir, 'TEST1234.json'), JSON.stringify(fixture()));
  await recordSourceReceipt(snapshotDir, true);
  assert.equal((await publishEdgeOnce(config, { now: () => 280000, deploy })).status, 'published');
  const active = JSON.parse(await readFile(path.join(config.stateDir, 'artifact/public/guest/events/TEST1234.json')));
  assert.equal(active.withdrawn, undefined);
  assert.equal(active.event.joinCode, 'TEST1234');
});
test('failed deployment preserves last confirmed revision and withdrawal bookkeeping, with bounded retry budget', async t => {
  const { config, snapshotDir } = await sandbox(t);
  config.maxDailyAttempts = 2;
  await publishEdgeOnce(config, { now: () => 100000, deploy: async () => {} });
  const previous = JSON.parse(await readFile(path.join(config.stateDir, 'state.json')));
  await rm(path.join(snapshotDir, 'TEST1234.json'));
  await recordSourceReceipt(snapshotDir, true);
  await assert.rejects(publishEdgeOnce(config, { now: () => 160000, deploy: async () => { throw Error('failed'); } }));
  const failed = JSON.parse(await readFile(path.join(config.stateDir, 'state.json')));
  assert.equal(failed.revision, previous.revision);
  assert.deepEqual(failed.records, previous.records);
  assert.equal(failed.attempts, 2);
  assert.equal((await publishEdgeOnce(config, { now: () => 161000, deploy: async () => assert.fail() })).status, 'coalesced');
  assert.equal((await publishEdgeOnce(config, { now: () => 360000, deploy: async () => assert.fail() })).status, 'daily-budget');
  assert.equal((await publishEdgeOnce(config, { now: () => 86400000 + 360000, deploy: async () => {} })).status, 'published');
});
test('source read failure never becomes deletion and concurrent publishers cannot deploy', async t => {
  const { config, snapshotDir } = await sandbox(t);
  await publishEdgeOnce(config, { now: () => 100000, deploy: async () => {} });
  await mkdir(path.join(config.stateDir, 'publication.lock'));
  assert.equal((await publishEdgeOnce(config, { deploy: async () => assert.fail() })).status, 'locked');
  await rm(path.join(config.stateDir, 'publication.lock'), { recursive: true });
  await rm(snapshotDir, { recursive: true });
  await assert.rejects(publishEdgeOnce(config, { now: () => 160000, deploy: async () => assert.fail() }));
  const state = JSON.parse(await readFile(path.join(config.stateDir, 'state.json')));
  assert.ok(state.records['TEST1234.json']);
  assert.equal(state.attempts, 1);
});
test('invalid artifact identity never reaches deployment and cross-target state is rejected', async t => {
  const { config, snapshotDir } = await sandbox(t);
  await publishEdgeOnce(config, { now: () => 100000, deploy: async () => {} });
  await assert.rejects(publishEdgeOnce({ ...config, workerName: 'another-events-dev' }, { deploy: async () => assert.fail() }), /another publication target/);
  const source = fixture(); source.event.joinCode = 'DIFFERENT1';
  await writeFile(path.join(snapshotDir, 'TEST1234.json'), JSON.stringify(source));
  await recordSourceReceipt(snapshotDir, true);
  await assert.rejects(publishEdgeOnce(config, { deploy: async () => assert.fail() }), /identity/);
});
test('authenticated deployment refuses public or symlinked token files and unpinned Wrangler', async t => {
  const { config, root } = await sandbox(t);
  await writeFile(config.tokenFile, 'x'.repeat(40), { mode: 0o644 });
  await assert.rejects(deployArtifact(config, root), /private regular file/);
  await chmod(config.tokenFile, 0o600);
  await mkdir(config.wranglerPackage);
  await writeFile(path.join(config.wranglerPackage, 'package.json'), JSON.stringify({ name: 'wrangler', version: WRANGLER_VERSION + '-changed' }));
  await assert.rejects(deployArtifact(config, root), /required/);
});
test('event Worker serves allowlisted metadata, refuses writes and emits authoritative 410 for withdrawn identifiers', async () => {
  const asset = body => ({ ASSETS: { fetch: async () => Response.json(body) } });
  const active = await handle(new Request('https://guest.test/guest/events/TEST1234.json'), asset(fixture()));
  assert.equal(active.status, 200); assert.equal(active.headers.get('cache-control'), 'no-store');
  const tombstone = { schema: 1, withdrawn: true, identifier: 'TEST1234', publishedAt: 123 };
  for (const method of ['GET', 'HEAD']) assert.equal((await handle(new Request('https://guest.test/guest/events/TEST1234.json', { method }), asset(tombstone))).status, 410);
  assert.equal((await handle(new Request('https://guest.test/guest/events/TEST1234.json', { method: 'POST' }), asset(fixture()))).status, 405);
  assert.equal((await handle(new Request('https://guest.test/guest/private.json'), asset(fixture()))).status, 404);
  assert.equal((await handle(new Request('https://guest.test/guest/events/MISSING.json'), { ASSETS: { fetch: async () => new Response(null, { status: 404 }) } })).status, 404);
});
test('tombstones expire after both the privacy retention and original event schedule', () => {
  const now = 100000;
  const plan = planPublication({}, { records: { 'TEST1234.json': { expiresAt: now + 60 * 86400000 } } }, now);
  assert.ok(plan.records['TEST1234.json'].retainUntil > now + 60 * 86400000);
  const expired = planPublication({}, { records: plan.records }, now + 62 * 86400000);
  assert.deepEqual(expired.content, {});
});

test('a dead publisher process lock is recovered without consuming a second attempt budget', async t => {
  const { config } = await sandbox(t);
  await mkdir(path.join(config.stateDir, 'publication.lock'), { recursive: true });
  await writeFile(path.join(config.stateDir, 'publication.lock/owner.json'), JSON.stringify({ pid: 2147483647, startedAt: 1 }));
  const published = await publishEdgeOnce(config, { now: () => 100000, deploy: async () => {} });
  assert.equal(published.status, 'published');
  const state = JSON.parse(await readFile(path.join(config.stateDir, 'state.json')));
  assert.equal(state.attempts, 1);
});

test('HEAD asset follow-up failure returns safe unavailable response', async () => {
  let calls = 0;
  const env = { ASSETS: { fetch: async () => { calls++; if (calls > 1) throw Error('transient'); return new Response(null, { status: 200 }); } } };
  const response = await handle(new Request('https://guest.test/guest/events/TEST1234.json', { method: 'HEAD' }), env);
  assert.equal(response.status, 503);
});

test('lost local volume plus unsuccessful source pass never withdraws a known edge event', async t => {
  const { config, snapshotDir } = await sandbox(t);
  await publishEdgeOnce(config, { now: () => 100000, deploy: async () => {} });
  await rm(path.join(snapshotDir, 'TEST1234.json'));
  await recordSourceReceipt(snapshotDir, false);
  await assert.rejects(publishEdgeOnce(config, { now: () => 160000, deploy: async () => assert.fail('must preserve edge') }), /incomplete/);
  const state = JSON.parse(await readFile(path.join(config.stateDir, 'state.json')));
  assert.ok(state.records['TEST1234.json']);
  assert.equal(state.attempts, 1);
  await rm(path.join(snapshotDir, SOURCE_RECEIPT));
  await assert.rejects(publishEdgeOnce(config, { now: () => 160000, deploy: async () => assert.fail() }), /incomplete/);
});

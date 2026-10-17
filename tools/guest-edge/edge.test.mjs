import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appOrigin, handle } from './worker.mjs';
import { prepare } from './prepare.mjs';

const env = { APP_ORIGIN: 'https://development.example.test', DEPLOYMENT_LANE: 'dev' };
const accountId = 'a'.repeat(32);

test('development origin validation rejects production and ambiguous origins', () => {
  assert.equal(appOrigin(env.APP_ORIGIN, 'dev'), env.APP_ORIGIN);
  assert.throws(() => appOrigin(env.APP_ORIGIN, 'production'));
  for (const origin of ['https://snapdini.com', 'https://www.snapdini.com', 'http://dev.example.test',
    'https://dev.example.test/path', 'https://dev.example.test?secret=x',
    'https://user:secret@dev.example.test', 'https://dev.example.test#fragment'])
    assert.throws(() => appOrigin(origin, 'dev'));
});

test('guest API bodies and guest identity survive, account/organizer credentials do not', async () => {
  const request = new Request('https://edge.example.test/api/participants/join?x=1', {
    method: 'POST', body: '{"name":"Guest"}', headers: {
      'Content-Type': 'application/json', 'X-Session-Token': 'guest-token',
      'X-Visitor-Token': 'visitor-token', 'X-Capture-Id': 'capture-test', 'X-Upload-Id': 'upload-test',
      'X-Upload-Index': '0', 'X-Upload-Total': '2', Cookie: 'account=secret', Authorization: 'Bearer account',
      'X-Organizer-Code': 'secret-key', 'X-Admin-Key': 'private', 'X-Forwarded-For': 'forged',
    },
  });
  let upstream;
  const response = await handle(request, env, async forwarded => {
    upstream = forwarded;
    assert.equal(await forwarded.text(), '{"name":"Guest"}');
    return new Response('{"ok":true}', { headers: { 'Set-Cookie': 'account=secret', ETag: 'test-etag' } });
  });
  assert.equal(upstream.url, `${env.APP_ORIGIN}/api/participants/join?x=1`);
  assert.equal(upstream.redirect, 'manual');
  assert.equal(upstream.headers.get('x-session-token'), 'guest-token');
  assert.equal(upstream.headers.get('x-visitor-token'), 'visitor-token');
  for (const [name, value] of [['x-capture-id', 'capture-test'], ['x-upload-id', 'upload-test'], ['x-upload-index', '0'], ['x-upload-total', '2']])
    assert.equal(upstream.headers.get(name), value);
  for (const name of ['cookie', 'authorization', 'x-organizer-code', 'x-admin-key', 'x-forwarded-for'])
    assert.equal(upstream.headers.has(name), false);
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(response.headers.get('etag'), 'test-etag');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('media ranges and conditional requests retain streaming response metadata', async () => {
  const request = new Request('https://edge.example.test/uploads/event/photo.jpg', {
    headers: { Range: 'bytes=2-4', 'If-Range': 'known-etag' },
  });
  const response = await handle(request, env, async forwarded => {
    assert.equal(forwarded.headers.get('range'), 'bytes=2-4');
    assert.equal(forwarded.headers.get('if-range'), 'known-etag');
    return new Response('abc', { status: 206, headers: { 'Content-Range': 'bytes 2-4/8' } });
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-4/8');
  assert.equal(await response.text(), 'abc');
});

test('unknown paths are not proxied; origin failure returns an uncached recoverable status', async () => {
  assert.equal((await handle(new Request('https://edge.example.test/guest/unknown'), env,
    () => assert.fail('must not fetch'))).status, 404);
  const response = await handle(new Request('https://edge.example.test/api/config'), env,
    () => { throw new Error('origin unavailable'); });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await handle(new Request('https://edge.example.test/api/config'),
    { ...env, DEPLOYMENT_LANE: 'prod' }, () => assert.fail('must not fetch'))).status, 503);
});

async function fixture(t) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'guest-edge-test-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const guestDir = path.join(tempRoot, 'guest');
  const snapshotDir = path.join(tempRoot, 'snapshots');
  await mkdir(guestDir);
  await mkdir(snapshotDir);
  await writeFile(path.join(guestDir, 'index.html'), '<html>guest</html>');
  await writeFile(path.join(guestDir, 'sw.js'), '// guest cache');
  return { accountId, origin: env.APP_ORIGIN, lane: 'dev', guestDir, snapshotDir, tempRoot };
}

test('package has isolated dev configuration, direct asset navigation rewrites, and no KV or zone routes', async t => {
  const opts = await fixture(t);
  await writeFile(path.join(opts.snapshotDir, 'EVENT123.json'), JSON.stringify({ schema: 1, publishedAt: 1,
    event: { id: 'public', name: 'Event', joinCode: 'EVENT123', slug: null, maxPhotos: 12,
      revealMode: 'instant', revealDelayHours: 0, videoSeconds: 0, startsAt: 1, expiresAt: 100,
      aspectRatios: ['1:1'], organizerCode: 'must-not-deploy', theme: { ownerEmail: 'private' } },
  }));
  const { artifact, snapshots } = await prepare(opts);
  assert.equal(snapshots, 1);
  const config = JSON.parse(await readFile(path.join(artifact, 'wrangler.json'), 'utf8'));
  assert.equal(config.name, 'snapdini-guest-dev');
  assert.equal(config.account_id, accountId);
  assert.deepEqual(config.routes, []);
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.assets.run_worker_first, ['/api/*', '/uploads/*']);
  assert.equal(config.assets.not_found_handling, 'none');
  assert.equal(Object.hasOwn(config, 'kv_namespaces'), false);
  assert.equal(Object.hasOwn(config, 'triggers'), false);
  const redirects = await readFile(path.join(artifact, 'public/_redirects'), 'utf8');
  for (const route of ['join', 'e', 'saved']) assert.ok(redirects.includes(`/guest/${route}/* /guest/shell 200`));
  assert.equal(await readFile(path.join(artifact, 'public/guest/shell'), 'utf8'), '<html>guest</html>');
  const headers = await readFile(path.join(artifact, 'public/_headers'), 'utf8');
  for (const route of ['shell', 'join/*', 'e/*', 'saved/*'])
    assert.ok(headers.includes(`/guest/${route}\n  Content-Type: text/html; charset=utf-8`));
  const json = await readFile(path.join(artifact, 'public/guest/events/EVENT123.json'), 'utf8');
  assert.equal(json.includes('must-not-deploy'), false);
  assert.equal(json.includes('ownerEmail'), false);
});

test('package refuses secrets, source maps and symlinks in the supposedly guest-only build', async t => {
  for (const filename of ['.env', 'private.ts', 'index.js.map']) {
    const opts = await fixture(t);
    await writeFile(path.join(opts.guestDir, filename), 'sensitive');
    await assert.rejects(prepare(opts), /Unexpected guest artifact/);
  }
  const opts = await fixture(t);
  await symlink('/etc/passwd', path.join(opts.guestDir, 'leak.js'));
  await assert.rejects(prepare(opts), /Unexpected guest artifact/);
  await assert.rejects(prepare({ ...opts, accountId: '' }), /explicit Cloudflare account ID/);
});

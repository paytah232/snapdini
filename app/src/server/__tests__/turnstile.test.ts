// Verifier unit tests. Run with:  npm run test:unit   (node:test via tsx — no new dependencies)
//
// This code sits in front of login, sign-up and the contact form on a LIVE site, and it is
// fail-CLOSED by default: a bug here locks real customers out. Each case below is a way that
// could happen.
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

const ENV = { ...process.env };
async function load(env: Record<string, string | undefined>) {
  for (const k of ['TURNSTILE_SECRET', 'TURNSTILE_SITE_KEY', 'TURNSTILE_ALLOWED_HOSTNAMES', 'TURNSTILE_FAIL_OPEN', 'BASE_URL']) delete process.env[k];
  Object.assign(process.env, env);
  // bust the module cache so module-level env reads re-evaluate
  return await import('../turnstile');   // env is read lazily, so one import is fine
}
const reply = (body: unknown, ok = true) =>
  mock.method(globalThis, 'fetch', async () => ({ ok, json: async () => body }) as unknown as Response);

after(() => { process.env = { ...ENV }; });

describe('disabled (no secret) — self-host and pre-key deploys', () => {
  test('always passes and never calls Cloudflare', async () => {
    const t = await load({});
    const f = mock.method(globalThis, 'fetch', async () => { throw new Error('must not be called'); });
    assert.equal(t.turnstileEnabled(), false);
    assert.deepEqual(await t.verifyTurnstile(undefined, '1.2.3.4'), { ok: true });
    assert.equal(f.mock.callCount(), 0);
    f.mock.restore();
  });
});

describe('enabled', () => {
  const base = { TURNSTILE_SECRET: 's', BASE_URL: 'https://snapdini.com' };

  test('accepts a good token with matching action + hostname', async () => {
    const t = await load(base);
    const f = reply({ success: true, action: 'login', hostname: 'snapdini.com' });
    assert.deepEqual(await t.verifyTurnstile('tok', '1.2.3.4', 'login'), { ok: true });
    f.mock.restore();
  });

  test('rejects a missing token', async () => {
    const t = await load(base);
    assert.equal((await t.verifyTurnstile(undefined, '1.2.3.4', 'login')).ok, false);
  });

  test('rejects an oversized token without calling Cloudflare', async () => {
    const t = await load(base);
    const f = mock.method(globalThis, 'fetch', async () => { throw new Error('must not be called'); });
    const r = await t.verifyTurnstile('x'.repeat(2049), '1.2.3.4', 'login');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'oversized-token');
    assert.equal(f.mock.callCount(), 0);
    f.mock.restore();
  });

  test('rejects when Cloudflare says success:false, surfacing the error codes', async () => {
    const t = await load(base);
    const f = reply({ success: false, 'error-codes': ['invalid-input-response'] });
    const r = await t.verifyTurnstile('tok', '1.2.3.4', 'login');
    assert.equal(r.ok, false);
    assert.match(r.reason!, /invalid-input-response/);
    f.mock.restore();
  });

  test('rejects a token minted for a DIFFERENT action (contact token replayed at login)', async () => {
    const t = await load(base);
    const f = reply({ success: true, action: 'contact', hostname: 'snapdini.com' });
    const r = await t.verifyTurnstile('tok', '1.2.3.4', 'login');
    assert.equal(r.ok, false);
    assert.match(r.reason!, /action-mismatch/);
    f.mock.restore();
  });

  test('rejects a token solved on someone else’s hostname', async () => {
    const t = await load(base);
    const f = reply({ success: true, action: 'login', hostname: 'evil.example' });
    const r = await t.verifyTurnstile('tok', '1.2.3.4', 'login');
    assert.equal(r.ok, false);
    assert.match(r.reason!, /hostname-not-allowed/);
    f.mock.restore();
  });

  test('honours the extra hostname allowlist (dev + www)', async () => {
    const t = await load({ ...base, TURNSTILE_ALLOWED_HOSTNAMES: 'dev.snapdini.com,www.snapdini.com' });
    for (const h of ['snapdini.com', 'dev.snapdini.com', 'www.snapdini.com']) {
      const f = reply({ success: true, action: 'login', hostname: h });
      assert.equal((await t.verifyTurnstile('tok', undefined, 'login')).ok, true, h);
      f.mock.restore();
    }
  });

  test('hostname match is case-insensitive', async () => {
    const t = await load(base);
    const f = reply({ success: true, action: 'login', hostname: 'SnapDini.COM' });
    assert.equal((await t.verifyTurnstile('tok', undefined, 'login')).ok, true);
    f.mock.restore();
  });

  test('Cloudflare TESTING keys bypass action/hostname (so the suite can run)', async () => {
    const t = await load(base);
    const f = reply({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } });
    assert.deepEqual(await t.verifyTurnstile('tok', undefined, 'login'), { ok: true });
    f.mock.restore();
  });

  test('DEFAULT is fail-CLOSED when siteverify is unreachable', async () => {
    const t = await load(base);
    const f = mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
    const r = await t.verifyTurnstile('tok', '1.2.3.4', 'login');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'verify-unreachable');
    f.mock.restore();
  });

  test('TURNSTILE_FAIL_OPEN=1 rides out a Cloudflare outage', async () => {
    const t = await load({ ...base, TURNSTILE_FAIL_OPEN: '1' });
    const f = mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
    assert.deepEqual(await t.verifyTurnstile('tok', '1.2.3.4', 'login'), { ok: true });
    f.mock.restore();
  });

  test('a non-200 from siteverify is treated as unreachable, not as a pass', async () => {
    const t = await load(base);
    const f = reply({}, false);
    assert.equal((await t.verifyTurnstile('tok', undefined, 'login')).ok, false);
    f.mock.restore();
  });

  test('rejects when BASE_URL is unset and no allowlist is configured', async () => {
    const t = await load({ TURNSTILE_SECRET: 's' });
    const r = await t.verifyTurnstile('tok', undefined, 'login');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-hostname-allowlist');
  });
});

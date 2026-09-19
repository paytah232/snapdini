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

  test('FAIL_OPEN also covers a blocked widget (no token at all)', async () => {
    // An ad blocker or privacy DNS stops the widget loading, so the client has nothing to send.
    // That visitor is not a bot and must not be locked out of sign-up/login/contact.
    //
    // The reason travels WITH the pass on purpose: a bare `{ ok: true }` cannot be told apart from
    // a token that was actually solved, and the count of hatch-only passes is the one measurement
    // that says whether TURNSTILE_FAIL_OPEN can be turned off without locking real people out.
    const t = await load({ ...base, TURNSTILE_FAIL_OPEN: '1' });
    assert.deepEqual(await t.verifyTurnstile(undefined, '1.2.3.4', 'login'),
      { ok: true, reason: 'fail-open:missing-token' });
  });

  test('without FAIL_OPEN a missing token is still refused', async () => {
    const t = await load(base);
    assert.equal((await t.verifyTurnstile(undefined, '1.2.3.4', 'login')).ok, false);
  });

  test('TURNSTILE_FAIL_OPEN=1 rides out a Cloudflare outage', async () => {
    const t = await load({ ...base, TURNSTILE_FAIL_OPEN: '1' });
    const f = mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
    assert.deepEqual(await t.verifyTurnstile('tok', '1.2.3.4', 'login'),
      { ok: true, reason: 'fail-open:verify-unreachable' });
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

// ── What a refused person is actually told ────────────────────────────────────
//
// For a year this guard answered every refusal with one sentence — "Bot check failed, please
// reload the page and try again" — and the commonest refusal by far is a widget that never
// loaded, which no amount of reloading fixes. Someone behind an ad blocker or a privacy DNS
// resolver was handed a 403 and a loop, with nothing naming what to unblock. These tests exist
// because the value of the change is precisely that the three answers DIFFER; a well-meaning
// tidy-up that collapses them back into one shared string would undo it silently.
describe('requireTurnstile — the refusal a person sees', () => {
  const base = { TURNSTILE_SECRET: 's', BASE_URL: 'https://snapdini.com' };

  type Body = { error?: string; code?: string };
  /** Minimal express doubles: enough to record the status, the body and whether next() ran. */
  function harness(body: Record<string, unknown> = {}) {
    const sent: { status: number | null; body: Body } = { status: null, body: {} };
    let nexted = false;
    const res = {
      status(c: number) { sent.status = c; return res; },
      json(b: Body) { sent.body = b; return res; },
    };
    return {
      req: { method: 'POST', path: '/api/auth/login', ip: '1.2.3.4', headers: {}, body } as any,
      res: res as any,
      next: (() => { nexted = true; }) as any,
      sent,
      nexted: () => nexted,
    };
  }

  test('a stack with NO keys configured lets sign-up straight through', async () => {
    // The self-host case. Nothing renders a widget there, so nothing may be demanded of it.
    const t = await load({});
    const h = harness({});
    const f = mock.method(globalThis, 'fetch', async () => { throw new Error('must not be called'); });
    await t.requireTurnstile('register')(h.req, h.res, h.next);
    assert.equal(h.nexted(), true);
    assert.equal(h.sent.status, null);
    assert.equal(f.mock.callCount(), 0);
    f.mock.restore();
  });

  test('a MISSING token says what is blocking it and what to do about it', async () => {
    const t = await load(base);
    const h = harness({});
    await t.requireTurnstile('login')(h.req, h.res, h.next);
    assert.equal(h.nexted(), false);
    assert.equal(h.sent.status, 403);
    assert.equal(h.sent.body.code, 'security-check-blocked');
    assert.match(h.sent.body.error!, /ad blocker/i);
    assert.match(h.sent.body.error!, /private DNS/i);
    assert.match(h.sent.body.error!, /challenges\.cloudflare\.com/);      // the address to allow
    assert.match(h.sent.body.error!, /different network/i);               // the other way out
  });

  test('an INVALID token gets a DIFFERENT answer — reload, not "unblock an address"', async () => {
    const t = await load(base);
    const f = reply({ success: false, 'error-codes': ['invalid-input-response'] });
    const h = harness({ 'cf-turnstile-response': 'tok' });
    await t.requireTurnstile('login')(h.req, h.res, h.next);
    f.mock.restore();
    assert.equal(h.nexted(), false);
    assert.equal(h.sent.status, 403);
    assert.equal(h.sent.body.code, 'security-check-failed');
    assert.match(h.sent.body.error!, /reload/i);
    // Telling a bot-shaped request to go and edit its DNS settings would be nonsense, and telling
    // a real person whose token simply expired the same thing sends them off fixing the wrong thing.
    assert.doesNotMatch(h.sent.body.error!, /challenges\.cloudflare\.com/);
  });

  test('our own outage is our own fault: 503, and never phrased as the visitor’s problem', async () => {
    const t = await load(base);
    const f = mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
    const h = harness({ 'cf-turnstile-response': 'tok' });
    await t.requireTurnstile('login')(h.req, h.res, h.next);
    f.mock.restore();
    assert.equal(h.sent.status, 503);
    assert.equal(h.sent.body.code, 'security-check-unavailable');
    assert.match(h.sent.body.error!, /try again/i);
    assert.doesNotMatch(h.sent.body.error!, /ad blocker|your browser/i);
  });

  test('with FAIL_OPEN a token-less submit is passed on, and nothing is said to the person', async () => {
    const t = await load({ ...base, TURNSTILE_FAIL_OPEN: '1' });
    const h = harness({});
    await t.requireTurnstile('login')(h.req, h.res, h.next);
    assert.equal(h.nexted(), true);
    assert.equal(h.sent.status, null);
  });

  test('none of the three name a product the customer has never heard of', async () => {
    const t = await load(base);
    for (const reason of ['missing-token', 'verify-unreachable', 'invalid-input-response']) {
      const { error } = t.refusalFor(reason);
      // "challenges.cloudflare.com" is an address to allow, so it stays; "Turnstile", "CAPTCHA"
      // and a bare "Cloudflare" are our vocabulary, not theirs.
      assert.doesNotMatch(error, /turnstile|captcha|cloudflare(?!\.com)/i, reason);
      assert.doesNotMatch(error, /\btoken\b|\bbot\b/i, reason);
    }
  });
});

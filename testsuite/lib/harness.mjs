// Shared harness for the Snapdini integration suite. Extracted verbatim (bar the notes below)
// from the head of the old single-file testsuite/run.mjs so that every spec under
// testsuite/specs/ talks to the stack the same way.
//
// Three deliberate differences from the original module scope:
//   1. `cookie` was a module-level `let` that the test body reassigned. A bare exported `let`
//      cannot be reassigned from an importer, so the jar now lives on `session.cookie`.
//   2. The test-user email is unique per PROCESS (pid + random suffix), not just per second —
//      specs run in parallel and would otherwise collide on register.
//   3. `bootstrapOwner()` / `spec()` / `cleanup()` are new: they give each spec process its own
//      verified, logged-in owner account and tear it down again.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const BASE = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
export const DB = 'snapdini-dev-db';
export const POOL = '/bigdata/snapdini/dev';
const SAMPLE = path.join(import.meta.dirname, '..', '..', 'loadtest', 'sample.jpg');
export const img = fs.readFileSync(SAMPLE);

let pass = 0, fail = 0;
const fails = [];
export function ok(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
export function group(t) { console.log(`\n## ${t}`); }

// ── DB helper (psql, unaligned tuples) ──
export function dbq(sql) {
  return execFileSync('docker', ['exec', DB, 'psql', '-U', 'snapdini', '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}

// ── HTTP helper with a session cookie jar ──
// Mutable jar: specs swap sessions with `session.cookie = ownerCookie` etc.
export const session = { cookie: '' };
// Turnstile guards register/login/contact. The dev stack runs Cloudflare's TESTING keys, which
// accept any well-formed token, so send a dummy on JSON posts — that exercises the real middleware
// end to end rather than routing around it.
export const TURNSTILE_DUMMY = 'XXXX.DUMMY.TOKEN.XXXX';

export async function api(method, p, { body, headers = {}, raw = false } = {}) {
  if (method === 'POST' && body && typeof body === 'object' && !(body instanceof FormData)
      && body['cf-turnstile-response'] === undefined) {
    body = { ...body, 'cf-turnstile-response': TURNSTILE_DUMMY };
  }
  const h = { ...headers };
  if (session.cookie) h.cookie = session.cookie;
  if (body && !(body instanceof FormData)) { h['content-type'] = 'application/json'; }
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const setC = res.headers.getSetCookie?.() || [];
  for (const c of setC) { const m = /^sid=[^;]*/.exec(c); if (m) session.cookie = m[0]; }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

export const TS = dbq('SELECT extract(epoch from now())::bigint'); // server clock for unique email
// Per-PROCESS uniqueness: TS only has second resolution, so two specs launched in the same second
// would otherwise register the same address and the second one would fail.
export const UNIQ = `${TS}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
export const EMAIL = `test_${UNIQ}@example.com`;
export const createdJoinCodes = [];
// Event ids, so teardown can delete the whole per-event upload directory. The old cleanup looked
// the filenames up from `photos`, which a run-sweep spec had already deleted — leaking those JPEGs
// into the dev pool on every run.
export const createdEventIds = [];
// Ownerless/demo rows a spec created that are not covered by deleting the test user.
export const orphanJoinCodes = [];

export const HOUR = 3_600_000;

export async function createEvent(over = {}) {
  const now = Date.now();
  const payload = {
    name: 'IT ' + Math.random().toString(36).slice(2, 7),
    durationHours: 24,
    maxPhotos: 12,
    revealMode: 'instant',
    startsAt: now,
    aspectRatios: ['1:1'],
    ...over,
  };
  const r = await api('POST', '/api/events', { body: payload });
  if (r.status !== 200 || !r.json?.joinCode) throw new Error(`createEvent failed ${r.status}: ${r.text.slice(0, 120)}`);
  createdJoinCodes.push(r.json.joinCode);
  const id = dbq(`SELECT id FROM events WHERE join_code='${r.json.joinCode}'`);
  createdEventIds.push(id);
  return { joinCode: r.json.joinCode, organizerCode: r.json.organizerCode, id };
}
export const org = (c) => ({ 'x-organizer-code': c });

export async function join(code, name) {
  const r = await api('POST', '/api/participants', { body: { joinCode: code, name } });
  return r;
}
export async function upload(token, video = false) {
  const fd = new FormData();
  fd.append('sessionToken', token);
  fd.append('photo', new Blob([img], { type: video ? 'video/mp4' : 'image/jpeg' }), video ? 'v.mp4' : 'p.jpg');
  return api('POST', '/api/photos', { body: fd });
}
export const gallery = (code, q = '') => api('GET', `/api/photos/${code}?gallery=true${q}`);

// ════════════════════════════════════════════════════════════════════════════
// Every spec needs a verified, logged-in owner account. This is the original
// `group('Auth + account')` block: with `assert: true` it emits its 6 assertions (the auth spec
// does that, exactly once per run); with `assert: false` it does the same HTTP work silently.
export async function bootstrapOwner({ assert = false } = {}) {
  if (assert) group('Auth + account');
  const reg = await api('POST', '/api/auth/register', { body: { email: EMAIL, password: 'hunter2hunter2', displayName: 'IT Bot' } });
  if (assert) ok('register 201', reg.status === 201, `${reg.status}`);
  if (assert) ok('register returns devLink (email off)', !!reg.json?.devLink);
  const vu = new URL(reg.json.devLink); // devLink uses BASE_URL's domain — take just the path
  const ver = await api('GET', vu.pathname + vu.search);
  if (assert) ok('verify redirects (302)', ver.status === 302, `${ver.status}`);
  if (assert) ok('session cookie set', !!session.cookie);
  if (assert) ok('user row email_verified_at set', dbq(`SELECT email_verified_at IS NOT NULL FROM users WHERE email='${EMAIL}'`) === 't');
  const me = await api('GET', '/api/auth/me');
  if (assert) ok('me() returns verified user', me.json?.user?.emailVerified === true);
}

export async function cleanup({ clientErrors = false } = {}) {
  try {
    // Remove upload files for this run's events, then delete the test user (cascades events/participants/photos).
    for (const c of createdJoinCodes) {
      const files = dbq(`SELECT filename FROM photos ph JOIN events e ON e.id=ph.event_id WHERE e.join_code='${c}'`).split('\n').filter(Boolean);
      for (const f of files) { try { fs.rmSync(path.join(POOL, f), { force: true }); fs.rmSync(path.join(POOL, f.replace(/\.[^.]+$/, '_thumb.webp')), { force: true }); } catch {} }
    }
    // Whole-directory sweep: robust even when the photos rows are already gone.
    for (const id of createdEventIds) {
      try { fs.rmSync(path.join(POOL, id), { recursive: true, force: true }); } catch {}
    }
    dbq(`DELETE FROM users WHERE email='${EMAIL}'`);
    // Demo events are ownerless, so deleting the test user does not remove them and they would
    // otherwise accumulate and inflate the admin overview's demo count.
    for (const c of orphanJoinCodes) { try { dbq(`DELETE FROM events WHERE join_code='${c}'`); } catch {} }
    // Only the spec that files a 'regression test' client error clears them — doing it everywhere
    // would let one spec's teardown race that spec's own assertion.
    if (clientErrors) dbq(`DELETE FROM client_errors WHERE message='regression test'`);
    console.log('\n[cleanup] removed test user + events + upload files');
  } catch (e) { console.log('[cleanup] partial: ' + e.message); }
}

// Spec entry point. Bootstraps an owner, runs the body, always tears down, then prints the
// machine-readable result the orchestrator parses — which MUST be the last line of stdout.
//   bootstrap: 'silent' (default) | 'assert' (emit the Auth + account assertions) | false
export async function spec(name, fn, { bootstrap = 'silent', clientErrors = false } = {}) {
  try {
    if (bootstrap !== false) await bootstrapOwner({ assert: bootstrap === 'assert' });
    await fn();
  } catch (e) {
    fail++;
    fails.push(`${name}: SPEC ERROR ${e && e.message ? e.message : String(e)}`);
    console.log(`  ✗ SPEC ERROR in ${name} — ${e && e.stack ? e.stack : e}`);
  }
  await cleanup({ clientErrors });
  console.log(`##RESULT ${JSON.stringify({ spec: name, pass, fail, fails })}`);
  process.exit(fail ? 1 : 0);
}

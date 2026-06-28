// Snapdini integration suite — drives the real API end-to-end across event settings,
// reveal/ending logic, sharing/downloads, moderation, rating modes, timezones, limits and
// lifecycle, and validates the resulting Postgres state directly. Run against a live stack.
//
//   node testsuite/run.mjs [baseURL]
//
// Billing is assumed OFF (self-host) so caps don't interfere — that path is covered
// separately. Cleans up everything it creates (test user + events + upload files).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const DB = 'snapdini-dev-db';
const POOL = '/bigdata/snapdini/dev';
const SAMPLE = path.join(import.meta.dirname, '..', 'loadtest', 'sample.jpg');
const img = fs.readFileSync(SAMPLE);

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function group(t) { console.log(`\n## ${t}`); }

// ── DB helper (psql, unaligned tuples) ──
function dbq(sql) {
  return execFileSync('docker', ['exec', DB, 'psql', '-U', 'snapdini', '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}

// ── HTTP helper with a session cookie jar ──
let cookie = '';
async function api(method, p, { body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body && !(body instanceof FormData)) { h['content-type'] = 'application/json'; }
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const setC = res.headers.getSetCookie?.() || [];
  for (const c of setC) { const m = /^sid=[^;]*/.exec(c); if (m) cookie = m[0]; }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

const TS = dbq('SELECT extract(epoch from now())::bigint'); // server clock for unique email
const EMAIL = `test_${TS}@example.com`;
const createdJoinCodes = [];

const HOUR = 3_600_000;

async function createEvent(over = {}) {
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
  return { joinCode: r.json.joinCode, organizerCode: r.json.organizerCode, id };
}
const org = (c) => ({ 'x-organizer-code': c });

async function join(code, name) {
  const r = await api('POST', '/api/participants', { body: { joinCode: code, name } });
  return r;
}
async function upload(token, video = false) {
  const fd = new FormData();
  fd.append('sessionToken', token);
  fd.append('photo', new Blob([img], { type: video ? 'video/mp4' : 'image/jpeg' }), video ? 'v.mp4' : 'p.jpg');
  return api('POST', '/api/photos', { body: fd });
}
const gallery = (code, q = '') => api('GET', `/api/photos/${code}?gallery=true${q}`);

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`# Snapdini integration suite → ${BASE}`);

  // ── Auth ──
  group('Auth + account');
  const reg = await api('POST', '/api/auth/register', { body: { email: EMAIL, password: 'hunter2hunter2', displayName: 'IT Bot' } });
  ok('register 201', reg.status === 201, `${reg.status}`);
  ok('register returns devLink (email off)', !!reg.json?.devLink);
  const vu = new URL(reg.json.devLink); // devLink uses BASE_URL's domain — take just the path
  const ver = await api('GET', vu.pathname + vu.search);
  ok('verify redirects (302)', ver.status === 302, `${ver.status}`);
  ok('session cookie set', !!cookie);
  ok('user row email_verified_at set', dbq(`SELECT email_verified_at IS NOT NULL FROM users WHERE email='${EMAIL}'`) === 't');
  const me = await api('GET', '/api/auth/me');
  ok('me() returns verified user', me.json?.user?.emailVerified === true);

  // ── Instant reveal + basic flow + DB ──
  group('Instant reveal + capture flow');
  const e1 = await createEvent({ revealMode: 'instant', maxPhotos: 6, aspectRatios: ['1:1', '4:5'] });
  ok('event row created', !!e1.id);
  ok('DB reveal_mode=instant', dbq(`SELECT reveal_mode FROM events WHERE id='${e1.id}'`) === 'instant');
  ok('DB max_photos=6', dbq(`SELECT max_photos FROM events WHERE id='${e1.id}'`) === '6');
  ok('DB aspect_ratios persisted', dbq(`SELECT aspect_ratios FROM events WHERE id='${e1.id}'`).includes('4:5'));
  const j1 = await join(e1.joinCode, 'Alice');
  const j2 = await join(e1.joinCode, 'Bob');
  ok('two joins ok', j1.status === 200 && j2.status === 200);
  ok('DB participants=2', dbq(`SELECT count(*) FROM participants WHERE event_id='${e1.id}'`) === '2');
  const u1 = await upload(j1.json.sessionToken);
  await upload(j2.json.sessionToken);
  ok('upload ok', u1.status === 200);
  // New model: uploads always store 'pending'; visibility is gated by the moderation SETTING
  // (this event has moderation off, so the pending photos still show in the gallery — see below).
  ok('DB photos=2 pending', dbq(`SELECT count(*) FROM photos WHERE event_id='${e1.id}' AND status='pending'`) === '2');
  ok('photos_taken incremented', dbq(`SELECT photos_taken FROM participants WHERE event_id='${e1.id}' AND name='Alice'`) === '1');
  const g1 = await gallery(e1.joinCode);
  ok('instant gallery revealed', g1.json?.revealed === true);
  ok('instant gallery shows 2 photos', g1.json?.photos?.length === 2);
  ok('view: photo has url+thumbUrl+participantName', !!g1.json.photos[0].url && !!g1.json.photos[0].thumbUrl && !!g1.json.photos[0].participantName);

  // ── Manual reveal ──
  group('Manual reveal / unreveal');
  const e2 = await createEvent({ revealMode: 'manual' });
  const j = await join(e2.joinCode, 'C'); await upload(j.json.sessionToken);
  let g = await gallery(e2.joinCode);
  ok('manual hidden before reveal', g.json?.revealed === false);
  ok('manual hides photos but reports count', g.json?.photos === undefined && g.json?.photoCount === 1);
  await api('POST', `/api/events/${e2.joinCode}/reveal`, { headers: org(e2.organizerCode) });
  ok('DB revealed_at set after reveal', dbq(`SELECT revealed_at IS NOT NULL FROM events WHERE id='${e2.id}'`) === 't');
  g = await gallery(e2.joinCode);
  ok('manual visible after reveal', g.json?.revealed === true && g.json?.photos?.length === 1);
  await api('POST', `/api/events/${e2.joinCode}/unreveal`, { headers: org(e2.organizerCode) });
  ok('DB revealed_at cleared after unreveal', dbq(`SELECT revealed_at IS NULL FROM events WHERE id='${e2.id}'`) === 't');
  ok('hidden again after unreveal', (await gallery(e2.joinCode)).json?.revealed === false);

  // ── At-end reveal + delay + reveal-at math ──
  group('At-the-end reveal + delay');
  const past = Date.now() - 2 * HOUR;
  const eEnded = await createEvent({ revealMode: 'at_end', startsAt: past, durationHours: 1, revealDelayHours: 0 }); // expired 1h ago, delay 0
  ok('at_end + expired + delay0 → revealed', (await gallery(eEnded.joinCode)).json?.revealed === true);
  const eDelay = await createEvent({ revealMode: 'at_end', startsAt: past, durationHours: 1, revealDelayHours: 24 }); // expired, but 24h delay
  const gd = await gallery(eDelay.joinCode);
  const expectedRevealAt = (past + 1 * HOUR) + 24 * HOUR;
  ok('at_end + delay not yet → hidden', gd.json?.revealed === false);
  ok('revealAt = expiresAt + delay', gd.json?.revealAt === expectedRevealAt, `${gd.json?.revealAt} vs ${expectedRevealAt}`);
  const eOngoing = await createEvent({ revealMode: 'at_end', startsAt: Date.now(), durationHours: 24 });
  ok('at_end ongoing → hidden', (await gallery(eOngoing.joinCode)).json?.revealed === false);

  // ── Moderation ──
  group('Moderation queue');
  const eMod = await createEvent({ revealMode: 'manual', moderationEnabled: true });
  ok('DB moderation_enabled=true', dbq(`SELECT moderation_enabled FROM events WHERE id='${eMod.id}'`) === 't');
  const jm = await join(eMod.joinCode, 'M'); await upload(jm.json.sessionToken);
  ok('moderated upload → pending', dbq(`SELECT status FROM photos WHERE event_id='${eMod.id}'`) === 'pending');
  await api('POST', `/api/events/${eMod.joinCode}/reveal`, { headers: org(eMod.organizerCode) });
  ok('pending photo NOT in revealed gallery', ((await gallery(eMod.joinCode)).json?.photos?.length || 0) === 0);
  const pid = dbq(`SELECT id FROM photos WHERE event_id='${eMod.id}'`);
  await api('POST', `/api/events/${eMod.joinCode}/moderate`, { headers: org(eMod.organizerCode), body: { photoIds: [pid], action: 'approve' } });
  ok('approved → status approved', dbq(`SELECT status FROM photos WHERE id='${pid}'`) === 'approved');
  ok('approved photo now in gallery', (await gallery(eMod.joinCode)).json?.photos?.length === 1);
  // reject path
  const jm2 = await join(eMod.joinCode, 'M2'); await upload(jm2.json.sessionToken);
  const pid2 = dbq(`SELECT id FROM photos WHERE event_id='${eMod.id}' AND status='pending'`);
  await api('POST', `/api/events/${eMod.joinCode}/moderate`, { headers: org(eMod.organizerCode), body: { photoIds: [pid2], action: 'reject' } });
  // Reject now bins (recoverable), not hard-delete: row kept as 'rejected' and excluded from the gallery.
  ok('rejected → status rejected (row kept)', dbq(`SELECT status FROM photos WHERE id='${pid2}'`) === 'rejected');
  ok('rejected photo not in gallery', (await gallery(eMod.joinCode)).json?.photos?.length === 1);
  // restore (approve) brings it back
  await api('POST', `/api/events/${eMod.joinCode}/moderate`, { headers: org(eMod.organizerCode), body: { photoIds: [pid2], action: 'approve' } });
  ok('restore → status approved', dbq(`SELECT status FROM photos WHERE id='${pid2}'`) === 'approved');
  // instant forces moderation off
  const eInstMod = await createEvent({ revealMode: 'instant', moderationEnabled: true });
  ok('instant clamps moderation off', dbq(`SELECT moderation_enabled FROM events WHERE id='${eInstMod.id}'`) === 'f');

  // ── Sharing: downloads + highlights + rating modes ──
  group('Sharing / downloads / rating');
  const eShare = await createEvent({ revealMode: 'instant', allowDownloads: true });
  const js = await join(eShare.joinCode, 'S'); await upload(js.json.sessionToken);
  ok('gallery allowDownloads=true', (await gallery(eShare.joinCode)).json?.allowDownloads === true);
  ok('zip download 200 when allowed', (await api('GET', `/api/photos/${eShare.joinCode}/download`)).status === 200);
  await api('POST', `/api/events/${eShare.joinCode}/allow-downloads`, { headers: org(eShare.organizerCode), body: { allowDownloads: false } });
  ok('DB allow_downloads=false', dbq(`SELECT allow_downloads FROM events WHERE id='${eShare.id}'`) === 'f');
  ok('zip download 403 when disabled', (await api('GET', `/api/photos/${eShare.joinCode}/download`)).status === 403);
  // rating (favourite mode): 5★ = highlight
  const sp = dbq(`SELECT id FROM photos WHERE event_id='${eShare.id}'`);
  await api('POST', `/api/events/${eShare.joinCode}/rate`, { headers: org(eShare.organizerCode), body: { photoId: sp, rating: 5 } });
  ok('rate 5 → rating=5', dbq(`SELECT rating FROM photos WHERE id='${sp}'`) === '5');
  ok('rate 5 → is_highlighted synced', dbq(`SELECT is_highlighted FROM photos WHERE id='${sp}'`) === 't');
  const gh = await gallery(eShare.joinCode, '&highlightsOnly=true');
  ok('gallery hasHighlights + highlightsOnly filter', gh.json?.hasHighlights === true && gh.json?.photos?.length === 1);
  // stars mode (set via the settings editor — ratingMode is a post-create curation setting): 3★ not a highlight
  const eStars = await createEvent();
  await api('PUT', `/api/events/${eStars.joinCode}/settings`, { headers: org(eStars.organizerCode), body: { ratingMode: 'stars' } });
  ok('DB rating_mode=stars (via settings)', dbq(`SELECT rating_mode FROM events WHERE id='${eStars.id}'`) === 'stars');
  const jst = await join(eStars.joinCode, 'St'); await upload(jst.json.sessionToken);
  const stp = dbq(`SELECT id FROM photos WHERE event_id='${eStars.id}'`);
  await api('POST', `/api/events/${eStars.joinCode}/rate`, { headers: org(eStars.organizerCode), body: { photoId: stp, rating: 3 } });
  ok('rate 3 → rating=3', dbq(`SELECT rating FROM photos WHERE id='${stp}'`) === '3');
  ok('rate 3 → not highlighted (only 5★ is)', dbq(`SELECT is_highlighted FROM photos WHERE id='${stp}'`) === 'f');

  // ── Timezones ──
  group('Timezones');
  const tz = 'Australia/Brisbane';
  const fixedEpoch = Date.UTC(2030, 0, 1, 12, 0, 0); // explicit epoch, tz-independent
  const eTz = await createEvent({ timezone: tz, startsAt: fixedEpoch, durationHours: 2 });
  ok('DB timezone persisted', dbq(`SELECT timezone FROM events WHERE id='${eTz.id}'`) === tz);
  ok('DB starts_at = provided epoch', dbq(`SELECT starts_at FROM events WHERE id='${eTz.id}'`) === String(fixedEpoch));
  ok('getEvent returns timezone', (await api('GET', `/api/events/${eTz.joinCode}`)).json?.timezone === tz);
  // server-parsed date/time (no epoch) → parsed as UTC
  const eParse = await api('POST', '/api/events', { body: { name: 'tzparse', durationHours: 1, maxPhotos: 6, revealMode: 'instant', startDate: '2030-06-15', startTime: '09:30', timezone: tz } });
  createdJoinCodes.push(eParse.json.joinCode);
  const parsedStarts = dbq(`SELECT starts_at FROM events WHERE join_code='${eParse.json.joinCode}'`);
  ok('server parses startDate/startTime as UTC', parsedStarts === String(Date.parse('2030-06-15T09:30:00.000Z')), parsedStarts);

  // ── Limits + lifecycle ──
  group('Limits + lifecycle');
  const eLim = await createEvent({ maxPhotos: 2 });
  const jl = await join(eLim.joinCode, 'L');
  await upload(jl.json.sessionToken); await upload(jl.json.sessionToken);
  const third = await upload(jl.json.sessionToken);
  ok('maxPhotos enforced (3rd → 403)', third.status === 403, `${third.status}`);
  // lock
  await api('POST', `/api/events/${eLim.joinCode}/lock`, { headers: org(eLim.organizerCode) });
  ok('DB is_locked=true', dbq(`SELECT is_locked FROM events WHERE id='${eLim.id}'`) === 't');
  ok('join blocked when locked (403)', (await join(eLim.joinCode, 'X')).status === 403);
  await api('POST', `/api/events/${eLim.joinCode}/lock`, { headers: org(eLim.organizerCode) });
  ok('unlock → join ok', (await join(eLim.joinCode, 'Y')).status === 200);
  // upcoming
  const eUp = await createEvent({ startsAt: Date.now() + 24 * HOUR });
  ok('upcoming getEvent isUpcoming', (await api('GET', `/api/events/${eUp.joinCode}`)).json?.isUpcoming === true);
  ok('join upcoming → 403', (await join(eUp.joinCode, 'Z')).status === 403);
  // expired
  const eExp = await createEvent({ startsAt: past, durationHours: 1 });
  ok('join expired → 410', (await join(eExp.joinCode, 'Q')).status === 410);

  // ── Settings edit ──
  group('Settings editor (PUT /settings)');
  const eSet = await createEvent({ revealMode: 'instant' });
  await api('PUT', `/api/events/${eSet.joinCode}/settings`, { headers: org(eSet.organizerCode), body: { name: 'Renamed', revealMode: 'manual', moderationEnabled: true, timezone: 'Europe/London', aspectRatios: ['1:1', '9:16'], ratingMode: 'stars' } });
  const row = dbq(`SELECT name||'|'||reveal_mode||'|'||moderation_enabled||'|'||timezone||'|'||rating_mode FROM events WHERE id='${eSet.id}'`);
  ok('settings persisted', row === 'Renamed|manual|true|Europe/London|stars', row);
  ok('settings aspect updated', dbq(`SELECT aspect_ratios FROM events WHERE id='${eSet.id}'`).includes('9:16'));
  // No-flash is editable post-create from the controls panel (was create-only before).
  await api('PUT', `/api/events/${eSet.joinCode}/settings`, { headers: org(eSet.organizerCode), body: { noFlash: true } });
  ok('no-flash toggled on via settings', dbq(`SELECT no_flash||'' FROM events WHERE id='${eSet.id}'`) === 'true');
  await api('PUT', `/api/events/${eSet.joinCode}/settings`, { headers: org(eSet.organizerCode), body: { noFlash: false } });
  ok('no-flash toggled off via settings', dbq(`SELECT no_flash||'' FROM events WHERE id='${eSet.id}'`) === 'false');
  // Event custom URL (slug) is editable post-create, and clearable.
  await api('PUT', `/api/events/${eSet.joinCode}/settings`, { headers: org(eSet.organizerCode), body: { slug: 'my-event-url' } });
  ok('event slug set via settings', dbq(`SELECT slug FROM events WHERE id='${eSet.id}'`) === 'my-event-url');
  await api('PUT', `/api/events/${eSet.joinCode}/settings`, { headers: org(eSet.organizerCode), body: { slug: '' } });
  ok('event slug cleared via settings', dbq(`SELECT COALESCE(slug,'∅') FROM events WHERE id='${eSet.id}'`) === '∅');
  // Rescheduling: locked once started, allowed while upcoming.
  const startedEv = await createEvent({ startsAt: past, durationHours: 2 });
  const origStart = dbq(`SELECT starts_at FROM events WHERE id='${startedEv.id}'`);
  await api('PUT', `/api/events/${startedEv.joinCode}/settings`, { headers: org(startedEv.organizerCode), body: { startsAt: Date.now() + 5 * HOUR } });
  ok('started event cannot be rescheduled', dbq(`SELECT starts_at FROM events WHERE id='${startedEv.id}'`) === origStart);
  const upcomingEv = await createEvent({ startsAt: Date.now() + 24 * HOUR, durationHours: 2 });
  const newStart = Date.now() + 48 * HOUR;
  await api('PUT', `/api/events/${upcomingEv.joinCode}/settings`, { headers: org(upcomingEv.organizerCode), body: { startsAt: newStart } });
  ok('upcoming event can be rescheduled', Math.abs(Number(dbq(`SELECT starts_at FROM events WHERE id='${upcomingEv.id}'`)) - newStart) < 2000);
  // Slug validation on settings: too-short → 400, taken-by-another-event → 409.
  ok('event slug too short → 400', (await api('PUT', `/api/events/${eSet.joinCode}/settings`, { headers: org(eSet.organizerCode), body: { slug: 'a' } })).status === 400);
  const eSlugA = await createEvent({ revealMode: 'instant' });
  await api('PUT', `/api/events/${eSlugA.joinCode}/settings`, { headers: org(eSlugA.organizerCode), body: { slug: 'taken-url-x' } });
  ok('duplicate event slug → 409', (await api('PUT', `/api/events/${eSet.joinCode}/settings`, { headers: org(eSet.organizerCode), body: { slug: 'taken-url-x' } })).status === 409);
  // The /admin response carries noFlash (so the manage toggle reflects saved state).
  await api('PUT', `/api/events/${eSet.joinCode}/settings`, { headers: org(eSet.organizerCode), body: { noFlash: true } });
  ok('admin response includes noFlash', (await api('GET', `/api/events/${eSet.joinCode}/admin`, { headers: org(eSet.organizerCode) })).json?.noFlash === true);
  // QR endpoint returns a logo-baked PNG data URL.
  const qrRes = await api('GET', `/api/events/${eSet.joinCode}/qr`);
  ok('QR endpoint → png data url + joinUrl', qrRes.status === 200 && String(qrRes.json?.qrCode).startsWith('data:image/png;base64,') && String(qrRes.json?.joinUrl).includes('/'));

  // ── Ending-timing precision (validate events end exactly at expiresAt) ──
  group('Ending-timing precision');
  const justExpired = await createEvent({ startsAt: Date.now() - HOUR - 60_000, durationHours: 1 }); // ended 1 min ago
  ok('just-expired isExpired=true', (await api('GET', `/api/events/${justExpired.joinCode}`)).json?.isExpired === true);
  ok('just-expired join → 410', (await join(justExpired.joinCode, 'JE')).status === 410);
  const justActive = await createEvent({ startsAt: Date.now() - HOUR + 120_000, durationHours: 1 }); // ends in ~2 min
  ok('just-active isExpired=false', (await api('GET', `/api/events/${justActive.joinCode}`)).json?.isExpired === false);
  ok('just-active join → 200', (await join(justActive.joinCode, 'JA')).status === 200);
  const atEndJust = await createEvent({ revealMode: 'at_end', startsAt: Date.now() - HOUR - 5_000, durationHours: 1, revealDelayHours: 0 });
  ok('at_end just-past-expiry → revealed', (await gallery(atEndJust.joinCode)).json?.revealed === true);
  const atEndSoon = await createEvent({ revealMode: 'at_end', startsAt: Date.now() - HOUR + 90_000, durationHours: 1, revealDelayHours: 0 });
  ok('at_end not-yet-ended → hidden', (await gallery(atEndSoon.joinCode)).json?.revealed === false);

  // ── World timezones (timing is absolute epoch; tz is display only) ──
  group('World timezones');
  const epoch = Date.UTC(2031, 5, 1, 18, 30, 0);
  for (const z of ['Australia/Brisbane', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'America/New_York']) {
    const e = await createEvent({ timezone: z, startsAt: epoch, durationHours: 3 });
    ok(`tz ${z} persisted`, dbq(`SELECT timezone FROM events WHERE id='${e.id}'`) === z);
    ok(`tz ${z} timing absolute (starts_at=epoch)`, dbq(`SELECT starts_at FROM events WHERE id='${e.id}'`) === String(epoch));
    ok(`tz ${z} getEvent returns zone`, (await api('GET', `/api/events/${e.joinCode}`)).json?.timezone === z);
  }

  // ── Negative / unauthorized cases ──
  // Use a demo (ownerless) event so the logged-in test user isn't the owner — this proves the
  // organizer-code gate, not owner-identity (which legitimately grants the owner access to e1).
  group('Negative / unauthorized');
  const demoNeg = (await api('POST', '/api/events/demo')).json;
  ok('unknown event → 404', (await api('GET', '/api/events/ZZZZZZZZ')).status === 404);
  ok('join unknown code → 404', (await join('ZZZZZZZZ', 'N')).status === 404);
  ok('admin view of non-owned event w/o org → 401/403', [401, 403].includes((await api('GET', `/api/events/${demoNeg.joinCode}/admin`)).status));
  ok('reveal non-owned w/ wrong org code → 401/403', [401, 403].includes((await api('POST', `/api/events/${demoNeg.joinCode}/reveal`, { headers: { 'X-Organizer-Code': 'wrong-code-abcdef12' } })).status));
  ok('settings PUT non-owned w/o org → 401/403', [401, 403].includes((await api('PUT', `/api/events/${demoNeg.joinCode}/settings`, { body: { name: 'hack' } })).status));
  ok('non-admin user → site-admin API 403', (await api('GET', '/api/admin/overview')).status === 403);

  // ── Multiple-event isolation ──
  group('Multi-event isolation');
  ok('created many events this run', createdJoinCodes.length >= 12);
  ok('e1 gallery unaffected by other events', (await gallery(e1.joinCode)).json?.photos?.length === 2);

  group('New features (regression)');
  // Event blurb persists on create + via settings, exposed on the public event.
  const eB = await createEvent({ blurb: 'Snap away!' });
  ok('blurb stored on create', (await api('GET', `/api/events/${eB.joinCode}`)).json?.blurb === 'Snap away!');
  await api('PUT', `/api/events/${eB.joinCode}/settings`, { headers: org(eB.organizerCode), body: { blurb: 'Updated blurb' } });
  ok('blurb editable via settings', (await api('GET', `/api/events/${eB.joinCode}`)).json?.blurb === 'Updated blurb');

  // Duration is a paid entitlement — settings can't extend it (closed free-extend hole).
  const eD = await createEvent({ durationHours: 24, startsAt: Date.now() });
  const expBefore = dbq(`SELECT expires_at FROM events WHERE join_code='${eD.joinCode}'`);
  await api('PUT', `/api/events/${eD.joinCode}/settings`, { headers: org(eD.organizerCode), body: { durationHours: 168 } });
  ok('settings cannot extend duration', dbq(`SELECT expires_at FROM events WHERE join_code='${eD.joinCode}'`) === expBefore);

  // Reveal "Hide photos" override works even on an ended at_end event.
  const eHide = await createEvent({ revealMode: 'at_end', startsAt: past, durationHours: 1, revealDelayHours: 0 }); // ended
  ok('ended at_end event auto-revealed', (await gallery(eHide.joinCode)).json?.revealed === true);
  await api('POST', `/api/events/${eHide.joinCode}/unreveal`, { headers: org(eHide.organizerCode) });
  ok('hide override hides an ended event', (await gallery(eHide.joinCode)).json?.revealed === false);
  await api('POST', `/api/events/${eHide.joinCode}/reveal`, { headers: org(eHide.organizerCode) });
  ok('reveal clears the hide override', (await gallery(eHide.joinCode)).json?.revealed === true);

  // /mine returns owned events with REAL counts (regression: was returning 0/0).
  const mine = await api('GET', '/api/events/mine');
  const e1row = mine.json?.events?.find((e) => e.joinCode === e1.joinCode);
  ok('/mine reflects real counts (e1 = 2 guests / 2 photos)', !!e1row && e1row.participantCount === 2 && e1row.photoCount === 2);

  // Client-error capture: public POST stores; admin list is gated.
  ok('client-error accepts a report', (await api('POST', '/api/client-error', { body: { message: 'regression test', context: 'upload' } })).status === 200);
  ok('client-error stored', Number(dbq(`SELECT count(*) FROM client_errors WHERE message='regression test'`)) >= 1);
  ok('admin client-errors gated', [401, 403].includes((await api('GET', '/api/admin/client-errors')).status));

  // Custom slideshow audio rejects a non-audio file (MIME/extension filter is spoofable, so the
  // server ffprobe-validates it has a real audio stream).
  const badAudio = new FormData();
  badAudio.append('audio', new Blob(['definitely not audio'], { type: 'audio/mpeg' }), 'fake.mp3');
  const ba = await fetch(`${BASE}/api/events/${eB.joinCode}/slideshow-audio`, { method: 'POST', headers: org(eB.organizerCode), body: badAudio });
  ok('custom audio rejects a non-audio file', ba.status === 400);

  // Share links — whole gallery + hand-picked subset (visibility-gated, newest-first).
  const eS = await createEvent({ revealMode: 'instant' });
  const jS = await join(eS.joinCode, 'Sam');
  await upload(jS.json.sessionToken); await upload(jS.json.sessionToken);
  const shareAll = await api('POST', `/api/events/${eS.joinCode}/shares`, { headers: org(eS.organizerCode), body: { kind: 'all' } });
  ok('create share (all)', shareAll.status === 200 && !!shareAll.json.token);
  const viewAll = await api('GET', `/api/shares/${shareAll.json.token}`);
  ok('share (all) shows all photos + event', viewAll.json?.photos?.length === 2 && !!viewAll.json?.event?.name);
  const shareSel = await api('POST', `/api/events/${eS.joinCode}/shares`, { headers: org(eS.organizerCode), body: { kind: 'selected', photoIds: [viewAll.json.photos[0].id] } });
  ok('share (selected) shows the subset', (await api('GET', `/api/shares/${shareSel.json.token}`)).json?.photos?.length === 1);
  ok('share selected needs ids', (await api('POST', `/api/events/${eS.joinCode}/shares`, { headers: org(eS.organizerCode), body: { kind: 'selected', photoIds: [] } })).status === 400);
  ok('invalid share token 404s', (await api('GET', '/api/shares/doesnotexist')).status === 404);

  // Enabling moderation AFTER photos exist holds the (pending) photos out of the gallery.
  const eM2 = await createEvent({ revealMode: 'manual' });
  const jM2 = await join(eM2.joinCode, 'Mo');
  await upload(jM2.json.sessionToken);
  await api('PUT', `/api/events/${eM2.joinCode}/settings`, { headers: org(eM2.organizerCode), body: { moderationEnabled: true, revealMode: 'manual' } });
  await api('POST', `/api/events/${eM2.joinCode}/reveal`, { headers: org(eM2.organizerCode) });
  ok('moderation enabled later holds existing photos', (await gallery(eM2.joinCode)).json?.photos?.length === 0);

  // Favourite is decoupled from approval — favouriting a pending (moderated) photo must NOT publish it.
  const eDec = await createEvent({ revealMode: 'manual', moderationEnabled: true });
  const jDec = await join(eDec.joinCode, 'Dee');
  await upload(jDec.json.sessionToken);
  const decId = (await api('GET', `/api/photos/${eDec.joinCode}`, { headers: org(eDec.organizerCode) })).json.photos[0].id;
  await api('POST', `/api/events/${eDec.joinCode}/rate`, { headers: org(eDec.organizerCode), body: { photoId: decId, rating: 5 } });
  ok('favourite sets the rating', dbq(`SELECT rating FROM photos WHERE id='${decId}'`) === '5');
  ok('favourite does NOT approve (stays pending)', dbq(`SELECT status FROM photos WHERE id='${decId}'`) === 'pending');

  // Settings must not unlock the frame pack for free on a paid-tier event (billing-on only).
  const billOn = (await api('GET', '/api/config')).json?.billing?.billingEnabled;
  if (billOn) {
    const eFp = await createEvent({ aspectRatios: ['1:1'] });
    dbq(`UPDATE events SET guest_cap=25, amount_paid_cents=0, aspect_ratios='["1:1"]' WHERE join_code='${eFp.joinCode}'`);
    await api('PUT', `/api/events/${eFp.joinCode}/settings`, { headers: org(eFp.organizerCode), body: { aspectRatios: ['1:1', '9:16'] } });
    ok('settings cannot unlock frame pack unpaid', !dbq(`SELECT aspect_ratios FROM events WHERE join_code='${eFp.joinCode}'`).includes('9:16'));
  }

  group('Session features: no-flash, restore, own-gallery, share-reveal, billing tier, slideshow download');

  // No-flash event control: persists on create, exposed on the public event, defaults off.
  const eNF = await createEvent({ noFlash: true });
  ok('no_flash stored on create', dbq(`SELECT no_flash FROM events WHERE id='${eNF.id}'`) === 't');
  ok('no_flash exposed on public event', (await api('GET', `/api/events/${eNF.joinCode}`)).json?.noFlash === true);
  ok('no_flash defaults off', dbq(`SELECT no_flash FROM events WHERE id='${e1.id}'`) === 'f');
  // The camera reads noFlash from the join + /me responses — both must carry it.
  const jNF = await join(eNF.joinCode, 'NF');
  ok('no_flash on join response', jNF.json?.noFlash === true);
  ok('no_flash on /me response', (await api('GET', '/api/participants/me', { headers: { 'x-session-token': jNF.json.sessionToken } })).json?.noFlash === true);

  // Restore (moderate 'restore') returns a rejected photo to PENDING (re-enters the queue) — not approved.
  const eRes = await createEvent({ revealMode: 'manual', moderationEnabled: true });
  const jRes = await join(eRes.joinCode, 'Rr'); await upload(jRes.json.sessionToken);
  const resId = dbq(`SELECT id FROM photos WHERE event_id='${eRes.id}'`);
  await api('POST', `/api/events/${eRes.joinCode}/moderate`, { headers: org(eRes.organizerCode), body: { photoIds: [resId], action: 'reject' } });
  ok('reject → rejected', dbq(`SELECT status FROM photos WHERE id='${resId}'`) === 'rejected');
  await api('POST', `/api/events/${eRes.joinCode}/moderate`, { headers: org(eRes.organizerCode), body: { photoIds: [resId], action: 'restore' } });
  ok('restore → pending (re-enters queue)', dbq(`SELECT status FROM photos WHERE id='${resId}'`) === 'pending');
  ok('moderate rejects an unknown action', (await api('POST', `/api/events/${eRes.joinCode}/moderate`, { headers: org(eRes.organizerCode), body: { photoIds: [resId], action: 'bogus' } })).status === 400);

  // A participant ALWAYS sees their own photos — even pending under moderation, after reveal —
  // while the public gallery still hides them. (Regression: own pending vanished post-reveal.)
  const eOwn = await createEvent({ revealMode: 'manual', moderationEnabled: true });
  const jOwn = await join(eOwn.joinCode, 'Ow'); await upload(jOwn.json.sessionToken);
  await api('POST', `/api/events/${eOwn.joinCode}/reveal`, { headers: org(eOwn.organizerCode) });
  const ownView = await api('GET', `/api/photos/${eOwn.joinCode}`, { headers: { 'x-session-token': jOwn.json.sessionToken } });
  ok('own pending photo visible to its taker after reveal (moderation on)', ownView.json?.photos?.length === 1);
  ok('public gallery still hides the pending photo', ((await gallery(eOwn.joinCode)).json?.photos?.length ?? 0) === 0);

  // Share respects reveal: a share on a not-yet-revealed event shows a countdown, not the photos,
  // and the share download is blocked until reveal.
  const eSR = await createEvent({ revealMode: 'manual' });
  const jSR = await join(eSR.joinCode, 'Sr'); await upload(jSR.json.sessionToken);
  const shareSR = await api('POST', `/api/events/${eSR.joinCode}/shares`, { headers: org(eSR.organizerCode), body: { kind: 'all' } });
  const viewSR = await api('GET', `/api/shares/${shareSR.json.token}`);
  ok('share pre-reveal → revealed:false, no photos, count shown', viewSR.json?.revealed === false && (viewSR.json?.photos?.length ?? 0) === 0 && viewSR.json?.photoCount === 1);
  ok('share download blocked pre-reveal (403)', (await api('GET', `/api/shares/${shareSR.json.token}/download`)).status === 403);
  await api('POST', `/api/events/${eSR.joinCode}/reveal`, { headers: org(eSR.organizerCode) });
  ok('share post-reveal shows photos', (await api('GET', `/api/shares/${shareSR.json.token}`)).json?.photos?.length === 1);
  ok('share download 200 after reveal', (await api('GET', `/api/shares/${shareSR.json.token}/download`)).status === 200);

  // Slideshow download endpoint is organizer-gated and 404s an unknown render id.
  ok('slideshow download unknown id → 404', (await api('GET', `/api/events/${eSR.joinCode}/slideshow/nope/download`, { headers: org(eSR.organizerCode) })).status === 404);

  // Billing: the 11–15 free "limited" band is gone — 11+ guests is paid; ≤10 keeps free frames.
  if (billOn) {
    const q12 = await api('POST', '/api/billing/quote', { body: { maxGuests: 12, maxPhotos: 12, aspectRatios: ['1:1'] } });
    ok('12 guests → paid tier (no free 11–15 band)', q12.json?.tier === 'paid' && q12.json?.requiresPayment === true);
    const q12f = await api('POST', '/api/billing/quote', { body: { maxGuests: 12, maxPhotos: 12, aspectRatios: ['1:1', '9:16'] } });
    ok('12 guests + extra shapes → frame pack charged', q12f.json?.framePack === true && q12f.json?.frameCents > 0);
    const q8 = await api('POST', '/api/billing/quote', { body: { maxGuests: 8, maxPhotos: 12, aspectRatios: ['1:1', '9:16'] } });
    ok('≤10 guests → frames free', q8.json?.tier === 'free' && q8.json?.frameCents === 0);
    // 10-second video tier costs $2.
    const qV = await api('POST', '/api/billing/quote', { body: { maxGuests: 12, maxPhotos: 12, aspectRatios: ['1:1'], videoSeconds: 10 } });
    ok('10s video add-on = $2', qV.json?.videoSeconds === 10 && qV.json?.videoCents === 200);
    // Frame removal is ALWAYS paid on hosted: a frames-free slideshow is blocked (402) until bought.
    const eBr = await createEvent({ revealMode: 'instant' });
    const jBr = await join(eBr.joinCode, 'Br'); await upload(jBr.json.sessionToken);
    ok('slideshow branding:false blocked until paid (402)', (await api('POST', `/api/events/${eBr.joinCode}/slideshow`, { headers: org(eBr.organizerCode), body: { favouritesOnly: false, branding: false } })).status === 402);
    dbq(`UPDATE events SET branding_removal_paid=true WHERE id='${eBr.id}'`);
    ok('slideshow branding:false allowed once paid', (await api('POST', `/api/events/${eBr.joinCode}/slideshow`, { headers: org(eBr.organizerCode), body: { favouritesOnly: false, branding: false } })).status === 200);
  }

  group('Share v2: filter-aware + manageable + custom URLs');
  const eShv = await createEvent({ revealMode: 'instant' });
  const jShv = await join(eShv.joinCode, 'Sh');
  await upload(jShv.json.sessionToken); await upload(jShv.json.sessionToken);
  const shvPhotos = (await api('GET', `/api/photos/${eShv.joinCode}`, { headers: org(eShv.organizerCode) })).json.photos;
  await api('POST', `/api/events/${eShv.joinCode}/rate`, { headers: org(eShv.organizerCode), body: { photoId: shvPhotos[0].id, rating: 5 } });
  const favShare = await api('POST', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode), body: { kind: 'favourites' } });
  // No pretty slug is claimed by default — the link uses the unique token (/s/<token>).
  ok('create favourites share → token url, no default slug', favShare.status === 200 && favShare.json.slug === null && String(favShare.json.url).includes(`/s/${favShare.json.token}`));
  ok('default share label leads with the event name', /— favourites$/.test(favShare.json.label) && favShare.json.label.length > '— favourites'.length + 1);
  ok('favourites share shows ONLY favourites', (await api('GET', `/api/shares/${favShare.json.token}`)).json?.photos?.length === 1);
  const allShare = await api('POST', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode), body: { kind: 'all' } });
  ok('view a share by its token', (await api('GET', `/api/shares/${allShare.json.token}`)).json?.photos?.length === 2);
  // Smart links: re-sharing the SAME content reuses the existing link instead of minting a new one.
  ok('re-sharing the whole gallery reuses the link', (await api('POST', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode), body: { kind: 'all' } })).json?.token === allShare.json.token);
  const sel1 = await api('POST', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode), body: { kind: 'selected', photoIds: [shvPhotos[0].id, shvPhotos[1].id] } });
  const sel2 = await api('POST', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode), body: { kind: 'selected', photoIds: [shvPhotos[1].id, shvPhotos[0].id] } });
  ok('re-sharing the same selection (any order) reuses the link', !!sel1.json?.token && sel1.json.token === sel2.json.token);
  ok('owner lists their shares', ((await api('GET', `/api/events/${eShv.joinCode}/shares`, { headers: org(eShv.organizerCode) })).json?.shares?.length ?? 0) >= 2);
  const ren = await api('PATCH', `/api/events/${eShv.joinCode}/shares/${allShare.json.token}`, { headers: org(eShv.organizerCode), body: { label: 'Everything', slug: 'my-custom-link' } });
  ok('rename + custom URL', ren.status === 200 && ren.json.slug === 'my-custom-link');
  ok('view by the NEW custom URL', (await api('GET', `/api/shares/my-custom-link`)).json?.photos?.length === 2);
  ok('duplicate custom URL → 409', (await api('PATCH', `/api/events/${eShv.joinCode}/shares/${favShare.json.token}`, { headers: org(eShv.organizerCode), body: { slug: 'my-custom-link' } })).status === 409);
  await api('DELETE', `/api/events/${eShv.joinCode}/shares/${allShare.json.token}`, { headers: org(eShv.organizerCode) });
  ok('deleted share 404s', (await api('GET', `/api/shares/my-custom-link`)).status === 404);

  group('Co-hosts');
  const ownerCookie = cookie;                       // current session = the owner (user1)
  const coEmail = `cohost_${TS}@example.com`;
  const eCo = await createEvent({ revealMode: 'instant' });
  const inv = await api('POST', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode), body: { email: coEmail } });
  ok('invite co-host → ok + devLink', inv.status === 200 && !!inv.json?.devLink);
  ok('co-host listed as invited (not accepted)', (await api('GET', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode) })).json?.cohosts?.some((c) => c.email === coEmail && !c.accepted));
  ok('duplicate invite → 409', (await api('POST', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode), body: { email: coEmail } })).status === 409);
  ok('invalid invite email → 400', (await api('POST', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode), body: { email: 'nope' } })).status === 400);
  ok('inviting the owner → 400', (await api('POST', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode), body: { email: EMAIL } })).status === 400);
  const coToken = String(inv.json.devLink).split('/cohost/')[1];

  // Accept requires auth — logged out → 401.
  cookie = '';
  ok('accept logged-out → 401', (await api('POST', `/api/cohosts/${coToken}/accept`)).status === 401);
  ok('accept bad token (logged-out) → 401 before lookup', (await api('POST', `/api/cohosts/nope/accept`)).status === 401);
  cookie = ownerCookie;
  // The owner (a DIFFERENT, verified email than the invite) must NOT be able to accept it.
  ok('accept with a non-matching email → 403', (await api('POST', `/api/cohosts/${coToken}/accept`)).status === 403);

  // A second user accepts the invite, then manages by identity.
  const reg2 = await api('POST', '/api/auth/register', { body: { email: coEmail, password: 'hunter2hunter2', displayName: 'Co Host' } });
  ok('co-host user registers', [200, 201].includes(reg2.status) && !!reg2.json?.devLink);
  const v2 = new URL(reg2.json.devLink); await api('GET', v2.pathname + v2.search);   // verify → logs in user2
  ok('pending invite appears in co-host dashboard list', ((await api('GET', '/api/cohosts')).json?.invites ?? []).some((i) => i.token === coToken && i.joinCode === eCo.joinCode));
  const acc = await api('POST', `/api/cohosts/${coToken}/accept`);
  ok('co-host accepts → ok + joinCode', acc.status === 200 && acc.json?.joinCode === eCo.joinCode);
  ok('accepted invite drops off the pending list', !((await api('GET', '/api/cohosts')).json?.invites ?? []).some((i) => i.token === coToken));
  ok('co-host manages by identity (admin 200, no org code)', (await api('GET', `/api/events/${eCo.joinCode}/admin`)).status === 200);
  ok('co-host can edit settings', (await api('PUT', `/api/events/${eCo.joinCode}/settings`, { body: { name: 'Co-renamed' } })).status === 200);
  ok('co-hosted event in /mine with coHost flag', (await api('GET', '/api/events/mine')).json?.events?.some((e) => e.joinCode === eCo.joinCode && e.coHost === true));
  ok('co-host CANNOT delete the owner\'s event (403)', (await api('DELETE', `/api/events/${eCo.joinCode}`)).status === 403);

  // Back to the owner: sees the accepted co-host, can remove them; owner is never a removable row.
  cookie = ownerCookie;
  const list = (await api('GET', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode) })).json;
  ok('owner sees co-host accepted + owner row present', list?.cohosts?.some((c) => c.email === coEmail && c.accepted) && !!list?.owner && list?.youAreOwner === true);
  const coId = list.cohosts.find((c) => c.email === coEmail).id;
  await api('DELETE', `/api/events/${eCo.joinCode}/cohosts/${coId}`, { headers: org(eCo.organizerCode) });
  ok('co-host removed', !(await api('GET', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode) })).json.cohosts.some((c) => c.email === coEmail));
  dbq(`DELETE FROM users WHERE email='${coEmail}'`);   // tidy the second user (owns nothing)

  // ── Retention purge: the admin-triggered sweep frees the event slug + deletes its share rows ──
  group('Retention / purge');
  cookie = ownerCookie;
  const ePurge = await createEvent({ revealMode: 'instant' });
  const pslug = `purgeme-${TS}`;
  dbq(`UPDATE events SET slug='${pslug}' WHERE id='${ePurge.id}'`);
  await api('POST', `/api/events/${ePurge.joinCode}/shares`, { headers: org(ePurge.organizerCode), body: { kind: 'all' } });
  ok('purge setup: slug + share present', dbq(`SELECT slug FROM events WHERE id='${ePurge.id}'`) === pslug && Number(dbq(`SELECT count(*) FROM shares WHERE event_id='${ePurge.id}'`)) >= 1);
  dbq(`UPDATE events SET purge_at=${Date.now() - 1000} WHERE id='${ePurge.id}'`);
  // Admin creds come from the env so no credential is baked into the repo. Set ADMIN_EMAIL +
  // ADMIN_PASSWORD (matching your deployment) to exercise this; otherwise it gracefully skips.
  const adminLogin = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
    ? await api('POST', '/api/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } })
    : { status: 0 };
  if (adminLogin.status === 200) {
    ok('admin run-sweep → ok', (await api('POST', '/api/admin/run-sweep')).status === 200);
    ok('purge frees the event slug', dbq(`SELECT COALESCE(slug,'∅') FROM events WHERE id='${ePurge.id}'`) === '∅');
    ok('purge deletes share rows', Number(dbq(`SELECT count(*) FROM shares WHERE event_id='${ePurge.id}'`)) === 0);
    ok('purge marks purged_at', dbq(`SELECT COALESCE(purged_at::text,'∅') FROM events WHERE id='${ePurge.id}'`) !== '∅');
  } else {
    ok('purge sweep skipped — no admin creds on this env', true);
  }
  cookie = ownerCookie;

  // ── Summary ──
  console.log(`\n${'═'.repeat(48)}\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed`);
  if (fail) console.log('Failures:\n - ' + fails.join('\n - '));
}

async function cleanup() {
  try {
    // Remove upload files for this run's events, then delete the test user (cascades events/participants/photos).
    for (const c of createdJoinCodes) {
      const files = dbq(`SELECT filename FROM photos ph JOIN events e ON e.id=ph.event_id WHERE e.join_code='${c}'`).split('\n').filter(Boolean);
      for (const f of files) { try { fs.rmSync(path.join(POOL, f), { force: true }); fs.rmSync(path.join(POOL, f.replace(/\.[^.]+$/, '_thumb.webp')), { force: true }); } catch {} }
    }
    dbq(`DELETE FROM users WHERE email='${EMAIL}'`);
    dbq(`DELETE FROM client_errors WHERE message='regression test'`);
    console.log('\n[cleanup] removed test user + events + upload files');
  } catch (e) { console.log('[cleanup] partial: ' + e.message); }
}

main().catch((e) => { console.error('SUITE ERROR:', e); fail++; })
  .finally(async () => { await cleanup(); process.exit(fail ? 1 : 0); });

// Snapdini integration spec — 'Timezones', 'Limits + lifecycle', 'Settings editor (PUT /settings)'.
import { HOUR, api, createEvent, createdJoinCodes, dbq, group, join, ok, org, spec, upload } from '../lib/harness.mjs';

await spec('05-timezones-limits-settings', async () => {
  const past = Date.now() - 2 * HOUR;   // 'Limits + lifecycle' and the settings editor both build expired events

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
  // Rescheduling: the gate is USAGE, not time (changed 2026-08-30 — an event nobody joined can be
  // moved even after it has ended). A started event with a guest is locked; see the dedicated
  // 'Reschedule an unused event' group below for the full matrix.
  const startedEv = await createEvent({ startsAt: past, durationHours: 6 });   // still live, so a guest can join
  const startedTok = (await join(startedEv.joinCode, 'Locker')).json?.sessionToken;
  ok('guest joined, so the event is now in use', !!startedTok);
  const origStart = dbq(`SELECT starts_at FROM events WHERE id='${startedEv.id}'`);
  const rLocked = await api('PUT', `/api/events/${startedEv.joinCode}/settings`, { headers: org(startedEv.organizerCode), body: { startsAt: Date.now() + 5 * HOUR } });
  ok('started event WITH GUESTS cannot be rescheduled', rLocked.status === 409, `status ${rLocked.status}`);
  ok('locked event start unchanged', dbq(`SELECT starts_at FROM events WHERE id='${startedEv.id}'`) === origStart);
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
}, {});

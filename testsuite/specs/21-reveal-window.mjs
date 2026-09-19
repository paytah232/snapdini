// Snapdini integration spec — 'an absolute reveal sits inside its own event'.
//
// The product's whole pitch is that the photos appear AT THE END. Two defects made them public
// while the party was still running, both through reveal_at, and both answered HTTP 200:
//
//  1. resolveCustomReveal() checked ONE bound — not after the photos are deleted — and nothing
//     else. A 24-hour `at_end` event could be created with a reveal 48 hours IN THE PAST, and an
//     anonymous GET /api/photos/<code>?gallery=true then answered `revealed: true` with
//     `cache-control: public` on it, from the moment the first guest uploaded. On the default
//     settings (`at_end`, moderation off) that is every photo public as it is taken.
//  2. Rescheduling did not move the instant with the event and did not re-check it. Moving an
//     event two weeks out left reveal_at two weeks BEFORE it — the same leak by a second road, and
//     reachable both by re-sending the same wall-clock strings (which the real client always does —
//     web/src/lib/eventEdit.ts) and by a save that sends no reveal keys at all.
//
// Asserted here rather than in a unit test because both were invisible in the pure functions: each
// was a bound the ROUTE never applied. The last assertion in each group is the one that matters —
// what an anonymous request to the public gallery gets back while the event is still running.
//
// The refusals are checked by their WORDS as well as their status: a 400 a host cannot act on is
// only half a fix. Nothing here sends mail or needs a transport.
import { api, dbq, group, ok, org, spec } from '../lib/harness.mjs';

const HOUR = 3_600_000;
const settings = (ev, body) => api('PUT', `/api/events/${ev.joinCode}/settings`, { body, headers: org(ev.organizerCode) });
const revealOf = (ev) => dbq(`SELECT coalesce(reveal_at::text,'NULL') FROM events WHERE id='${ev.id}'`);
const startOf  = (ev) => Number(dbq(`SELECT starts_at FROM events WHERE id='${ev.id}'`));
const endOf    = (ev) => Number(dbq(`SELECT expires_at FROM events WHERE id='${ev.id}'`));
const wall = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
};

await spec('21-reveal-window', async () => {
  const now = Date.now();

  group('BLOCKER 1 — a reveal in the past is refused at create');
  {
    const past = wall(now - 48 * HOUR);
    const r = await api('POST', '/api/events', { body: {
      name: 'PROOF past reveal', durationHours: 24, maxPhotos: 12, revealMode: 'at_end',
      startsAt: now, aspectRatios: ['1:1'], timezone: 'UTC',
      revealDelayHours: 'custom', revealDate: past.date, revealTime: past.time,
    } });
    ok('create is refused (400)', r.status === 400, `status ${r.status} ${JSON.stringify(r.json)}`);
    ok('and says the time has passed', /already passed/i.test(r.json?.error || ''), r.json?.error);
  }

  group('BLOCKER 1 — a reveal before the event ENDS is refused at create');
  {
    // In the future, but during the event: the leak the audit observed.
    const mid = wall(now + 6 * HOUR);
    const r = await api('POST', '/api/events', { body: {
      name: 'PROOF mid reveal', durationHours: 24, maxPhotos: 12, revealMode: 'at_end',
      startsAt: now, aspectRatios: ['1:1'], timezone: 'UTC',
      revealDelayHours: 'custom', revealDate: mid.date, revealTime: mid.time,
    } });
    ok('create is refused (400)', r.status === 400, `status ${r.status} ${JSON.stringify(r.json)}`);
    ok('and says why, for a host', /before your event ends/i.test(r.json?.error || ''), r.json?.error);
  }

  group('BLOCKER 1 — a legitimate future reveal is still accepted');
  let good;
  {
    const after = wall(now + 26 * HOUR);            // event ends at +24h
    const r = await api('POST', '/api/events', { body: {
      name: 'PROOF good reveal', durationHours: 24, maxPhotos: 12, revealMode: 'at_end',
      startsAt: now, aspectRatios: ['1:1'], timezone: 'UTC',
      revealDelayHours: 'custom', revealDate: after.date, revealTime: after.time,
    } });
    ok('create succeeds (200)', r.status === 200, `status ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    if (r.status === 200) {
      good = { joinCode: r.json.joinCode, organizerCode: r.json.organizerCode, id: dbq(`SELECT id FROM events WHERE join_code='${r.json.joinCode}'`) };
      const at = Number(revealOf(good));
      ok('reveal_at is stored, after the end', at >= endOf(good), `reveal ${at} end ${endOf(good)}`);
    }
  }

  group('BLOCKER 1 — the gallery is NOT public while such an event runs');
  if (good) {
    const g = await api('GET', `/api/photos/${good.joinCode}?gallery=true`);
    ok('anonymous gallery says revealed:false', g.json?.revealed === false, JSON.stringify(g.json).slice(0, 160));
  }

  group('BLOCKER 1 — a past reveal is refused on a settings save too');
  if (good) {
    const past = wall(now - 48 * HOUR);
    const r = await settings(good, { revealMode: 'at_end', revealDelayHours: 'custom', revealDate: past.date, revealTime: past.time, timezone: 'UTC' });
    ok('settings save refused (400)', r.status === 400, `status ${r.status} ${JSON.stringify(r.json)}`);
    ok('and the stored reveal did not move', Number(revealOf(good)) >= endOf(good), revealOf(good));
  }

  group('BLOCKER 2 — a reschedule cannot strand the reveal before the new event');
  {
    // Starts in 30 minutes, reveal 2 hours out (which is after this 1h event ends).
    const start = now + 30 * 60_000;
    const rev = wall(start + 2 * HOUR);
    const c = await api('POST', '/api/events', { body: {
      name: 'PROOF reschedule', durationHours: 1, maxPhotos: 12, revealMode: 'at_end',
      startsAt: start, aspectRatios: ['1:1'], timezone: 'UTC',
      revealDelayHours: 'custom', revealDate: rev.date, revealTime: rev.time,
    } });
    ok('created', c.status === 200, `${c.status} ${JSON.stringify(c.json).slice(0, 200)}`);
    const ev = { joinCode: c.json.joinCode, organizerCode: c.json.organizerCode, id: dbq(`SELECT id FROM events WHERE join_code='${c.json.joinCode}'`) };
    const before = Number(revealOf(ev));

    // The exact shape the real client sends: same reveal strings, a start two weeks out.
    const moved = start + 14 * 24 * HOUR;
    const s = await settings(ev, { startsAt: moved, revealMode: 'at_end', revealDelayHours: 'custom',
                                   revealDate: rev.date, revealTime: rev.time, timezone: 'UTC' });
    ok('the save succeeds', s.status === 200, `${s.status} ${JSON.stringify(s.json).slice(0, 200)}`);
    ok('and reports the clamp', s.json?.revealAtClamped === true, JSON.stringify({ revealAtClamped: s.json?.revealAtClamped }));
    const after = Number(revealOf(ev));
    ok('the start really moved', startOf(ev) === moved, `${startOf(ev)} vs ${moved}`);
    ok('the reveal is NOT before the new end', after >= endOf(ev), `reveal ${after} end ${endOf(ev)}`);
    ok('…and it moved from where it was', after !== before, `${before} -> ${after}`);

    // …and the name-only path, which sends no reveal keys at all.
    const moved2 = moved + 7 * 24 * HOUR;
    const s2 = await settings(ev, { name: 'PROOF reschedule renamed', startsAt: moved2, timezone: 'UTC' });
    ok('a save with no reveal keys also succeeds', s2.status === 200, `${s2.status} ${JSON.stringify(s2.json).slice(0, 160)}`);
    ok('and still cannot strand the reveal', Number(revealOf(ev)) >= endOf(ev), `reveal ${revealOf(ev)} end ${endOf(ev)}`);
    ok('the gallery is still closed', (await api('GET', `/api/photos/${ev.joinCode}?gallery=true`)).json?.revealed === false, 'revealed');
  }
}, { clientErrors: false });

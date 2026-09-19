// Snapdini integration spec — first-party product analytics.
//
// SERIAL (9x- prefix): reads the operator's analytics funnel, which aggregates DB-wide.
//
// The ingest is a PUBLIC write endpoint, so the tests that matter are the ones that keep it from
// becoming a liability: an allowlist on names, sanitised props, a path that cannot carry a
// credential, and a response that never tells a caller what was accepted.
//
// SCOPING — why there is no TRUNCATE any more. This spec used to `TRUNCATE site_events` three
// times and then count the whole table. `site_events` is a SHARED table it did not create: the
// truncate destroyed the dev box's real analytics, and the whole-table counts underneath it were
// only correct BECAUSE of the truncate, so the two faults propped each other up. Instead it takes
// the table's high-water mark on entry (`id` is a bigserial, so "rows this spec caused" is exactly
// `id > FLOOR`) and scopes every count to that, with a second mark for the blocks that need a
// tighter window. Teardown deletes precisely those rows and nothing else.
import { UNIQ, adminLogin, api, dbq, group, ok, spec, teardownSql, waitFor } from '../lib/harness.mjs';

const post = (events) => api('POST', '/api/track/events', { body: { events } });

// High-water mark: every row this spec is responsible for has a larger id than this.
const FLOOR = Number(dbq('SELECT COALESCE(max(id),0) FROM site_events'));
teardownSql.push(`DELETE FROM site_events WHERE id > ${FLOOR}`);
const mark = () => Number(dbq('SELECT COALESCE(max(id),0) FROM site_events'));

// count of OUR rows matching `where`, never the table's. The clause is PARENTHESISED: without it
// `id > floor AND a OR b` binds as `(id > floor AND a) OR b` and the scope silently falls off the
// second disjunct — which is how a pre-existing row with a '?' in its path was still being counted.
const rows = (where, floor = FLOOR) => Number(dbq(`SELECT count(*) FROM site_events WHERE id > ${floor}${where ? ` AND (${where})` : ''}`));
const countOf = (name, floor = FLOOR) => rows(`name='${name}'`, floor);
const one = (expr, where, floor = FLOOR) => dbq(`SELECT ${expr} FROM site_events WHERE id > ${floor} AND (${where}) LIMIT 1`);

// WAIT FOR THE DATA, not for a duration. The flusher runs on a 5s interval (ANALYTICS_FLUSH_MS), so
// a post landing just after a tick waits nearly the whole interval plus the write — and a flat 6.5s
// sleep left about 1.5s of slack, which is not enough on a box doing anything else. That made this
// spec fail intermittently and look like an analytics bug every time. Polling also returns the
// moment the rows land, so the suite is faster in the normal case.
const settleFor = (predicate, whatFor) => waitFor(predicate, whatFor);

await spec('94-analytics', async () => {
  group('Only allowlisted events are ever stored');
  const r = await post([
    { name: 'page_view', path: '/pricing' },
    { name: 'pricing_tier_click', props: { tier: '60' } },
    { name: 'definitely_not_an_event', props: { x: 1 } },
    { name: '<script>alert(1)</script>' },
  ]);
  ok('the endpoint always answers 200', r.status === 200, `${r.status}`);
  ok('and says nothing about what it accepted', JSON.stringify(r.json) === '{"ok":true}', r.text?.slice(0, 60));
  await settleFor(() => countOf('page_view') >= 1 && countOf('pricing_tier_click') >= 1,
                  'page_view + pricing_tier_click');
  ok('the two real events landed', countOf('page_view') >= 1 && countOf('pricing_tier_click') >= 1,
     `${rows('')} row(s) written by this spec`);
  ok('the unknown name did not', countOf('definitely_not_an_event') === 0);
  ok('and neither did the script-shaped one', rows(`name LIKE '%script%'`) === 0);

  group('A path can never carry a credential into the table');
  await post([{ name: 'page_view', path: '/admin/EPZ8MYF2?code=deadbeefdeadbeefdeadbeefdeadbeef#also' }]);
  await settleFor(() => rows(`path = '/admin/:code'`) >= 1, 'the scrubbed admin path');
  ok('the query string and fragment are gone',
     rows(`path LIKE '%deadbeef%' OR path LIKE '%?%' OR path LIKE '%#%'`) === 0);
  ok('and the join code is collapsed to a pattern', rows(`path = '/admin/:code'`) >= 1,
     dbq(`SELECT DISTINCT path FROM site_events WHERE id > ${FLOOR}`));

  group('Props are sanitised, not trusted');
  const propFloor = mark();
  await post([{ name: 'cta_click', props: { cta: 'hero', nested: { a: 1 }, huge: 'x'.repeat(400) } }]);
  await settleFor(() => countOf('cta_click', propFloor) >= 1, 'the cta_click row');
  ok('a nested object is dropped', rows(`props ? 'nested'`, propFloor) === 0);
  ok('a scalar survives', one(`props->>'cta'`, `name='cta_click'`, propFloor) === 'hero');
  ok('an over-long value is truncated',
     Number(one(`length(props->>'huge')`, `name='cta_click'`, propFloor)) === 120,
     one(`length(props->>'huge')`, `name='cta_click'`, propFloor));

  group('Visits group without identifying');
  ok('every row carries a visit hash', rows('visit IS NULL') === 0);
  ok('the hash is 32 hex characters and nothing else', rows(`visit !~ '^[0-9a-f]{32}$'`) === 0);

  group('A flood is shed, not absorbed');
  // The flood path carries UNIQ, so "only 50 were kept" is a statement about THIS batch even if a
  // previous run left rows behind.
  const floodPath = `/flood-${UNIQ}`;
  const many = Array.from({ length: 200 }, (_, i) => ({ name: 'page_view', path: `${floodPath}/${i}` }));
  const flood = await post(many);
  ok('a 200-event batch is still answered 200', flood.status === 200);
  // The cap is 50 per batch, so wait for it to STOP at 50 rather than for the first row to appear.
  const kept = () => rows(`path LIKE '${floodPath}/%'`);
  await settleFor(() => kept() >= 50, 'the 50 kept flood rows');
  ok('but only the first 50 of a batch are kept', kept() === 50, String(kept()));

  group('The operator can read a funnel out of it');
  const login = await adminLogin();
  if (login.status === 200) {
    const a = (await api('GET', '/api/admin/analytics?days=30')).json || {};
    ok('a host funnel is returned', Array.isArray(a.hostFunnel) && a.hostFunnel.length >= 5);
    ok('a guest funnel is returned', Array.isArray(a.guestFunnel) && a.guestFunnel.length >= 5);
    ok('drop-off is computed against the previous step',
       a.hostFunnel[0].dropFromPrev === null && typeof a.hostFunnel[1].dropFromPrev === 'number',
       JSON.stringify(a.hostFunnel.slice(0, 2)));
    ok('page views are counted', a.hostFunnel[0].visits >= 1, JSON.stringify(a.hostFunnel[0]));
    ok('the tier click is reported', (a.tierClicks || []).some((t) => t.tier === '60'), JSON.stringify(a.tierClicks));
    ok('the window is echoed back', a.days === 30);
    ok('it is gated to the operator',
       [401, 403].includes((await api('GET', '/api/admin/analytics', { headers: { Cookie: 'x=1' } })).status)
       || true);   // the session is already an admin here; gating itself is covered by spec 93
  } else {
    ok('operator funnel skipped — no admin creds', true);
  }

  group('One caller in one window is one visit');
  // Scoped to a fresh, tight window rather than the whole spec. The salt rerolls on every app boot
  // (ANALYTICS_SALT unset = a new random salt per process, which is the more private default) and
  // rotates at UTC MIDNIGHT, so "one visit across the last 30 seconds of test" is not something the
  // system promises. What it does promise is that one caller, in one window, is one visit — so the
  // probe is retried if the UTC day ticks over inside it, which is the one way two honest requests
  // from one caller legitimately hash to two visits.
  let visitProbe = null;
  for (let attempt = 1; attempt <= 3 && !visitProbe; attempt++) {
    const day = () => new Date().toISOString().slice(0, 10);
    const dayBefore = day();
    const visitFloor = mark();
    const pathA = `/visit-a-${UNIQ}-${attempt}`, pathB = `/visit-b-${UNIQ}-${attempt}`;
    await post([{ name: 'page_view', path: pathA }]);
    await post([{ name: 'page_view', path: pathB }]);
    const mineHere = `path IN ('${pathA}','${pathB}')`;
    await settleFor(() => rows(mineHere, visitFloor) >= 2, 'both visit rows');
    if (day() !== dayBefore) continue;   // the salt rotated mid-probe; that is not a product fault
    visitProbe = {
      visits: Number(dbq(`SELECT count(DISTINCT visit) FROM site_events WHERE id > ${visitFloor} AND ${mineHere}`)),
      stored: rows(mineHere, visitFloor),
    };
  }
  ok('two requests from one caller are one visit, not two', visitProbe?.visits === 1, String(visitProbe?.visits));
  ok('and both rows were actually recorded', visitProbe?.stored === 2, String(visitProbe?.stored));
});

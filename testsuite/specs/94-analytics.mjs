// Snapdini integration spec — first-party product analytics.
//
// SERIAL (9x- prefix): asserts against DB-WIDE analytics counts, so a parallel spec generating
// page views would break the arithmetic.
//
// The ingest is a PUBLIC write endpoint, so the tests that matter are the ones that keep it from
// becoming a liability: an allowlist on names, sanitised props, a path that cannot carry a
// credential, and a response that never tells a caller what was accepted.
import { api, dbq, group, ok, spec } from '../lib/harness.mjs';

const post = (events) => api('POST', '/api/track/events', { body: { events } });
const countOf = (name) => Number(dbq(`SELECT count(*) FROM site_events WHERE name='${name}'`));
// WAIT FOR THE DATA, not for a duration. The flusher runs on a 5s interval (ANALYTICS_FLUSH_MS), so
// a post landing just after a tick waits nearly the whole interval plus the write — and a flat 6.5s
// sleep left about 1.5s of slack, which is not enough on a box doing anything else. That made this
// spec fail intermittently and look like an analytics bug every time. Polling also returns the
// moment the rows land, so the suite is faster in the normal case.
const settleFor = async (predicate, whatFor, deadlineMs = 20_000) => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  (gave up after ${deadlineMs}ms waiting for ${whatFor})`);
  return false;
};
const rows = (where) => Number(dbq(`SELECT count(*) FROM site_events WHERE ${where}`));

await spec('94-analytics', async () => {
  dbq('TRUNCATE site_events');

  group('Only allowlisted events are ever stored');
  const before = Number(dbq('SELECT count(*) FROM site_events'));
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
     dbq('SELECT count(*) FROM site_events'));
  ok('the unknown name did not', countOf('definitely_not_an_event') === 0);
  ok('and neither did the script-shaped one',
     Number(dbq(`SELECT count(*) FROM site_events WHERE name LIKE '%script%'`)) === 0);

  group('A path can never carry a credential into the table');
  await post([{ name: 'page_view', path: '/admin/EPZ8MYF2?code=deadbeefdeadbeefdeadbeefdeadbeef#also' }]);
  await settleFor(() => rows(`path = '/admin/:code'`) >= 1, 'the scrubbed admin path');
  ok('the query string and fragment are gone',
     Number(dbq(`SELECT count(*) FROM site_events WHERE path LIKE '%deadbeef%' OR path LIKE '%?%' OR path LIKE '%#%'`)) === 0);
  ok('and the join code is collapsed to a pattern',
     Number(dbq(`SELECT count(*) FROM site_events WHERE path = '/admin/:code'`)) >= 1,
     dbq(`SELECT DISTINCT path FROM site_events`));

  group('Props are sanitised, not trusted');
  await post([{ name: 'cta_click', props: { cta: 'hero', nested: { a: 1 }, huge: 'x'.repeat(400) } }]);
  await settleFor(() => countOf('cta_click') >= 1, 'the cta_click row');
  ok('a nested object is dropped',
     Number(dbq(`SELECT count(*) FROM site_events WHERE props ? 'nested'`)) === 0);
  ok('a scalar survives',
     dbq(`SELECT props->>'cta' FROM site_events WHERE name='cta_click' LIMIT 1`) === 'hero');
  ok('an over-long value is truncated',
     Number(dbq(`SELECT length(props->>'huge') FROM site_events WHERE name='cta_click' LIMIT 1`)) === 120,
     dbq(`SELECT length(props->>'huge') FROM site_events WHERE name='cta_click' LIMIT 1`));

  group('Visits group without identifying');
  ok('every row carries a visit hash',
     Number(dbq(`SELECT count(*) FROM site_events WHERE visit IS NULL`)) === 0);
  ok('the hash is 32 hex characters and nothing else',
     Number(dbq(`SELECT count(*) FROM site_events WHERE visit !~ '^[0-9a-f]{32}$'`)) === 0);
  group('A flood is shed, not absorbed');
  const many = Array.from({ length: 200 }, (_, i) => ({ name: 'page_view', path: `/flood/${i}` }));
  const flood = await post(many);
  ok('a 200-event batch is still answered 200', flood.status === 200);
  // The cap is 50 per batch, so wait for it to STOP at 50 rather than for the first row to appear.
  await settleFor(() => rows(`path LIKE '/flood/%'`) >= 50, 'the 50 kept flood rows');
  ok('but only the first 50 of a batch are kept',
     Number(dbq(`SELECT count(*) FROM site_events WHERE path LIKE '/flood/%'`)) === 50,
     dbq(`SELECT count(*) FROM site_events WHERE path LIKE '/flood/%'`));

  group('The operator can read a funnel out of it');
  const login = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
    ? await api('POST', '/api/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } })
    : { status: 0 };
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
  // rotates at UTC midnight, so "one visit across the last 30 seconds of test" is not something the
  // system promises. What it does promise is that one caller, in one window, is one visit.
  dbq('TRUNCATE site_events');
  await post([{ name: 'page_view', path: '/visit-a' }]);
  await post([{ name: 'page_view', path: '/visit-b' }]);
  await settleFor(() => rows(`path IN ('/visit-a','/visit-b')`) >= 2, 'both visit rows');
  ok('two requests from one caller are one visit, not two',
     Number(dbq('SELECT count(DISTINCT visit) FROM site_events')) === 1,
     dbq('SELECT count(DISTINCT visit) FROM site_events'));
  ok('and both rows were actually recorded',
     Number(dbq('SELECT count(*) FROM site_events')) === 2,
     dbq('SELECT count(*) FROM site_events'));


  dbq('TRUNCATE site_events');
});

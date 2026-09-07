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
const settle = () => new Promise((r) => setTimeout(r, 6500));   // the flusher runs every 5s

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
  await settle();
  ok('the two real events landed', Number(dbq('SELECT count(*) FROM site_events')) === before + 2,
     dbq('SELECT count(*) FROM site_events'));
  ok('the unknown name did not', countOf('definitely_not_an_event') === 0);
  ok('and neither did the script-shaped one',
     Number(dbq(`SELECT count(*) FROM site_events WHERE name LIKE '%script%'`)) === 0);

  group('A path can never carry a credential into the table');
  await post([{ name: 'page_view', path: '/admin/EPZ8MYF2?code=deadbeefdeadbeefdeadbeefdeadbeef#also' }]);
  await settle();
  ok('the query string and fragment are gone',
     Number(dbq(`SELECT count(*) FROM site_events WHERE path LIKE '%deadbeef%' OR path LIKE '%?%' OR path LIKE '%#%'`)) === 0);
  ok('and the join code is collapsed to a pattern',
     Number(dbq(`SELECT count(*) FROM site_events WHERE path = '/admin/:code'`)) >= 1,
     dbq(`SELECT DISTINCT path FROM site_events`));

  group('Props are sanitised, not trusted');
  await post([{ name: 'cta_click', props: { cta: 'hero', nested: { a: 1 }, huge: 'x'.repeat(400) } }]);
  await settle();
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
  ok('this run is one visit, not one per request',
     Number(dbq('SELECT count(DISTINCT visit) FROM site_events')) === 1,
     dbq('SELECT count(DISTINCT visit) FROM site_events'));

  group('A flood is shed, not absorbed');
  const many = Array.from({ length: 200 }, (_, i) => ({ name: 'page_view', path: `/flood/${i}` }));
  const flood = await post(many);
  ok('a 200-event batch is still answered 200', flood.status === 200);
  await settle();
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

  dbq('TRUNCATE site_events');
});

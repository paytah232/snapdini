// Snapdini integration spec — the site-admin lists page properly.
//
// SERIAL (9x- prefix): these assert against DB-WIDE totals, so a parallel spec creating a user
// mid-run would make the arithmetic wrong.
//
// The failure being guarded against is silent: these lists used to be fixed LIMITs with the page
// filtering whatever arrived, so once a table outgrew the cap the extra rows simply stopped
// existing as far as the operator was concerned — no error, no empty state, just a short list.
import { api, dbq, group, ok, spec } from '../lib/harness.mjs';

await spec('93-admin-listing', async () => {
  const login = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
    ? await api('POST', '/api/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } })
    : { status: 0 };
  if (login.status !== 200) { ok('admin listing skipped — no operator creds', true); return; }

  group('Users: the total is the whole table, not the page');
  const dbUsers = Number(dbq('SELECT count(*) FROM users'));
  const all = (await api('GET', '/api/admin/users?limit=1')).json || {};
  ok('a one-row page still reports the real total', Number(all.total) === dbUsers, `${all.total} vs ${dbUsers}`);
  ok('and returns exactly one row', (all.users || []).length === 1, `${(all.users || []).length}`);

  group('Paging walks the table instead of truncating it');
  const p1 = (await api('GET', '/api/admin/users?limit=2&offset=0')).json || {};
  const p2 = (await api('GET', '/api/admin/users?limit=2&offset=2')).json || {};
  const ids1 = (p1.users || []).map((u) => u.id);
  const ids2 = (p2.users || []).map((u) => u.id);
  ok('consecutive pages do not overlap', !ids1.some((id) => ids2.includes(id)), JSON.stringify({ ids1, ids2 }));

  group('The status filters partition the table exactly');
  const verified   = Number(((await api('GET', '/api/admin/users?status=verified')).json || {}).total);
  const unverified = Number(((await api('GET', '/api/admin/users?status=unverified')).json || {}).total);
  ok('verified + never-verified accounts for everyone', verified + unverified === dbUsers,
     `${verified} + ${unverified} vs ${dbUsers}`);
  const withEvents = Number(((await api('GET', '/api/admin/users?has=events')).json || {}).total);
  const without    = Number(((await api('GET', '/api/admin/users?has=none')).json || {}).total);
  ok('has-an-event + never-made-one accounts for everyone', withEvents + without === dbUsers,
     `${withEvents} + ${without} vs ${dbUsers}`);
  ok('the has-events count matches the database',
     withEvents === Number(dbq('SELECT count(*) FROM users u WHERE EXISTS (SELECT 1 FROM events e WHERE e.owner_user_id = u.id)')),
     `${withEvents}`);

  group('Search narrows rather than truncating');
  const nonsense = (await api('GET', '/api/admin/users?q=zzz_no_such_user_zzz')).json || {};
  ok('an unmatched search is empty, not the first page of everything', Number(nonsense.total) === 0,
     `${nonsense.total}`);

  group('Survey responses and revenue page too');
  const surveys = (await api('GET', '/api/admin/survey-responses?limit=1')).json || {};
  ok('surveys report a total', typeof surveys.total === 'number', JSON.stringify(surveys.total));
  ok('surveys honour the limit', (surveys.responses || []).length <= 1);
  ok('the survey total matches the database',
     Number(surveys.total) === Number(dbq('SELECT count(*) FROM survey_responses')), `${surveys.total}`);
  const rev = (await api('GET', '/api/admin/revenue?limit=1')).json || {};
  if (rev.billingEnabled) {
    ok('revenue reports a customer total', typeof rev.total === 'number', JSON.stringify(rev.total));
    ok('revenue honours the limit', (rev.users || []).length <= 1, `${(rev.users || []).length}`);
    ok('revenue totals are unaffected by paging',
       Number(rev.totals?.all) === Number(dbq('SELECT COALESCE(SUM(amount_paid_cents),0) FROM events WHERE amount_paid_cents > 0')),
       `${rev.totals?.all}`);
  } else {
    ok('revenue paging skipped — billing disabled', true);
  }

  group('A cap still applies, so a huge limit cannot be used to dump the table');
  const huge = (await api('GET', '/api/admin/users?limit=99999')).json || {};
  ok('an absurd limit is clamped', (huge.users || []).length <= 200, `${(huge.users || []).length}`);
});

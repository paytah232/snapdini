// Snapdini integration spec — 'Negative / unauthorized', 'Survey: one response per event',
// 'Survey: testimonial consent is gated on positive feedback', 'Contact form: honeypot + validation'.
import { api, createEvent, dbq, group, join, ok, orphanJoinCodes, spec, UNIQ } from '../lib/harness.mjs';

// survey_token is only minted when the post-event survey email sends (lifecycle.ts), so every
// survey group mints one directly — otherwise the group silently skips and proves nothing.
//
// A survey is ONE response per event (migration 0051), so each scenario below needs its OWN event:
// a spec that posts a second answer to the same event is testing the dedupe, not the thing it says
// it is testing. That is exactly how this file rotted — it asserted a second response's contents.
let minted = 0;
async function surveyEvent() {
  const ev = await createEvent({ revealMode: 'instant' });
  const token = `ittok_${UNIQ}_${++minted}`;
  dbq(`UPDATE events SET survey_token='${token}' WHERE join_code='${ev.joinCode}'`);
  return { ...ev, token };
}
const rows = (id) => Number(dbq(`SELECT count(*) FROM survey_responses WHERE event_id='${id}'`));
const stored = (id, col) => dbq(`SELECT COALESCE(${col}::text,'null') FROM survey_responses WHERE event_id='${id}' ORDER BY created_at DESC LIMIT 1`);
const indexDef = () => dbq(`SELECT COALESCE(indexdef,'missing') FROM pg_indexes WHERE indexname='idx_survey_event'`);

await spec('06-negative-survey-contact', async () => {
  // ── Negative / unauthorized cases ──
  // Use a demo (ownerless) event so the logged-in test user isn't the owner — this proves the
  // organizer-code gate, not owner-identity (which legitimately grants the owner access to e1).
  group('Negative / unauthorized');
  const demoNeg = (await api('POST', '/api/events/demo')).json;
  if (demoNeg?.joinCode) orphanJoinCodes.push(demoNeg.joinCode);   // ownerless: teardown must delete it explicitly
  ok('unknown event → 404', (await api('GET', '/api/events/ZZZZZZZZ')).status === 404);
  ok('join unknown code → 404', (await join('ZZZZZZZZ', 'N')).status === 404);
  ok('admin view of non-owned event w/o org → 401/403', [401, 403].includes((await api('GET', `/api/events/${demoNeg.joinCode}/admin`)).status));
  ok('reveal non-owned w/ wrong org code → 401/403', [401, 403].includes((await api('POST', `/api/events/${demoNeg.joinCode}/reveal`, { headers: { 'X-Organizer-Code': 'wrong-code-abcdef12' } })).status));
  ok('settings PUT non-owned w/o org → 401/403', [401, 403].includes((await api('PUT', `/api/events/${demoNeg.joinCode}/settings`, { body: { name: 'hack' } })).status));
  ok('non-admin user → site-admin API 403', (await api('GET', '/api/admin/overview')).status === 403);

  // ── One response per event ──
  // The survey token sits in an emailed link, never expires and is replayable at will, and a low
  // score fires an instant operator alert. Unbounded rows were the visible half of that; the
  // NOTIFICATION STORM was the half that hurt. So the rule is enforced in two places and both are
  // asserted: a UNIQUE index on survey_responses(event_id), and an insert that answers
  // onConflictDoNothing — the caller whose insert returned nothing is the caller that must not
  // notify (routes/survey.ts).
  group('Survey: one response per event');
  {
    const ev = await surveyEvent();
    ok('the DATABASE is what enforces it — idx_survey_event is UNIQUE',
       /UNIQUE/i.test(indexDef()), indexDef());

    // Sequential submissions are caught by the route's own SELECT, so a sequential test passes
    // with the unique index dropped AND with the ON CONFLICT removed. Only a concurrent burst —
    // which is what a double-tap or a re-opened link actually looks like — reaches the insert with
    // every caller having read an empty table. Fire it for real rather than reasoning about it.
    const N = 6;
    const burst = await Promise.all(Array.from({ length: N }, () =>
      api('POST', `/api/survey/${ev.token}`, { body: { overall: 1, nps: 2, comments: { worst: 'replayed' } } })));
    const codes = burst.map((r) => r.status).join(',');
    ok(`all ${N} simultaneous submissions answer 200`, burst.every((r) => r.status === 200), codes);
    ok('...and none faults — a unique violation must never reach the respondent',
       burst.every((r) => r.status < 500 && r.json?.ok === true), codes);
    ok('exactly one row is stored', rows(ev.id) === 1, `${rows(ev.id)} rows`);
    // `alreadySubmitted` is set on exactly the callers whose insert stored NOTHING, which is the
    // same `written` check that skips notifyUnhappySurvey. So this counts the notifications: one
    // stored row, one caller told it stored, one possible alert. (The alert itself is an email to
    // the operator — invisible on a stack with no transport — so its GATE is what gets pinned.)
    const wrote = burst.filter((r) => r.json?.ok === true && !r.json?.alreadySubmitted);
    ok('exactly one submission is the one that stored — the only one that can notify',
       wrote.length === 1, `${wrote.length} of ${N} were told they stored`);
    ok('every other submission is told its answer is already in',
       burst.filter((r) => r.json?.alreadySubmitted === true).length === N - 1,
       JSON.stringify(burst.map((r) => r.json)));

    // And later, long after the burst: a replay of the same link is answered, not stored.
    const late = await api('POST', `/api/survey/${ev.token}`, { body: { overall: 5, nps: 10 } });
    ok('a later submission is accepted, not 409', late.status === 200, `status ${late.status}`);
    ok('...and says so plainly: ok + alreadySubmitted',
       late.json?.ok === true && late.json?.alreadySubmitted === true, JSON.stringify(late.json));
    ok('...and stores no second row, so it cannot notify either', rows(ev.id) === 1, `${rows(ev.id)} rows`);
    ok('the answer that is KEPT is the first one, not the last',
       stored(ev.id, 'overall') === '1', `overall=${stored(ev.id, 'overall')}`);
    ok('and the survey page agrees it has already been answered',
       (await api('GET', `/api/survey/${ev.token}`)).json?.alreadySubmitted === true);
  }

  group('Survey: testimonial consent is gated on positive feedback');
  {
    // Unhappy feedback must NOT yield publish consent even if the flag is set.
    const poor = await surveyEvent();
    await api('POST', `/api/survey/${poor.token}`, { body: { overall: 2, nps: 3, testimonialOk: true, testimonialName: 'Nope' } });
    ok('publish consent refused on poor feedback', stored(poor.id, 'testimonial_ok') === 'false');
    ok('no name stored when consent is refused', stored(poor.id, 'testimonial_name') === 'null');

    // Happy feedback with consent is accepted, name and all.
    const strong = await surveyEvent();
    await api('POST', `/api/survey/${strong.token}`, { body: { overall: 5, nps: 10, testimonialOk: true, testimonialName: 'Gillian D.' } });
    ok('publish consent accepted on strong feedback', stored(strong.id, 'testimonial_ok') === 'true');
    ok('credited name stored', stored(strong.id, 'testimonial_name') === 'Gillian D.');

    // Consent must stay OFF by default for a happy respondent who did not tick it.
    const quiet = await surveyEvent();
    await api('POST', `/api/survey/${quiet.token}`, { body: { overall: 5, nps: 10 } });
    ok('consent is opt-IN, never assumed', stored(quiet.id, 'testimonial_ok') === 'false');
  }

  group('Contact form: honeypot + validation');
  {
    const before = Number(dbq(`SELECT count(*) FROM contact_messages WHERE message='honeypot probe'`));
    const rH = await api('POST', '/api/contact', { body: { name: 'Bot', email: 'bot@example.com', message: 'honeypot probe', website: 'http://spam.example' } });
    ok('honeypot submission is accepted silently (200, not 400)', rH.status === 200, `status ${rH.status}`);
    const after = Number(dbq(`SELECT count(*) FROM contact_messages WHERE message='honeypot probe'`));
    ok('honeypot submission is NOT stored', after === before, `${before} -> ${after}`);

    const rOk = await api('POST', '/api/contact', { body: { name: 'Real', email: 'real@example.com', message: 'genuine probe' } });
    ok('a genuine submission still works', rOk.status === 200, `status ${rOk.status}`);
    ok('genuine submission stored', Number(dbq(`SELECT count(*) FROM contact_messages WHERE message='genuine probe'`)) === 1);
    dbq(`DELETE FROM contact_messages WHERE message IN ('genuine probe','honeypot probe')`);

    const rEmpty = await api('POST', '/api/contact', { body: { message: '' } });
    ok('empty message rejected', rEmpty.status === 400, `status ${rEmpty.status}`);
    const rBadEmail = await api('POST', '/api/contact', { body: { message: 'x', email: 'not-an-email' } });
    ok('malformed email rejected', rBadEmail.status === 400, `status ${rBadEmail.status}`);
  }
}, {});

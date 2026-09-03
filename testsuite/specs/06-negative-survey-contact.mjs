// Snapdini integration spec — 'Negative / unauthorized', 'Survey: testimonial consent is gated on positive feedback', 'Contact form: honeypot + validation'.
import { api, createEvent, dbq, group, join, ok, orphanJoinCodes, spec } from '../lib/harness.mjs';

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

  group('Survey: testimonial consent is gated on positive feedback');
  {
    const tEv = await createEvent({ revealMode: 'instant' });
    // survey_token is only minted when the post-event survey email sends (lifecycle.ts), so mint
    // one directly — otherwise this group silently skips and proves nothing.
    const tok = `ittok${Date.now()}`;
    dbq(`UPDATE events SET survey_token='${tok}' WHERE join_code='${tEv.joinCode}'`);
    if (tok && tok !== '') {
      // Unhappy feedback must NOT yield publish consent even if the flag is set.
      await api('POST', `/api/survey/${tok}`, { body: { overall: 2, nps: 3, testimonialOk: true, testimonialName: 'Nope' } });
      ok('publish consent refused on poor feedback',
         dbq(`SELECT testimonial_ok::text FROM survey_responses WHERE event_id='${tEv.id}' ORDER BY created_at DESC LIMIT 1`) === 'false');
      ok('no name stored when consent is refused',
         dbq(`SELECT COALESCE(testimonial_name,'null') FROM survey_responses WHERE event_id='${tEv.id}' ORDER BY created_at DESC LIMIT 1`) === 'null');
      // Happy feedback with consent is accepted, name and all.
      await api('POST', `/api/survey/${tok}`, { body: { overall: 5, nps: 10, testimonialOk: true, testimonialName: 'Gillian D.' } });
      ok('publish consent accepted on strong feedback',
         dbq(`SELECT testimonial_ok::text FROM survey_responses WHERE event_id='${tEv.id}' ORDER BY created_at DESC LIMIT 1`) === 'true');
      ok('credited name stored', dbq(`SELECT testimonial_name FROM survey_responses WHERE event_id='${tEv.id}' ORDER BY created_at DESC LIMIT 1`) === 'Gillian D.');
      // Consent must stay OFF by default for a happy respondent who did not tick it.
      await api('POST', `/api/survey/${tok}`, { body: { overall: 5, nps: 10 } });
      ok('consent is opt-IN, never assumed',
         dbq(`SELECT testimonial_ok::text FROM survey_responses WHERE event_id='${tEv.id}' ORDER BY created_at DESC LIMIT 1`) === 'false');
    } else {
      ok('survey token absent — testimonial consent skipped', true);
    }
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

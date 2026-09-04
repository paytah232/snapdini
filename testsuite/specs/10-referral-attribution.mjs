// Snapdini integration spec — referral ATTRIBUTION, gallery download stats, host-reward guard.
//
// The funnel numbers in /siteadmin are only worth reading if attribution actually stamps, and none
// of that was covered: `users.referred_by_event_id`, `events.referred_by_event_id` and the
// `snapdini_ref` cookie had zero tests. The three cases that matter are a real referral, a host
// referring themselves (must not count), and a cookie left over from a deleted event.
import { BASE, TURNSTILE_DUMMY, UNIQ, api, createEvent, dbq, group, join, ok, session, spec, upload } from '../lib/harness.mjs';

// Raw fetch: the harness jar deliberately keeps only `sid`, so read Set-Cookie ourselves.
async function refCookieFor(ref) {
  const res = await fetch(`${BASE}/api/track/ref`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref, 'cf-turnstile-response': TURNSTILE_DUMMY }),
  });
  const raw = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('snapdini_ref=')) || '';
  return { status: res.status, raw, pair: raw ? raw.split(';')[0] : '' };
}
const val = (sql) => dbq(sql) || 'null';

await spec('10-referral-attribution', async () => {
  const ownerCookie = session.cookie;
  const src = await createEvent({ revealMode: 'instant' });

  group('Referral attribution: cookie → signup → event');
  const unknown = await refCookieFor('NOSUCHCODE');
  ok('unknown referral code is accepted but sets no cookie', unknown.status === 200 && !unknown.pair, `${unknown.status} "${unknown.pair}"`);

  const ref = await refCookieFor(src.joinCode);
  ok('a real referral code sets snapdini_ref', !!ref.pair, ref.raw || '(no cookie)');
  ok('the referral cookie is httpOnly', /httponly/i.test(ref.raw), ref.raw);
  ok('the cookie stores the resolved event id, not the join code', ref.pair.endsWith(src.id), 'cookie did not resolve to the event');

  // A fresh visitor: no session, but carrying the referral cookie out of the gallery.
  session.cookie = ref.pair;
  const email2 = `ref_${UNIQ}@example.com`;
  const reg2 = await api('POST', '/api/auth/register', { body: { email: email2, password: 'hunter2hunter2', displayName: 'Referred' } });
  ok('referred visitor can sign up', reg2.status === 201, `status ${reg2.status}`);
  ok('the signup is attributed to the source event',
     val(`SELECT referred_by_event_id FROM users WHERE email='${email2}'`) === src.id,
     val(`SELECT referred_by_event_id FROM users WHERE email='${email2}'`));

  // Registering replaced the jar with the new sid, so re-attach the referral cookie: attribution is
  // stamped at BOTH signup and event creation, since either can happen first.
  const vu2 = new URL(reg2.json.devLink);
  await api('GET', vu2.pathname + vu2.search);          // verify — required before creating an event
  session.cookie = `${session.cookie}; ${ref.pair}`;
  const ev2 = await createEvent({ revealMode: 'instant' });
  ok('the event they create is attributed to the source event',
     val(`SELECT referred_by_event_id FROM events WHERE id='${ev2.id}'`) === src.id,
     val(`SELECT referred_by_event_id FROM events WHERE id='${ev2.id}'`));
  dbq(`DELETE FROM users WHERE email='${email2}'`);      // cascades their event; not covered by the harness teardown

  // The host clicking their own gallery link is not a referral.
  session.cookie = `${ownerCookie}; ${ref.pair}`;
  const own = await createEvent({ revealMode: 'instant' });
  ok('a host referring themselves is not counted',
     val(`SELECT referred_by_event_id FROM events WHERE id='${own.id}'`) === 'null',
     val(`SELECT referred_by_event_id FROM events WHERE id='${own.id}'`));

  // A 60-day cookie outlives the event that set it.
  session.cookie = `${ownerCookie}; snapdini_ref=00000000-0000-0000-0000-000000000000`;
  const stale = await createEvent({ revealMode: 'instant' });
  ok('a cookie pointing at a deleted event is ignored, not an error',
     val(`SELECT referred_by_event_id FROM events WHERE id='${stale.id}'`) === 'null',
     val(`SELECT referred_by_event_id FROM events WHERE id='${stale.id}'`));

  group('Gallery stats: downloads are counted separately from views');
  session.cookie = ownerCookie;
  const tok = (await join(src.joinCode, 'DL Guest')).json?.sessionToken;
  ok('guest joined for the stats check', !!tok);
  if (tok) await upload(tok);
  const pid = dbq(`SELECT id FROM photos WHERE event_id='${src.id}' LIMIT 1`);
  ok('photo present for the stats check', !!pid);
  if (pid) {
    await api('POST', '/api/track/photos', { body: { joinCode: src.joinCode, ids: [pid], kind: 'download' } });
    await new Promise((r) => setTimeout(r, 3500));       // dev COUNTER_FLUSH_MS=2500
    ok('download_count increments after the flush',
       Number(dbq(`SELECT download_count FROM photos WHERE id='${pid}'`)) === 1,
       dbq(`SELECT download_count FROM photos WHERE id='${pid}'`));
    ok('a download does not inflate view_count',
       Number(dbq(`SELECT view_count FROM photos WHERE id='${pid}'`)) === 0,
       dbq(`SELECT view_count FROM photos WHERE id='${pid}'`));
  }

  group('Guest photo-emails are budgeted per guest, not per venue wifi');
  // The whole point: 60 guests at a party share ONE public IP. A per-IP budget meant the 21st guest
  // was refused, and guests could exhaust the budget /api/billing/checkout shares — blocking the
  // host from paying mid-event.
  const evE = await createEvent({ revealMode: 'instant' });
  const gA = (await join(evE.joinCode, 'Guest A')).json?.sessionToken;
  const gB = (await join(evE.joinCode, 'Guest B')).json?.sessionToken;
  ok('two guests joined for the budget check', !!gA && !!gB);
  if (gA && gB) {
    const mail = (tok) => api('POST', '/api/participants/email-my-photos',
      { body: { sessionToken: tok, emailOverride: 'guest@example.com' } });
    const LIMIT = 5;                                    // GUEST_EMAIL_RATE_LIMIT default
    let blockedEarly = 0;
    for (let i = 0; i < LIMIT; i++) if ((await mail(gA)).status === 429) blockedEarly++;
    ok('a guest can email themselves up to their own limit', blockedEarly === 0, `${blockedEarly} blocked early`);
    ok('the guest IS throttled past their own limit', (await mail(gA)).status === 429);
    // The regression: guest B has spent nothing, and shares guest A's IP.
    ok('a SECOND guest on the same IP is unaffected', (await mail(gB)).status !== 429);
  }

  group('Host reward is never issued for an event that took no money');
  ok('an unpaid event carries no reward code',
     val(`SELECT host_reward_code FROM events WHERE id='${src.id}'`) === 'null',
     val(`SELECT host_reward_code FROM events WHERE id='${src.id}'`));
  // Invariant, not a row count, so it holds regardless of what else is running.
  ok('no unpaid or refunded event anywhere holds a reward code',
     Number(dbq(`SELECT count(*) FROM events WHERE host_reward_code IS NOT NULL
                  AND (COALESCE(amount_paid_cents,0) <= 0 OR refunded_at IS NOT NULL)`)) === 0,
     dbq(`SELECT count(*) FROM events WHERE host_reward_code IS NOT NULL
           AND (COALESCE(amount_paid_cents,0) <= 0 OR refunded_at IS NOT NULL)`));
});

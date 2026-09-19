// Snapdini integration spec — referral ATTRIBUTION, gallery download stats, host-reward guard.
//
// The funnel numbers in /siteadmin are only worth reading if attribution actually stamps, and none
// of that was covered: `users.referred_by_event_id`, `events.referred_by_event_id` and the
// `snapdini_ref` cookie had zero tests. The three cases that matter are a real referral, a host
// referring themselves (must not count), and a cookie left over from a deleted event.
import { BASE, TURNSTILE_DUMMY, UNIQ, api, createEvent, dbq, group, join, ok, orphanEmails, session, spec, upload, waitFor } from '../lib/harness.mjs';

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
  // Registered here, deleted in TEARDOWN (which is a `finally`) rather than on a line further down
  // that an assertion above can throw past. A leftover `ref_…` account cascades an event nobody
  // cleans up, and the address is per-process unique so nothing else can collide with it.
  orphanEmails.push(email2);
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
    // POLL for the row, do not sleep at it. `setTimeout(3500)` against a 2500ms flush interval is
    // ~1s of slack before an exact-equality read, which is a bet on how busy the box is; waiting
    // for the condition returns the moment it holds and is slow rather than red when it does not.
    const dlq = `SELECT download_count FROM photos WHERE id='${pid}'`;
    const landed = await waitFor(() => Number(dbq(dlq)) >= 1, 'the download count to flush');
    const dl = dbq(dlq);
    ok('download_count increments after the flush', landed && Number(dl) === 1, dl);
    // Not a second sleep: flushCounters() writes photo VIEWS before photo DOWNLOADS in the same
    // pass, so a landed download proves the view bucket for this photo has already been written
    // too. A zero here is now a fact about what the endpoint accepted, not a timing guess.
    const vc = dbq(`SELECT view_count FROM photos WHERE id='${pid}'`);
    ok('a download does not inflate view_count', Number(vc) === 0, vc);
  }

  group('Host reward is never issued for an event that took no money');
  ok('an unpaid event carries no reward code',
     val(`SELECT host_reward_code FROM events WHERE id='${src.id}'`) === 'null',
     val(`SELECT host_reward_code FROM events WHERE id='${src.id}'`));
  // DELIBERATELY whole-table, and it stays that way. This is not arithmetic over other specs' rows
  // (which would make it a claim about their behaviour) — it is an INVARIANT whose expected value is
  // zero no matter what else exists: ensureHostReward() refuses to stamp a code on an event that
  // took no money, so any row matching this is a product bug wherever it came from. What it lacked
  // was a diagnosable failure, so it now names the offending events instead of printing a count and
  // leaving the reader to go find them.
  const offenders = dbq(`SELECT join_code FROM events WHERE host_reward_code IS NOT NULL
                          AND (COALESCE(amount_paid_cents,0) <= 0 OR refunded_at IS NOT NULL)`);
  ok('no unpaid or refunded event anywhere holds a reward code', offenders === '',
     `rewarded but unpaid/refunded: ${offenders.split('\n').join(', ')}`);
});

// Snapdini integration spec — 'email recovery is slow and noisy, but never in a guest's way'.
//
// 97-participant-email.mjs pins WHAT recovery matches on: the address alone, deliberately, so a
// returning guest on a new phone who types their name differently still finds their roll. The cost
// of that is stated there too — and this spec covers the two things now wrapped around it, because
// the join code is printed on a venue sign and code + a guest's address is otherwise enough to mint
// a session on that guest's roll:
//
//   · a budget of 5 recovery attempts per 15 minutes per (event, address) — NOT per IP, which would
//     throttle a whole venue sharing one NAT address (see the GUEST_READ note in index.ts);
//   · an operator alert on the one recovery shape that looks like a takeover — a rename of a roll
//     that already has photos on it (asserted in app/src/server/__tests__/recovery-hardening.test.ts,
//     where the log line can be captured; here we assert it changes nothing a guest sees).
//
// What this spec must NOT find is a real guest inconvenienced: a first-time join untouched, a
// returning guest recovering, and a refusal that hands nothing over.
//
// SERIAL (9x- prefix): creates and removes its own event.
import { api, dbq, group, ok, session, spec, createEvent, upload } from '../lib/harness.mjs';

await spec('97c-recovery-hardening', async () => {
  const ownerCookie = session.cookie;
  // maxGuests 10 = the free tier: on a billing-enabled stack a paid-tier event is unpaid and refuses joins with 402.
  const ev = await createEvent({ maxGuests: 10 });
  const jn = (name, email) => api('POST', '/api/participants', { body: { joinCode: ev.joinCode, name, email } });
  const tokenOf = (email) => dbq(`SELECT session_token FROM participants WHERE event_id='${ev.id}' AND lower(email)='${email}'`);
  const A = 'returning@example.com';

  group('A returning guest still recovers, and a first-timer never meets the limiter');
  {
    const first = await jn('Alex', A);
    ok('a first-time join is a plain join', first.status === 200 && first.json?.recovered === undefined,
      `status ${first.status} ${JSON.stringify(first.json).slice(0, 90)}`);
    const u = await upload(first.json.sessionToken);
    ok('and the guest gets a photo onto the roll', u.status === 200, `status ${u.status}`);

    const back = await jn('Alex', A);
    ok('the same guest recovers their roll', back.status === 200 && back.json?.recovered === true,
      `status ${back.status} ${JSON.stringify(back.json).slice(0, 90)}`);
    ok('with the photo they had still counted', back.json?.participant?.photosTaken === 1,
      JSON.stringify(back.json?.participant));

    // The risky shape: a rename of a roll that already holds photos. It is REPORTED to the
    // operator and otherwise completely unchanged — that is the point of hardening rather than
    // changing the matching.
    const renamed = await jn('Mallory', A);
    ok('a rename of a roll with photos still recovers, exactly as before',
      renamed.status === 200 && renamed.json?.recovered === true && renamed.json?.participant?.name === 'Mallory',
      `status ${renamed.status} ${JSON.stringify(renamed.json?.participant)}`);

    // Two of the five attempts are spent (the recovery and the rename above). Three more, so the
    // last of them is the sixth and the first one over budget.
    const rest = [];
    for (let i = 0; i < 4; i++) rest.push((await jn(`Attempt${i}`, A)).status);
    ok('attempts 3, 4 and 5 are allowed and the 6th is refused', JSON.stringify(rest) === JSON.stringify([200, 200, 200, 429]),
      JSON.stringify(rest));

    const before = tokenOf(A);
    const refused = await jn('Mallory', A);
    ok('a refused attempt says so in words a guest can act on', refused.status === 429 && /wait a few minutes/.test(refused.json?.error || ''),
      `status ${refused.status} ${JSON.stringify(refused.json)}`);
    ok('and mints NO session token, so the roll is not handed over', tokenOf(A) === before && !!before);

    // The whole reason the key is not the IP: every one of these requests came from the same
    // address as the burst above.
    const other = await jn('Newcomer', 'newcomer@example.com');
    ok('a first-time join is unaffected by another address being out of budget',
      other.status === 200 && other.json?.recovered === undefined, `status ${other.status}`);
    const otherBack = await jn('Newcomer Renamed', 'newcomer@example.com');
    ok('and that guest has their own budget to recover on',
      otherBack.status === 200 && otherBack.json?.recovered === true, `status ${otherBack.status}`);
    const anon = await jn('No Address', '');
    ok('a guest who gives no address at all is unaffected', anon.status === 200, `status ${anon.status}`);

    ok('and through all of it the address still points at exactly one roll',
      Number(dbq(`SELECT count(*) FROM participants WHERE event_id='${ev.id}' AND lower(email)='${A}'`)) === 1);
  }

  dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);
  session.cookie = ownerCookie;
}, {});

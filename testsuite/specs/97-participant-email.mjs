// Snapdini integration spec — 'A guest is never locked out by how they typed their email'.
//
// (event_id, lower(email)) is UNIQUE on participants — one address per event, so an address can
// never point at two rolls and strand a paid upgrade (0031_guest_upgrades.sql). That constraint is
// right. What was wrong was everything around it:
//
//  • the recovery lookup compared email CASE-SENSITIVELY while the constraint was on lower(email),
//    so a returning guest whose phone had autocapitalised their address missed recovery, fell
//    through to the INSERT, hit the index, and got HTTP 500 — locked out of the event;
//  • "email me my photos" did its UPDATE without handling the clash, so an address already used by
//    another guest took the whole request down instead of just not being saved. That route is gone
//    (it mailed any address the caller named, from our domain); the clash it hit is still reachable
//    through PUT /api/participants/email, which is asserted below.
//
// SERIAL (9x- prefix): creates and removes its own event.
import { api, dbq, group, ok, session, spec, createEvent } from '../lib/harness.mjs';

await spec('97-participant-email', async () => {
  const ownerCookie = session.cookie;
  const ev = await createEvent({ maxGuests: 10 });
  const jn = (name, email) => api('POST', '/api/participants', { body: { joinCode: ev.joinCode, name, email } });

  group('A guest is never locked out by how they typed their email');
  {
    const first = await jn('Alex', 'Couple@Example.com');
    ok('a guest can join with an email', first.status === 200 && !!first.json?.sessionToken, `status ${first.status}`);
    const id = first.json.participant.id;

    // The regression: every one of these is the same address as far as the constraint is concerned.
    for (const variant of ['couple@example.com', 'COUPLE@EXAMPLE.COM', 'Couple@Example.COM', '  couple@Example.com  ']) {
      const r = await jn('Alex', variant);
      ok(`"${variant.trim()}" recovers the same roll, not a 500`,
        r.status === 200 && r.json?.recovered === true && r.json?.participant?.id === id,
        `status ${r.status} ${JSON.stringify(r.json).slice(0, 90)}`);
    }
    ok('and only ever ONE row exists for that address',
      Number(dbq(`SELECT count(*) FROM participants WHERE event_id=(SELECT id FROM events WHERE join_code='${ev.joinCode}') AND lower(email)='couple@example.com'`)) === 1);

    // Recovery is keyed on the EMAIL ALONE — a deliberate product decision, not an oversight, so it
    // is asserted rather than left to chance. Two people sharing an inbox therefore share a roll:
    // the second to join takes over the first one's participant. Changing that is a decision about
    // whose photos are whose, so it should mean changing this assertion on purpose.
    const shared = await jn('Sam', 'Couple@Example.com');
    ok('a shared inbox recovers the SAME roll (email alone identifies it)',
      shared.status === 200 && shared.json?.recovered === true && shared.json?.participant?.id === id,
      `status ${shared.status} ${JSON.stringify(shared.json).slice(0, 90)}`);
    // Whatever else happens, a join must never answer 500: the constraint may refuse an address, it
    // may not refuse the event.
    ok('and a join never answers 500 on a duplicate address', shared.status !== 500, `status ${shared.status}`);

    // ── the same clash, on the route that is still here ──
    // The address is already spoken for at this event, so it cannot be attached to Jo's roll. What
    // must NOT happen is a 500: the UNIQUE constraint may refuse an address, it may not take the
    // request down with it.
    const solo = await jn('Jo', '');
    ok('a guest can join without an email at all', solo.status === 200, `status ${solo.status}`);
    const token = solo.json.sessionToken;
    const claim = await api('PUT', '/api/participants/email',
      { body: { sessionToken: token, email: 'couple@example.com' } });
    ok('claiming another guest’s address is refused, not a server fault',
      claim.status === 409, `status ${claim.status} ${JSON.stringify(claim.json || {}).slice(0, 110)}`);
    ok('and the clash left the other guest’s address alone',
      Number(dbq(`SELECT count(*) FROM participants WHERE event_id=(SELECT id FROM events WHERE join_code='${ev.joinCode}') AND lower(email)='couple@example.com'`)) === 1);
    ok('never surfacing a server fault to the guest', claim.json?.error !== 'Something went wrong',
      JSON.stringify(claim.json).slice(0, 90));
  }

  dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);
  session.cookie = ownerCookie;
}, {});

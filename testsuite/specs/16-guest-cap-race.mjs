// Snapdini integration spec — 'a paid guest cap is not a suggestion'.
//
// `guestCap` is a PAID entitlement: the host buys a tier and the tier is a number of guests. The
// join handler used to enforce it as count-then-insert — SELECT count(*), compare, and INSERT some
// statements later — which is a check-then-act race with nothing holding the two halves together.
//
// That is not an exotic failure here. A QR code on a venue sign gets scanned by a whole table at
// the same moment, so simultaneous joins are the NORMAL shape of traffic at this endpoint. Every
// request in the burst read the same count before any of them had inserted, and every one of them
// passed: twenty-five simultaneous joins at a cap of ten admitted twenty-five. Guests beyond the
// tier the host paid for got in free, which is a revenue bug as well as a correctness one.
//
// This spec fires the burst for real rather than reasoning about it, and asserts three things that
// have to hold together — the cap, the returning guest, and the shared inbox:
//
//   1. exactly `cap` of N simultaneous joins are admitted, and the rest are told the event is full;
//   2. a guest who already has a roll still RECOVERS at a full event — recovery deliberately runs
//      before the cap check so a returning guest is never turned away as "full", and serialising
//      the joins must not quietly reorder that;
//   3. simultaneous joins on the SAME address answer 200, not 500. The insert can still lose to
//      (event_id, lower(email)); that path has a documented history of 500ing and locking a guest
//      out of the event (see specs/97-participant-email.mjs), and a lock around the insert is
//      exactly the kind of change that brings it back — in Postgres a failed statement poisons the
//      whole transaction, so the retry needs a savepoint or it answers 25P02.
//
// Self-hosters have NO caps (the whole block is gated on billingEnabled), so with billing off the
// assertion inverts: every join must be admitted. Both branches assert; neither skips quietly.
import { api, createEvent, dbq, group, ok, spec, UNIQ } from '../lib/harness.mjs';

const CAP = 10;   // maxGuests 10 = the free tier, so the event is entitled without a payment
const N = 25;     // the burst: 2.5× the cap, enough that an overshoot cannot be luck

const countAt = (joinCode, where = '') =>
  Number(dbq(`SELECT count(*) FROM participants WHERE event_id=(SELECT id FROM events WHERE join_code='${joinCode}')${where}`));

// N joins in flight at once. Promise.all, so every request is handed to the stack before any of
// them has answered — the overlap is the point, not the throughput.
const burst = (joinCode, n, email = () => undefined) =>
  Promise.all(Array.from({ length: n }, (_, i) => api('POST', '/api/participants', {
    body: { joinCode, name: `Racer ${i}`, email: email(i) },
  })));

const tally = (rs) => ({
  admitted: rs.filter((r) => r.status === 200).length,
  full:     rs.filter((r) => r.status === 403).length,
  faults:   rs.filter((r) => r.status >= 500).length,
  other:    rs.filter((r) => r.status !== 200 && r.status !== 403 && r.status < 500).length,
});

// Every session we handed out has to actually open a roll. A join that answers 200 with a token
// that does not work is the same outcome as a refusal, only harder to notice.
const sessionsWork = async (rs) => {
  const tokens = rs.filter((r) => r.status === 200).map((r) => r.json?.sessionToken);
  if (!tokens.length || tokens.some((t) => !t)) return false;
  const me = await Promise.all(tokens.map((t) => api('GET', `/api/participants/me?sessionToken=${t}`)));
  return me.every((r) => r.status === 200);
};

await spec('16-guest-cap-race', async () => {
  const cfg = await api('GET', '/api/config');
  const billing = !!cfg.json?.billing?.billingEnabled;
  console.log(`\n[16] billing ${billing ? 'ON — caps enforced' : 'OFF (self-host) — no caps'}`);

  const addr = (i) => `racer${i}_${UNIQ}@example.com`;

  group('A burst of simultaneous joins cannot overshoot a paid cap');
  const ev = await createEvent({ maxGuests: CAP });
  {
    ok('the event is entitled to exactly the cap it was bought at',
      Number(dbq(`SELECT guest_cap FROM events WHERE join_code='${ev.joinCode}'`)) === CAP);
    ok('...and is active, so the cap is the only thing that can refuse a guest',
      dbq(`SELECT paid FROM events WHERE join_code='${ev.joinCode}'`) === 't');

    const rs = await burst(ev.joinCode, N, addr);
    const t = tally(rs);
    // The headline. Before the fix this read admitted=25 / full=0.
    if (billing) {
      ok(`exactly ${CAP} of ${N} simultaneous joins are admitted`,
        t.admitted === CAP, `admitted ${t.admitted}, full ${t.full}`);
      ok('...and the overflow is told the event is full, one refusal each',
        t.full === N - CAP, `full ${t.full} of an expected ${N - CAP}`);
      ok('...and the database agrees — not one row was written past the cap',
        countAt(ev.joinCode) === CAP, `${countAt(ev.joinCode)} participants`);
      ok('...and the refusal names the cap, so the host knows what to upgrade',
        rs.some((r) => r.status === 403 && /max 10 guests/.test(r.json?.error || '')),
        JSON.stringify(rs.find((r) => r.status === 403)?.json || null));
    } else {
      ok(`self-host has no caps, so all ${N} joins are admitted`,
        t.admitted === N, `admitted ${t.admitted}, full ${t.full}`);
      ok('...and every one of them is a real roll', countAt(ev.joinCode) === N, `${countAt(ev.joinCode)}`);
    }
    // A burst is the one moment a guest cannot be handed a server fault: they are standing in a
    // room with a QR code and no idea what to do next.
    ok('no join in the burst answered a server fault', t.faults === 0, `${t.faults} × 5xx`);
    ok('and nothing answered anything unexpected', t.other === 0, `${t.other} other statuses`);
    ok('every admitted guest can open their roll with the token they were given',
      await sessionsWork(rs));
  }

  group('The cap still holds once the rush is over');
  if (billing) {
    const late = tally(await burst(ev.joinCode, 5, (i) => `late${i}_${UNIQ}@example.com`));
    ok('a full event admits nobody, five at once or otherwise',
      late.admitted === 0 && late.full === 5, `admitted ${late.admitted}, full ${late.full}`);
    ok('...and still has exactly the cap in it', countAt(ev.joinCode) === CAP, `${countAt(ev.joinCode)}`);
  }

  group('A returning guest is never turned away as full');
  {
    // Which of the racers actually got a seat is decided by the race, so ask the database rather
    // than guess — any one of them will do.
    const seated = dbq(`SELECT email FROM participants WHERE event_id=(SELECT id FROM events WHERE join_code='${ev.joinCode}') AND email IS NOT NULL LIMIT 1`);
    ok('at least one seated guest left an address to come back with', !!seated, `got "${seated}"`);
    const before = countAt(ev.joinCode);
    const back = await api('POST', '/api/participants', { body: { joinCode: ev.joinCode, name: 'Racer (new phone)', email: seated } });
    // THE regression this guards: the cap check now runs inside a transaction, and if recovery
    // were ever moved into or after it, this guest — who has a seat already — would be told the
    // event is full and lose the roll they are holding.
    ok('a guest who already has a roll recovers it at a FULL event',
      back.status === 200 && back.json?.recovered === true,
      `status ${back.status} ${JSON.stringify(back.json).slice(0, 90)}`);
    ok('...and recovering takes no extra seat', countAt(ev.joinCode) === before, `${countAt(ev.joinCode)} vs ${before}`);
  }

  group('Two devices joining with the SAME address at once is not a 500');
  {
    // A shared inbox, or one person tapping Join twice on a flaky connection. Several requests can
    // miss recovery (each read before any of them had inserted) and then meet at the UNIQUE index.
    const ev2 = await createEvent({ maxGuests: CAP });
    const shared = `shared_${UNIQ}@example.com`;
    const rs = await burst(ev2.joinCode, 6, () => shared);
    const t = tally(rs);
    ok('a duplicate-address race never answers 500', t.faults === 0, `${t.faults} × 5xx`);
    ok('...every one of them is let into the event', t.admitted === 6, `admitted ${t.admitted}, full ${t.full}`);
    ok('...each with a session that opens a roll', await sessionsWork(rs));
    // The constraint may refuse an ADDRESS; it may not refuse the event. Whoever loses the race is
    // in the event without their address stored — they lose email recovery, not the roll — so the
    // address points at exactly one roll, which is the whole reason the index exists.
    ok('...and the address still identifies exactly one roll',
      countAt(ev2.joinCode, ` AND lower(email)='${shared}'`) === 1,
      `${countAt(ev2.joinCode, ` AND lower(email)='${shared}'`)} rows hold it`);
    // Whoever did NOT recover an existing roll got one of their own. Stated as an identity rather
    // than a fixed 6, because how many of the six recover instead of inserting is genuinely up to
    // the timing — what must not vary is that a join either recovers a roll or creates one.
    const fresh = rs.filter((r) => r.status === 200 && !r.json?.recovered).length;
    ok('...and every join that was not a recovery created exactly one roll',
      countAt(ev2.joinCode) === fresh, `${countAt(ev2.joinCode)} participants vs ${fresh} fresh joins`);
  }
});

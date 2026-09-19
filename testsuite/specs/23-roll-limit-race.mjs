// Snapdini integration spec — 'the limited roll is not a suggestion either'.
//
// The roll IS the product: a guest gets N frames and that scarcity is the whole pitch. It is also a
// paid entitlement twice over — the host buys the roll size, and a guest can buy `extraPhotos` on
// top — so a frame handed out for free is a revenue bug wearing a correctness bug's coat.
//
// The upload path used to count like this:
//
//     const p = await participantForUpload(token);          // reads photos_taken
//     …minutes of image work…
//     set({ photosTaken: p.photosTaken + 1 })               // writes it back
//
// Check-then-act with nothing holding the halves together, and the gate (`hasShotsLeft`) reading
// the same stale row. Ten simultaneous uploads on one session token all read 0, all wrote 1, and a
// 30-shot roll recorded ONE photo taken while holding ten — with `photosRemaining: 29` reported ten
// times to a guest who had in fact spent ten frames. Worse: thirty uploads against a roll of seven
// were all accepted, because nothing ever compared the counter to the cap on fresh data.
//
// Is that reachable? The in-app camera queues serially (`if (uploading) return`), so it needs two
// tabs, two devices on one session token, or a retried request. At a party none of those is exotic,
// and a retry is the normal outcome of a phone on a venue's wifi.
//
// The delete path had the mirror of it — two deletes reading the same count and both writing
// count-1, which costs a guest a frame they never used — so that is asserted here too, including
// the double-tapped delete of a SINGLE photo, which must give the frame back exactly once.
//
// Everything here fires the burst for real. The counter, the stored rows and the number the guest
// is shown all have to agree; any one of them alone can look right while the roll leaks.
import { api, createEvent, dbq, group, join, ok, spec, upload } from '../lib/harness.mjs';

const takenBy = (pid) => Number(dbq(`SELECT photos_taken FROM participants WHERE id='${pid}'`));
const rowsIn  = (eventId) => Number(dbq(`SELECT count(*) FROM photos WHERE event_id='${eventId}'`));
const pidOf   = (tok) => dbq(`SELECT id FROM participants WHERE session_token='${tok}'`);

// N uploads in flight at once: every request reaches the stack before any of them answers. The
// overlap is the point — run these in series and the old code passes.
const burst = (tok, n) => Promise.all(Array.from({ length: n }, () => upload(tok)));
const bin = (rs) => rs.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});

async function guestOn(joinCode, name) {
  const tok = (await join(joinCode, name)).json?.sessionToken;
  return { tok, pid: tok ? pidOf(tok) : null };
}

await spec('21-roll-limit-race', async () => {
  group('A burst of simultaneous uploads is counted once each');
  {
    const ev = await createEvent({ maxPhotos: 30 });
    // Billing may snap the requested roll to a purchased tier, so take the roll the event actually
    // HAS rather than the one we asked for. The assertions are about agreement, not about 30.
    const roll = Number(dbq(`SELECT max_photos FROM events WHERE id='${ev.id}'`));
    const { tok, pid } = await guestOn(ev.joinCode, 'Two Tabs');
    ok('guest joined', !!tok);

    const n = Math.min(10, roll);
    const rs = await burst(tok, n);
    const okd = rs.filter((r) => r.status === 200);
    console.log(`   roll=${roll} statuses=${JSON.stringify(bin(rs))}`);

    // The headline. Before the fix this read photos_taken=1 for any n.
    ok(`${n} simultaneous uploads are all accepted`, okd.length === n, `${okd.length} of ${n}`);
    ok('...and the counter moved once per photo',
      takenBy(pid) === n, `photos_taken=${takenBy(pid)}, expected ${n}`);
    ok('...and the counter agrees with the rows actually stored',
      takenBy(pid) === rowsIn(ev.id), `photos_taken=${takenBy(pid)} vs ${rowsIn(ev.id)} rows`);

    // A counter that is right while the guest is told something else is still a broken roll: the
    // camera draws its "N left" from this number. Before the fix every response said roll-1.
    const reported = okd.map((r) => r.json?.photosRemaining).sort((a, b) => b - a);
    const expected = Array.from({ length: n }, (_, i) => roll - 1 - i);
    ok('...and every response reports a distinct, correct photosRemaining',
      JSON.stringify(reported) === JSON.stringify(expected), JSON.stringify(reported));
    ok('...ending on the number the database holds',
      reported[reported.length - 1] === roll - takenBy(pid), `${reported[reported.length - 1]}`);
  }

  group('The cap is enforced against the new count, not a stale one');
  {
    const ev = await createEvent({ maxPhotos: 6 });
    const roll = Number(dbq(`SELECT max_photos FROM events WHERE id='${ev.id}'`));
    const { tok, pid } = await guestOn(ev.joinCode, 'Trigger Happy');
    ok('guest joined', !!tok);

    // Three times the roll, all at once. An atomic counter that nothing COMPARES would let every
    // one of these through; before the fix all 3×roll were stored.
    const rs = await burst(tok, roll * 3);
    const okd = rs.filter((r) => r.status === 200).length;
    const refused = rs.filter((r) => r.status === 403).length;
    console.log(`   roll=${roll} statuses=${JSON.stringify(bin(rs))}`);

    ok(`exactly ${roll} of ${roll * 3} simultaneous uploads are accepted`, okd === roll, `${okd} accepted`);
    ok('...and the overflow is refused, one refusal each', refused === roll * 2, `${refused} refused`);
    ok('...with the "no shots left" answer, not a fault',
      rs.filter((r) => r.status >= 500).length === 0 &&
      rs.every((r) => r.status === 200 || /shots/i.test(r.json?.error || '')), JSON.stringify(bin(rs)));
    ok('...and the counter stops exactly at the roll', takenBy(pid) === roll, `photos_taken=${takenBy(pid)}`);
    // The refusals must roll back, not leave a stored photo the guest was told they could not take.
    ok('...and no refused upload left a row behind', rowsIn(ev.id) === roll, `${rowsIn(ev.id)} rows`);

    group('A guest who BUYS more frames gets exactly those frames');
    dbq(`UPDATE participants SET extra_photos = 4 WHERE id='${pid}'`);
    const more = await burst(tok, 12);
    const gotMore = more.filter((r) => r.status === 200).length;
    ok('a paid top-up of 4 admits exactly 4 more', gotMore === 4, `${gotMore} accepted`);
    ok('...and not one frame more', takenBy(pid) === roll + 4, `photos_taken=${takenBy(pid)}`);
    ok('...and the roll is closed again afterwards',
      (await upload(tok)).status === 403);
  }

  group('Taking a shot back gives back exactly one frame');
  {
    const ev = await createEvent({ maxPhotos: 12 });
    const roll = Number(dbq(`SELECT max_photos FROM events WHERE id='${ev.id}'`));
    const { tok, pid } = await guestOn(ev.joinCode, 'Butterfingers');
    ok('guest joined', !!tok);
    const shots = await burst(tok, 4);
    const ids = shots.filter((r) => r.status === 200).map((r) => r.json?.photoId);
    ok('four shots landed', takenBy(pid) === 4 && ids.length === 4, `taken=${takenBy(pid)}`);

    // Two deletes at once, on two DIFFERENT photos. Before the fix both read 4 and both wrote 3,
    // so the guest lost a frame they never used.
    const ds = await Promise.all(ids.slice(0, 2).map((id) =>
      api('DELETE', `/api/photos/${id}`, { body: { sessionToken: tok } })));
    console.log(`   delete statuses=${JSON.stringify(bin(ds))} remaining=${JSON.stringify(ds.map((r) => r.json?.photosRemaining))}`);
    ok('both deletes succeed', ds.every((r) => r.status === 200), JSON.stringify(bin(ds)));
    ok('...and the roll came back by exactly two', takenBy(pid) === 2, `photos_taken=${takenBy(pid)}`);
    ok('...and the counter still matches the rows', takenBy(pid) === rowsIn(ev.id), `${rowsIn(ev.id)} rows`);
    ok('...and each response reported a different, correct count',
      JSON.stringify(ds.map((r) => r.json?.photosRemaining).sort((a, b) => a - b)) ===
      JSON.stringify([roll - 3, roll - 2]), JSON.stringify(ds.map((r) => r.json?.photosRemaining)));

    // One photo, two requests — a double-tapped confirm, or a retry. Exactly one frame comes back.
    const twice = await Promise.all([0, 1].map(() =>
      api('DELETE', `/api/photos/${ids[2]}`, { body: { sessionToken: tok } })));
    ok('a photo deleted twice answers 200 once and 404 once',
      twice.filter((r) => r.status === 200).length === 1 && twice.filter((r) => r.status === 404).length === 1,
      JSON.stringify(bin(twice)));
    ok('...and refunded the frame exactly once', takenBy(pid) === 1, `photos_taken=${takenBy(pid)}`);

    // A counter that has drifted (an admin fix, a purge) must not turn into a free roll.
    dbq(`UPDATE participants SET photos_taken = 0 WHERE id='${pid}'`);
    const last = await api('DELETE', `/api/photos/${ids[3]}`, { body: { sessionToken: tok } });
    ok('deleting against a zero counter still succeeds', last.status === 200, `status ${last.status}`);
    ok('...and cannot drive it negative', takenBy(pid) === 0, `photos_taken=${takenBy(pid)}`);
  }
});

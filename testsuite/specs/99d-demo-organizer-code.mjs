// Snapdini integration spec — 'a demo hands out its own code, and only a demo'.
//
// The demo is a tour of three surfaces, and the link between them broke on the route people
// actually take: start it on a laptop, which shows a QR because the camera wants a phone, and the
// organizer code was written into the LAPTOP's localStorage. The phone that scans has never seen
// it, so the visitor lands in the camera with no way to the host's view — half of what the demo is
// selling. The public event payload now carries the code for a demo.
//
// That is safe for a demo — no owner, a two-guest cap, purged in about three hours, and anyone can
// mint one with a single unauthenticated POST — and catastrophic for anything else, since an
// organizer code is a bearer credential for the whole event: reveal, settings, delete. So the point
// of this spec is the NEGATIVE case.
import { BASE, api, createEvent, group, ok, orphanJoinCodes, spec } from '../lib/harness.mjs';

await spec('99d-demo-organizer-code', async () => {
  group('A demo hands out its own code, and only a demo');
  {
    const demo = await api('POST', '/api/events/demo');
    ok('a demo can be started', demo.status === 200 && !!demo.json?.joinCode, `status ${demo.status}`);
    if (demo.json?.joinCode) orphanJoinCodes.push(demo.json.joinCode);

    // A device that never created the demo — no cookie, no storage, just the join code off a QR.
    const seen = await fetch(`${BASE}/api/events/${demo.json.joinCode}`);
    const pub = await seen.json();
    ok('it is flagged as a demo', pub.isDemo === true);
    ok('and the payload carries the organizer code', typeof pub.organizerCode === 'string' && pub.organizerCode.length > 0,
      String(pub.organizerCode));
    ok('which is the real one, not a placeholder', pub.organizerCode === demo.json.organizerCode);

    // …and it actually opens the manager, which is the whole point of handing it over.
    const admin = await api('GET', `/api/events/${demo.json.joinCode}/admin`,
      { headers: { 'x-organizer-code': pub.organizerCode } });
    ok('the code opens the host view', admin.status === 200, `status ${admin.status}`);

    // THE NEGATIVE CASE: a real event must never do this.
    const real = await createEvent();
    const realPub = await (await fetch(`${BASE}/api/events/${real.joinCode}`)).json();
    ok('a real event is not a demo', realPub.isDemo === false);
    ok('and NEVER returns its organizer code', realPub.organizerCode === undefined,
      `got ${JSON.stringify(realPub.organizerCode)}`);
    ok('nor anything else that would open it', !JSON.stringify(realPub).includes(real.organizerCode),
      'the organizer code appeared somewhere in the public payload');
  }
});

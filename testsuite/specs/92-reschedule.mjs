// Snapdini integration spec — 'Reschedule an unused event (usage-gated, 6-month ceiling)'.
//
// SERIAL (9x- prefix): calls POST /api/admin/run-sweep (twice), which purges DB-wide.
import { HOUR, api, createEvent, dbq, group, join, ok, org, session, spec, upload } from '../lib/harness.mjs';

await spec('92-reschedule', async () => {
  const ownerCookie = session.cookie;   // the verified owner session bootstrapOwner() left us in

  group('Reschedule an unused event (usage-gated, 6-month ceiling)');
  {
    const DAY = 86_400_000;
    // A) An event that has ALREADY STARTED but nobody used can still be moved. This is the whole
    //    point: the organizer bought, never got the QR in front of anyone, and the window lapsed.
    const past = await createEvent({ startsAt: Date.now() - 3 * HOUR, durationHours: 1 });
    const future = Date.now() + 3 * DAY;
    const rA = await api('PUT', `/api/events/${past.joinCode}/settings`, { headers: org(past.organizerCode), body: { startsAt: future } });
    ok('unused + already-started CAN be rescheduled', rA.status === 200, `status ${rA.status}`);
    const movedTo = Number(dbq(`SELECT starts_at FROM events WHERE id='${past.id}'`));
    ok('new start persisted', Math.abs(movedTo - future) < 2000, String(movedTo));

    // Duration must be preserved — rescheduling is not a free way to lengthen a paid event.
    const span = Number(dbq(`SELECT (expires_at - starts_at) FROM events WHERE id='${past.id}'`));
    ok('duration preserved across a reschedule', span === HOUR, `${span}ms`);

    // original_starts_at must NOT move, or repeated hops walk the event forward forever.
    const anchorStart = Number(dbq(`SELECT original_starts_at FROM events WHERE id='${past.id}'`));
    ok('original_starts_at stays the ORIGINAL start', anchorStart < Date.now(), String(anchorStart));

    // B) Beyond ~6 months from the ORIGINAL start is refused.
    const tooFar = anchorStart + 200 * DAY;
    const rB = await api('PUT', `/api/events/${past.joinCode}/settings`, { headers: org(past.organizerCode), body: { startsAt: tooFar } });
    ok('beyond the 6-month ceiling is refused', rB.status === 400, `status ${rB.status}`);
    ok('refused move did not persist', Math.abs(Number(dbq(`SELECT starts_at FROM events WHERE id='${past.id}'`)) - future) < 2000);

    // C) A start in the past is refused.
    const rC = await api('PUT', `/api/events/${past.joinCode}/settings`, { headers: org(past.organizerCode), body: { startsAt: Date.now() - DAY } });
    ok('a past start is refused', rC.status === 400, `status ${rC.status}`);

    // D) Once a guest has joined, the start LOCKS — a live event must never shift under its guests.
    const used = await createEvent({ startsAt: Date.now() - 2 * HOUR, durationHours: 6 });
    const j = await join(used.joinCode, 'Guest A');
    ok('guest joined the used event', j.status === 200, `status ${j.status}`);
    const beforeLock = Number(dbq(`SELECT starts_at FROM events WHERE id='${used.id}'`));
    const rD = await api('PUT', `/api/events/${used.joinCode}/settings`, { headers: org(used.organizerCode), body: { startsAt: Date.now() + 5 * DAY } });
    ok('started + used CANNOT be rescheduled', rD.status === 409, `status ${rD.status}`);
    ok('locked event start unchanged', Number(dbq(`SELECT starts_at FROM events WHERE id='${used.id}'`)) === beforeLock);

    // E) A used but NOT-yet-started event can still be moved (guests joined early; nothing has run).
    const early = await createEvent({ startsAt: Date.now() + 2 * DAY, durationHours: 4 });
    await join(early.joinCode, 'Early Bird');
    const rE = await api('PUT', `/api/events/${early.joinCode}/settings`, { headers: org(early.organizerCode), body: { startsAt: Date.now() + 4 * DAY } });
    ok('upcoming event still reschedulable even with a guest', rE.status === 200, `status ${rE.status}`);

    // F) Saving OTHER settings on a locked event must not be blocked by the reschedule guard —
    //    the client re-sends the identical startsAt on every save (60s tolerance).
    const rF = await api('PUT', `/api/events/${used.joinCode}/settings`, { headers: org(used.organizerCode), body: { name: 'Still Editable', startsAt: beforeLock } });
    ok('unrelated settings still savable on a locked event', rF.status === 200, `status ${rF.status}`);
    ok('name change persisted on locked event', dbq(`SELECT name FROM events WHERE id='${used.id}'`) === 'Still Editable');

    // H0) Retention must NOT purge an event nobody used while it is still reschedulable — there is
    //     no media or PII to remove, and purging only strips the organizer's ability to move it.
    //     Needs admin creds to trigger the sweep; the used event proves the sweeper actually ran,
    //     so this can never pass vacuously.
    const unusedDue = await createEvent({ startsAt: Date.now() - 5 * HOUR, durationHours: 1 });
    const usedDue = await createEvent({ startsAt: Date.now() - HOUR, durationHours: 6 });   // still live, so a guest CAN join
    const udTok = (await join(usedDue.joinCode, 'Sweeper Guest')).json?.sessionToken;
    if (udTok) await upload(udTok);
    dbq(`UPDATE events SET purge_at=${Date.now() - 1000} WHERE id IN ('${unusedDue.id}','${usedDue.id}')`);
    const adminLogin2 = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
      ? await api('POST', '/api/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } })
      : { status: 0 };
    if (adminLogin2.status === 200) {
      ok('sweeper ran', (await api('POST', '/api/admin/run-sweep')).status === 200);
      // Control: the USED event must be purged, proving the sweeper did work this pass.
      ok('sweeper DOES purge a used event past retention',
         dbq(`SELECT COALESCE(purged_at::text,'null') FROM events WHERE id='${usedDue.id}'`) !== 'null');
      ok('sweeper leaves an unused, still-reschedulable event alone',
         dbq(`SELECT COALESCE(purged_at::text,'null') FROM events WHERE id='${unusedDue.id}'`) === 'null');
    } else {
      ok('sweeper leniency skipped — no admin creds on this env', true);
    }
    session.cookie = ownerCookie;

    // H1) An unused PAID event must still exist the day its reschedule deadline falls, not be
    //     swept that morning. Age it to one hour before the deadline and confirm it survives.
    const nearEdge = await createEvent({ startsAt: Date.now() - 4 * HOUR, durationHours: 1 });
    const edgeAnchor = Date.now() - (183 * DAY) + HOUR;   // deadline is ~1h away
    dbq(`UPDATE events SET paid=true, amount_paid_cents=2000, original_starts_at=${edgeAnchor}, starts_at=${edgeAnchor}, purge_at=${Date.now() - 1000} WHERE id='${nearEdge.id}'`);
    if (adminLogin2.status === 200) {
      // Re-authenticate: the previous block restored the owner cookie, and run-sweep is admin-only.
      await api('POST', '/api/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
      await api('POST', '/api/admin/run-sweep');
      ok('unused paid event survives right up to its reschedule deadline',
         dbq(`SELECT COALESCE(purged_at::text,'null') FROM events WHERE id='${nearEdge.id}'`) === 'null');
      // Past the deadline + grace it becomes purgeable like anything else.
      dbq(`UPDATE events SET original_starts_at=${Date.now() - (185 * DAY)}, starts_at=${Date.now() - (185 * DAY)}, purge_at=${Date.now() - 1000} WHERE id='${nearEdge.id}'`);
      ok('sweep authorised', (await api('POST', '/api/admin/run-sweep')).status === 200);
      ok('past the deadline + grace it is finally purged',
         dbq(`SELECT COALESCE(purged_at::text,'null') FROM events WHERE id='${nearEdge.id}'`) !== 'null');
      session.cookie = ownerCookie;
    }

    // H) An unused event whose media was already purged by retention must come back clean, not
    //    stuck reading as archived.
    dbq(`UPDATE events SET purged_at=${Date.now()} WHERE id='${past.id}'`);
    const rPurged = await api('PUT', `/api/events/${past.joinCode}/settings`, { headers: org(past.organizerCode), body: { startsAt: Date.now() + 9 * DAY } });
    ok('purged-but-unused event can still be rescheduled', rPurged.status === 200, `status ${rPurged.status}`);
    ok('reschedule clears the purged archive marker', dbq(`SELECT COALESCE(purged_at::text,'null') FROM events WHERE id='${past.id}'`) === 'null');

    // G0) The ADMIN route must expose it too — that is the endpoint the settings screen reads, and
    //     the date fields stay disabled without it (the UI falls back to the old time-based rule).
    const admU = await api('GET', `/api/events/${used.joinCode}/admin`, { headers: org(used.organizerCode) });
    ok('admin route exposes canReschedule=false when used', admU.json?.canReschedule === false, String(admU.json?.canReschedule));
    const admP = await api('GET', `/api/events/${past.joinCode}/admin`, { headers: org(past.organizerCode) });
    ok('admin route exposes canReschedule=true when unused', admP.json?.canReschedule === true, String(admP.json?.canReschedule));
    ok('admin route exposes rescheduleUntil', Number(admP.json?.rescheduleUntil) > Date.now(), String(admP.json?.rescheduleUntil));

    // G) canReschedule / rescheduleUntil are exposed so the UI can show or hide the control.
    const pub = await api('GET', `/api/events/${used.joinCode}`);
    ok('canReschedule=false on a locked event', pub.json?.canReschedule === false, String(pub.json?.canReschedule));
    const pub2 = await api('GET', `/api/events/${past.joinCode}`);
    ok('canReschedule=true on an unused event', pub2.json?.canReschedule === true, String(pub2.json?.canReschedule));
    ok('rescheduleUntil ~6 months past the original start',
       Math.abs(Number(pub2.json?.rescheduleUntil) - (anchorStart + 183 * DAY)) < 2000, String(pub2.json?.rescheduleUntil));
  }
}, {});

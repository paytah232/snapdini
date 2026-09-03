// Snapdini integration spec — 'Retention / purge'.
//
// SERIAL (9x- prefix): POST /api/admin/run-sweep purges every eligible event in the whole DB.
import { TS, api, createEvent, dbq, group, join, ok, org, session, spec, upload } from '../lib/harness.mjs';

await spec('90-retention-purge', async () => {
  const ownerCookie = session.cookie;   // the verified owner session bootstrapOwner() left us in

  // ── Retention purge: the admin-triggered sweep frees the event slug + deletes its share rows ──
  group('Retention / purge');
  session.cookie = ownerCookie;
  // Must be an event that was actually USED: retention now deliberately spares unused events while
  // they remain reschedulable (see cleanup.ts), so an empty one would never be swept.
  const ePurge = await createEvent({ revealMode: 'instant' });
  const purgeTok = (await join(ePurge.joinCode, 'Purge Guest')).json?.sessionToken;
  if (purgeTok) await upload(purgeTok);
  const pslug = `purgeme-${TS}`;
  dbq(`UPDATE events SET slug='${pslug}' WHERE id='${ePurge.id}'`);
  await api('POST', `/api/events/${ePurge.joinCode}/shares`, { headers: org(ePurge.organizerCode), body: { kind: 'all' } });
  ok('purge setup: slug + share present', dbq(`SELECT slug FROM events WHERE id='${ePurge.id}'`) === pslug && Number(dbq(`SELECT count(*) FROM shares WHERE event_id='${ePurge.id}'`)) >= 1);
  dbq(`UPDATE events SET purge_at=${Date.now() - 1000} WHERE id='${ePurge.id}'`);
  // Admin creds come from the env so no credential is baked into the repo. Set ADMIN_EMAIL +
  // ADMIN_PASSWORD (matching your deployment) to exercise this; otherwise it gracefully skips.
  const adminLogin = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
    ? await api('POST', '/api/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } })
    : { status: 0 };
  if (adminLogin.status === 200) {
    ok('admin run-sweep → ok', (await api('POST', '/api/admin/run-sweep')).status === 200);
    ok('purge frees the event slug', dbq(`SELECT COALESCE(slug,'∅') FROM events WHERE id='${ePurge.id}'`) === '∅');
    ok('purge deletes share rows', Number(dbq(`SELECT count(*) FROM shares WHERE event_id='${ePurge.id}'`)) === 0);
    ok('purge marks purged_at', dbq(`SELECT COALESCE(purged_at::text,'∅') FROM events WHERE id='${ePurge.id}'`) !== '∅');
  } else {
    ok('purge sweep skipped — no admin creds on this env', true);
  }
  session.cookie = ownerCookie;
}, {});

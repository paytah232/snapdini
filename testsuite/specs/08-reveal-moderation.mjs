// Snapdini integration spec — 'Manual reveal / unreveal', 'Moderation queue'.
import { api, createEvent, dbq, gallery, group, join, ok, org, spec, upload } from '../lib/harness.mjs';

await spec('08-reveal-moderation', async () => {
  // ── Manual reveal ──
  group('Manual reveal / unreveal');
  const e2 = await createEvent({ revealMode: 'manual' });
  const j = await join(e2.joinCode, 'C'); await upload(j.json.sessionToken);
  let g = await gallery(e2.joinCode);
  ok('manual hidden before reveal', g.json?.revealed === false);
  ok('manual hides photos but reports count', g.json?.photos === undefined && g.json?.photoCount === 1);
  await api('POST', `/api/events/${e2.joinCode}/reveal`, { headers: org(e2.organizerCode) });
  ok('DB revealed_at set after reveal', dbq(`SELECT revealed_at IS NOT NULL FROM events WHERE id='${e2.id}'`) === 't');
  g = await gallery(e2.joinCode);
  ok('manual visible after reveal', g.json?.revealed === true && g.json?.photos?.length === 1);
  await api('POST', `/api/events/${e2.joinCode}/unreveal`, { headers: org(e2.organizerCode) });
  ok('DB revealed_at cleared after unreveal', dbq(`SELECT revealed_at IS NULL FROM events WHERE id='${e2.id}'`) === 't');
  ok('hidden again after unreveal', (await gallery(e2.joinCode)).json?.revealed === false);

  // ── Moderation ──
  group('Moderation queue');
  const eMod = await createEvent({ revealMode: 'manual', moderationEnabled: true });
  ok('DB moderation_enabled=true', dbq(`SELECT moderation_enabled FROM events WHERE id='${eMod.id}'`) === 't');
  const jm = await join(eMod.joinCode, 'M'); await upload(jm.json.sessionToken);
  ok('moderated upload → pending', dbq(`SELECT status FROM photos WHERE event_id='${eMod.id}'`) === 'pending');
  await api('POST', `/api/events/${eMod.joinCode}/reveal`, { headers: org(eMod.organizerCode) });
  ok('pending photo NOT in revealed gallery', ((await gallery(eMod.joinCode)).json?.photos?.length || 0) === 0);
  const pid = dbq(`SELECT id FROM photos WHERE event_id='${eMod.id}'`);
  await api('POST', `/api/events/${eMod.joinCode}/moderate`, { headers: org(eMod.organizerCode), body: { photoIds: [pid], action: 'approve' } });
  ok('approved → status approved', dbq(`SELECT status FROM photos WHERE id='${pid}'`) === 'approved');
  ok('approved photo now in gallery', (await gallery(eMod.joinCode)).json?.photos?.length === 1);
  // reject path
  const jm2 = await join(eMod.joinCode, 'M2'); await upload(jm2.json.sessionToken);
  const pid2 = dbq(`SELECT id FROM photos WHERE event_id='${eMod.id}' AND status='pending'`);
  await api('POST', `/api/events/${eMod.joinCode}/moderate`, { headers: org(eMod.organizerCode), body: { photoIds: [pid2], action: 'reject' } });
  // Reject now bins (recoverable), not hard-delete: row kept as 'rejected' and excluded from the gallery.
  ok('rejected → status rejected (row kept)', dbq(`SELECT status FROM photos WHERE id='${pid2}'`) === 'rejected');
  ok('rejected photo not in gallery', (await gallery(eMod.joinCode)).json?.photos?.length === 1);
  // restore (approve) brings it back
  await api('POST', `/api/events/${eMod.joinCode}/moderate`, { headers: org(eMod.organizerCode), body: { photoIds: [pid2], action: 'approve' } });
  ok('restore → status approved', dbq(`SELECT status FROM photos WHERE id='${pid2}'`) === 'approved');
  // instant forces moderation off
  const eInstMod = await createEvent({ revealMode: 'instant', moderationEnabled: true });
  ok('instant clamps moderation off', dbq(`SELECT moderation_enabled FROM events WHERE id='${eInstMod.id}'`) === 'f');
}, {});

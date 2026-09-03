// Snapdini integration spec — 'Instant reveal + capture flow', 'At-the-end reveal + delay', 'Ending-timing precision', 'World timezones', 'Multi-event isolation', 'New features (regression)', 'Session features: no-flash, restore, own-gallery, share-reveal, billing tier, slideshow download'.
//
// Held together by design: `e1` (the two-guest/two-photo event built by 'Instant reveal +
// capture flow') is asserted on again by 'Multi-event isolation', 'New features' and 'Session
// features'; `billOn` is read in 'New features' and reused in 'Session features'; and
// 'Multi-event isolation' asserts >= 12 events exist in the process, which the at-end,
// ending-timing and world-timezone groups supply (13). Splitting any of it would break a
// dependency, so it stays one file.
import { BASE, HOUR, api, createEvent, createdJoinCodes, dbq, gallery, group, join, ok, org, spec, upload } from '../lib/harness.mjs';

await spec('02-core-features', async () => {
  // ── Instant reveal + basic flow + DB ──
  group('Instant reveal + capture flow');
  const e1 = await createEvent({ revealMode: 'instant', maxPhotos: 6, aspectRatios: ['1:1', '4:5'] });
  ok('event row created', !!e1.id);
  ok('DB reveal_mode=instant', dbq(`SELECT reveal_mode FROM events WHERE id='${e1.id}'`) === 'instant');
  ok('DB max_photos=6', dbq(`SELECT max_photos FROM events WHERE id='${e1.id}'`) === '6');
  ok('DB aspect_ratios persisted', dbq(`SELECT aspect_ratios FROM events WHERE id='${e1.id}'`).includes('4:5'));
  const j1 = await join(e1.joinCode, 'Alice');
  const j2 = await join(e1.joinCode, 'Bob');
  ok('two joins ok', j1.status === 200 && j2.status === 200);
  ok('DB participants=2', dbq(`SELECT count(*) FROM participants WHERE event_id='${e1.id}'`) === '2');
  const u1 = await upload(j1.json.sessionToken);
  await upload(j2.json.sessionToken);
  ok('upload ok', u1.status === 200);
  // New model: uploads always store 'pending'; visibility is gated by the moderation SETTING
  // (this event has moderation off, so the pending photos still show in the gallery — see below).
  ok('DB photos=2 pending', dbq(`SELECT count(*) FROM photos WHERE event_id='${e1.id}' AND status='pending'`) === '2');
  ok('photos_taken incremented', dbq(`SELECT photos_taken FROM participants WHERE event_id='${e1.id}' AND name='Alice'`) === '1');
  const g1 = await gallery(e1.joinCode);
  ok('instant gallery revealed', g1.json?.revealed === true);
  ok('instant gallery shows 2 photos', g1.json?.photos?.length === 2);
  ok('view: photo has url+thumbUrl+participantName', !!g1.json.photos[0].url && !!g1.json.photos[0].thumbUrl && !!g1.json.photos[0].participantName);

  // ── At-end reveal + delay + reveal-at math ──
  group('At-the-end reveal + delay');
  const past = Date.now() - 2 * HOUR;
  const eEnded = await createEvent({ revealMode: 'at_end', startsAt: past, durationHours: 1, revealDelayHours: 0 }); // expired 1h ago, delay 0
  ok('at_end + expired + delay0 → revealed', (await gallery(eEnded.joinCode)).json?.revealed === true);
  const eDelay = await createEvent({ revealMode: 'at_end', startsAt: past, durationHours: 1, revealDelayHours: 24 }); // expired, but 24h delay
  const gd = await gallery(eDelay.joinCode);
  const expectedRevealAt = (past + 1 * HOUR) + 24 * HOUR;
  ok('at_end + delay not yet → hidden', gd.json?.revealed === false);
  ok('revealAt = expiresAt + delay', gd.json?.revealAt === expectedRevealAt, `${gd.json?.revealAt} vs ${expectedRevealAt}`);
  const eOngoing = await createEvent({ revealMode: 'at_end', startsAt: Date.now(), durationHours: 24 });
  ok('at_end ongoing → hidden', (await gallery(eOngoing.joinCode)).json?.revealed === false);

  // ── Ending-timing precision (validate events end exactly at expiresAt) ──
  group('Ending-timing precision');
  const justExpired = await createEvent({ startsAt: Date.now() - HOUR - 60_000, durationHours: 1 }); // ended 1 min ago
  ok('just-expired isExpired=true', (await api('GET', `/api/events/${justExpired.joinCode}`)).json?.isExpired === true);
  ok('just-expired join → 410', (await join(justExpired.joinCode, 'JE')).status === 410);
  const justActive = await createEvent({ startsAt: Date.now() - HOUR + 120_000, durationHours: 1 }); // ends in ~2 min
  ok('just-active isExpired=false', (await api('GET', `/api/events/${justActive.joinCode}`)).json?.isExpired === false);
  ok('just-active join → 200', (await join(justActive.joinCode, 'JA')).status === 200);
  const atEndJust = await createEvent({ revealMode: 'at_end', startsAt: Date.now() - HOUR - 5_000, durationHours: 1, revealDelayHours: 0 });
  ok('at_end just-past-expiry → revealed', (await gallery(atEndJust.joinCode)).json?.revealed === true);
  const atEndSoon = await createEvent({ revealMode: 'at_end', startsAt: Date.now() - HOUR + 90_000, durationHours: 1, revealDelayHours: 0 });
  ok('at_end not-yet-ended → hidden', (await gallery(atEndSoon.joinCode)).json?.revealed === false);

  // ── World timezones (timing is absolute epoch; tz is display only) ──
  group('World timezones');
  const epoch = Date.UTC(2031, 5, 1, 18, 30, 0);
  for (const z of ['Australia/Brisbane', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'America/New_York']) {
    const e = await createEvent({ timezone: z, startsAt: epoch, durationHours: 3 });
    ok(`tz ${z} persisted`, dbq(`SELECT timezone FROM events WHERE id='${e.id}'`) === z);
    ok(`tz ${z} timing absolute (starts_at=epoch)`, dbq(`SELECT starts_at FROM events WHERE id='${e.id}'`) === String(epoch));
    ok(`tz ${z} getEvent returns zone`, (await api('GET', `/api/events/${e.joinCode}`)).json?.timezone === z);
  }

  // ── Multiple-event isolation ──
  group('Multi-event isolation');
  ok('created many events this run', createdJoinCodes.length >= 12);
  ok('e1 gallery unaffected by other events', (await gallery(e1.joinCode)).json?.photos?.length === 2);

  group('New features (regression)');
  // Event blurb persists on create + via settings, exposed on the public event.
  const eB = await createEvent({ blurb: 'Snap away!' });
  ok('blurb stored on create', (await api('GET', `/api/events/${eB.joinCode}`)).json?.blurb === 'Snap away!');
  await api('PUT', `/api/events/${eB.joinCode}/settings`, { headers: org(eB.organizerCode), body: { blurb: 'Updated blurb' } });
  ok('blurb editable via settings', (await api('GET', `/api/events/${eB.joinCode}`)).json?.blurb === 'Updated blurb');

  // Duration is a paid entitlement — settings can't extend it (closed free-extend hole).
  const eD = await createEvent({ durationHours: 24, startsAt: Date.now() });
  const expBefore = dbq(`SELECT expires_at FROM events WHERE join_code='${eD.joinCode}'`);
  await api('PUT', `/api/events/${eD.joinCode}/settings`, { headers: org(eD.organizerCode), body: { durationHours: 168 } });
  ok('settings cannot extend duration', dbq(`SELECT expires_at FROM events WHERE join_code='${eD.joinCode}'`) === expBefore);

  // Reveal "Hide photos" override works even on an ended at_end event.
  const eHide = await createEvent({ revealMode: 'at_end', startsAt: past, durationHours: 1, revealDelayHours: 0 }); // ended
  ok('ended at_end event auto-revealed', (await gallery(eHide.joinCode)).json?.revealed === true);
  await api('POST', `/api/events/${eHide.joinCode}/unreveal`, { headers: org(eHide.organizerCode) });
  ok('hide override hides an ended event', (await gallery(eHide.joinCode)).json?.revealed === false);
  await api('POST', `/api/events/${eHide.joinCode}/reveal`, { headers: org(eHide.organizerCode) });
  ok('reveal clears the hide override', (await gallery(eHide.joinCode)).json?.revealed === true);

  // /mine returns owned events with REAL counts (regression: was returning 0/0).
  const mine = await api('GET', '/api/events/mine');
  const e1row = mine.json?.events?.find((e) => e.joinCode === e1.joinCode);
  ok('/mine reflects real counts (e1 = 2 guests / 2 photos)', !!e1row && e1row.participantCount === 2 && e1row.photoCount === 2);

  // Client-error capture: public POST stores; admin list is gated.
  ok('client-error accepts a report', (await api('POST', '/api/client-error', { body: { message: 'regression test', context: 'upload' } })).status === 200);
  ok('client-error stored', Number(dbq(`SELECT count(*) FROM client_errors WHERE message='regression test'`)) >= 1);
  ok('admin client-errors gated', [401, 403].includes((await api('GET', '/api/admin/client-errors')).status));

  // Custom slideshow audio rejects a non-audio file (MIME/extension filter is spoofable, so the
  // server ffprobe-validates it has a real audio stream).
  const badAudio = new FormData();
  badAudio.append('audio', new Blob(['definitely not audio'], { type: 'audio/mpeg' }), 'fake.mp3');
  const ba = await fetch(`${BASE}/api/events/${eB.joinCode}/slideshow-audio`, { method: 'POST', headers: org(eB.organizerCode), body: badAudio });
  ok('custom audio rejects a non-audio file', ba.status === 400);

  // Share links — whole gallery + hand-picked subset (visibility-gated, newest-first).
  const eS = await createEvent({ revealMode: 'instant' });
  const jS = await join(eS.joinCode, 'Sam');
  await upload(jS.json.sessionToken); await upload(jS.json.sessionToken);
  const shareAll = await api('POST', `/api/events/${eS.joinCode}/shares`, { headers: org(eS.organizerCode), body: { kind: 'all' } });
  ok('create share (all)', shareAll.status === 200 && !!shareAll.json.token);
  const viewAll = await api('GET', `/api/shares/${shareAll.json.token}`);
  ok('share (all) shows all photos + event', viewAll.json?.photos?.length === 2 && !!viewAll.json?.event?.name);
  const shareSel = await api('POST', `/api/events/${eS.joinCode}/shares`, { headers: org(eS.organizerCode), body: { kind: 'selected', photoIds: [viewAll.json.photos[0].id] } });
  ok('share (selected) shows the subset', (await api('GET', `/api/shares/${shareSel.json.token}`)).json?.photos?.length === 1);
  ok('share selected needs ids', (await api('POST', `/api/events/${eS.joinCode}/shares`, { headers: org(eS.organizerCode), body: { kind: 'selected', photoIds: [] } })).status === 400);
  ok('invalid share token 404s', (await api('GET', '/api/shares/doesnotexist')).status === 404);

  // Enabling moderation AFTER photos exist holds the (pending) photos out of the gallery.
  const eM2 = await createEvent({ revealMode: 'manual' });
  const jM2 = await join(eM2.joinCode, 'Mo');
  await upload(jM2.json.sessionToken);
  await api('PUT', `/api/events/${eM2.joinCode}/settings`, { headers: org(eM2.organizerCode), body: { moderationEnabled: true, revealMode: 'manual' } });
  await api('POST', `/api/events/${eM2.joinCode}/reveal`, { headers: org(eM2.organizerCode) });
  ok('moderation enabled later holds existing photos', (await gallery(eM2.joinCode)).json?.photos?.length === 0);

  // Favourite is decoupled from approval — favouriting a pending (moderated) photo must NOT publish it.
  const eDec = await createEvent({ revealMode: 'manual', moderationEnabled: true });
  const jDec = await join(eDec.joinCode, 'Dee');
  await upload(jDec.json.sessionToken);
  const decId = (await api('GET', `/api/photos/${eDec.joinCode}`, { headers: org(eDec.organizerCode) })).json.photos[0].id;
  await api('POST', `/api/events/${eDec.joinCode}/rate`, { headers: org(eDec.organizerCode), body: { photoId: decId, rating: 5 } });
  ok('favourite sets the rating', dbq(`SELECT rating FROM photos WHERE id='${decId}'`) === '5');
  ok('favourite does NOT approve (stays pending)', dbq(`SELECT status FROM photos WHERE id='${decId}'`) === 'pending');

  // Settings must not unlock the frame pack for free on a paid-tier event (billing-on only).
  const billOn = (await api('GET', '/api/config')).json?.billing?.billingEnabled;
  if (billOn) {
    const eFp = await createEvent({ aspectRatios: ['1:1'] });
    dbq(`UPDATE events SET guest_cap=25, amount_paid_cents=0, aspect_ratios='["1:1"]' WHERE join_code='${eFp.joinCode}'`);
    await api('PUT', `/api/events/${eFp.joinCode}/settings`, { headers: org(eFp.organizerCode), body: { aspectRatios: ['1:1', '9:16'] } });
    ok('settings cannot unlock frame pack unpaid', !dbq(`SELECT aspect_ratios FROM events WHERE join_code='${eFp.joinCode}'`).includes('9:16'));
  }

  group('Session features: no-flash, restore, own-gallery, share-reveal, billing tier, slideshow download');

  // No-flash event control: persists on create, exposed on the public event, defaults off.
  const eNF = await createEvent({ noFlash: true });
  ok('no_flash stored on create', dbq(`SELECT no_flash FROM events WHERE id='${eNF.id}'`) === 't');
  ok('no_flash exposed on public event', (await api('GET', `/api/events/${eNF.joinCode}`)).json?.noFlash === true);
  ok('no_flash defaults off', dbq(`SELECT no_flash FROM events WHERE id='${e1.id}'`) === 'f');
  // The camera reads noFlash from the join + /me responses — both must carry it.
  const jNF = await join(eNF.joinCode, 'NF');
  ok('no_flash on join response', jNF.json?.noFlash === true);
  ok('no_flash on /me response', (await api('GET', '/api/participants/me', { headers: { 'x-session-token': jNF.json.sessionToken } })).json?.noFlash === true);

  // Restore (moderate 'restore') returns a rejected photo to PENDING (re-enters the queue) — not approved.
  const eRes = await createEvent({ revealMode: 'manual', moderationEnabled: true });
  const jRes = await join(eRes.joinCode, 'Rr'); await upload(jRes.json.sessionToken);
  const resId = dbq(`SELECT id FROM photos WHERE event_id='${eRes.id}'`);
  await api('POST', `/api/events/${eRes.joinCode}/moderate`, { headers: org(eRes.organizerCode), body: { photoIds: [resId], action: 'reject' } });
  ok('reject → rejected', dbq(`SELECT status FROM photos WHERE id='${resId}'`) === 'rejected');
  await api('POST', `/api/events/${eRes.joinCode}/moderate`, { headers: org(eRes.organizerCode), body: { photoIds: [resId], action: 'restore' } });
  ok('restore → pending (re-enters queue)', dbq(`SELECT status FROM photos WHERE id='${resId}'`) === 'pending');
  ok('moderate rejects an unknown action', (await api('POST', `/api/events/${eRes.joinCode}/moderate`, { headers: org(eRes.organizerCode), body: { photoIds: [resId], action: 'bogus' } })).status === 400);

  // A participant ALWAYS sees their own photos — even pending under moderation, after reveal —
  // while the public gallery still hides them. (Regression: own pending vanished post-reveal.)
  const eOwn = await createEvent({ revealMode: 'manual', moderationEnabled: true });
  const jOwn = await join(eOwn.joinCode, 'Ow'); await upload(jOwn.json.sessionToken);
  await api('POST', `/api/events/${eOwn.joinCode}/reveal`, { headers: org(eOwn.organizerCode) });
  const ownView = await api('GET', `/api/photos/${eOwn.joinCode}`, { headers: { 'x-session-token': jOwn.json.sessionToken } });
  ok('own pending photo visible to its taker after reveal (moderation on)', ownView.json?.photos?.length === 1);
  ok('public gallery still hides the pending photo', ((await gallery(eOwn.joinCode)).json?.photos?.length ?? 0) === 0);

  // Share respects reveal: a share on a not-yet-revealed event shows a countdown, not the photos,
  // and the share download is blocked until reveal.
  const eSR = await createEvent({ revealMode: 'manual' });
  const jSR = await join(eSR.joinCode, 'Sr'); await upload(jSR.json.sessionToken);
  const shareSR = await api('POST', `/api/events/${eSR.joinCode}/shares`, { headers: org(eSR.organizerCode), body: { kind: 'all' } });
  const viewSR = await api('GET', `/api/shares/${shareSR.json.token}`);
  ok('share pre-reveal → revealed:false, no photos, count shown', viewSR.json?.revealed === false && (viewSR.json?.photos?.length ?? 0) === 0 && viewSR.json?.photoCount === 1);
  ok('share download blocked pre-reveal (403)', (await api('GET', `/api/shares/${shareSR.json.token}/download`)).status === 403);
  await api('POST', `/api/events/${eSR.joinCode}/reveal`, { headers: org(eSR.organizerCode) });
  ok('share post-reveal shows photos', (await api('GET', `/api/shares/${shareSR.json.token}`)).json?.photos?.length === 1);
  ok('share download 200 after reveal', (await api('GET', `/api/shares/${shareSR.json.token}/download`)).status === 200);

  // Slideshow download endpoint is organizer-gated and 404s an unknown render id.
  ok('slideshow download unknown id → 404', (await api('GET', `/api/events/${eSR.joinCode}/slideshow/nope/download`, { headers: org(eSR.organizerCode) })).status === 404);

  // Billing: the 11–15 free "limited" band is gone — 11+ guests is paid; ≤10 keeps free frames.
  if (billOn) {
    const q12 = await api('POST', '/api/billing/quote', { body: { maxGuests: 12, maxPhotos: 12, aspectRatios: ['1:1'] } });
    ok('12 guests → paid tier (no free 11–15 band)', q12.json?.tier === 'paid' && q12.json?.requiresPayment === true);
    const q12f = await api('POST', '/api/billing/quote', { body: { maxGuests: 12, maxPhotos: 12, aspectRatios: ['1:1', '9:16'] } });
    ok('12 guests + extra shapes → frame pack charged', q12f.json?.framePack === true && q12f.json?.frameCents > 0);
    const q8 = await api('POST', '/api/billing/quote', { body: { maxGuests: 8, maxPhotos: 12, aspectRatios: ['1:1', '9:16'] } });
    ok('≤10 guests → frames free', q8.json?.tier === 'free' && q8.json?.frameCents === 0);
    // 10-second video tier costs $2.
    const qV = await api('POST', '/api/billing/quote', { body: { maxGuests: 12, maxPhotos: 12, aspectRatios: ['1:1'], videoSeconds: 10 } });
    ok('10s video add-on = $2', qV.json?.videoSeconds === 10 && qV.json?.videoCents === 200);
    // Frame removal is ALWAYS paid on hosted: a frames-free slideshow is blocked (402) until bought.
    const eBr = await createEvent({ revealMode: 'instant' });
    const jBr = await join(eBr.joinCode, 'Br'); await upload(jBr.json.sessionToken);
    ok('slideshow branding:false blocked until paid (402)', (await api('POST', `/api/events/${eBr.joinCode}/slideshow`, { headers: org(eBr.organizerCode), body: { favouritesOnly: false, branding: false } })).status === 402);
    dbq(`UPDATE events SET branding_removal_paid=true WHERE id='${eBr.id}'`);
    ok('slideshow branding:false allowed once paid', (await api('POST', `/api/events/${eBr.joinCode}/slideshow`, { headers: org(eBr.organizerCode), body: { favouritesOnly: false, branding: false } })).status === 200);
  }
}, { clientErrors: true });

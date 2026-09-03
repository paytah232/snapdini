// Snapdini integration spec — 'Referral funnel + write-behind counters'.
//
// Sleeps out the write-behind counter flush window three times, so it is one of the slowest
// specs — kept on its own so it overlaps everything else.
import { api, createEvent, dbq, gallery, group, join, ok, org, session, spec, upload } from '../lib/harness.mjs';

await spec('03-referral-funnel', async () => {
  const ownerCookie = session.cookie;   // the verified owner session bootstrapOwner() left us in

  group('Referral funnel + write-behind counters');
  {
    const src = await createEvent({ revealMode: 'instant' });
    const tok = (await join(src.joinCode, 'Gallery Guest')).json?.sessionToken;
    if (tok) await upload(tok);

    // Referral click on an unknown code must be ignored, not stored or surfaced.
    const bogus = await api('POST', '/api/track/ref', { body: { ref: 'NOSUCHCODE' } });
    ok('unknown referral code is ignored, still 200', bogus.status === 200, `status ${bogus.status}`);

    // Counters are write-behind: nothing lands immediately.
    await api('POST', `/api/track/gallery/${src.joinCode}`);
    await api('POST', `/api/track/gallery/${src.joinCode}`);
    await api('POST', '/api/track/ref', { body: { ref: src.joinCode } });
    const immediate = Number(dbq(`SELECT gallery_views FROM events WHERE id='${src.id}'`));
    ok('counters do NOT write on the request path', immediate === 0, `saw ${immediate}`);

    // …and are coalesced into one additive update after the flush window.
    await new Promise((r) => setTimeout(r, 3500));   // dev COUNTER_FLUSH_MS=2500
    ok('gallery views land after the flush, coalesced',
       Number(dbq(`SELECT gallery_views FROM events WHERE id='${src.id}'`)) === 2,
       dbq(`SELECT gallery_views FROM events WHERE id='${src.id}'`));
    ok('referral click counted on the SOURCE event',
       Number(dbq(`SELECT referral_clicks FROM events WHERE id='${src.id}'`)) === 1,
       dbq(`SELECT referral_clicks FROM events WHERE id='${src.id}'`));

    // A shared-link page must never hand out the join code (that would let a viewer join and shoot),
    // so its referral link carries `s:<share token>` instead. Same attribution, no extra exposure.
    const refShare = await api('POST', `/api/events/${src.joinCode}/shares`, { headers: org(src.organizerCode), body: { kind: 'all' } });
    const stok = refShare.json?.token;
    ok('share created for share-token referral', !!stok, `status ${refShare.status}`);
    const sref = await api('POST', '/api/track/ref', { body: { ref: `s:${stok}` } });
    ok('share-token referral accepted', sref.status === 200, `status ${sref.status}`);
    ok('a share token that does not exist is ignored',
       (await api('POST', '/api/track/ref', { body: { ref: 's:nosuchsharetoken' } })).status === 200);
    await new Promise((r) => setTimeout(r, 3500));
    ok('share-token referral credits the same source event',
       Number(dbq(`SELECT referral_clicks FROM events WHERE id='${src.id}'`)) === 2,
       dbq(`SELECT referral_clicks FROM events WHERE id='${src.id}'`));

    // Photo counters are scoped to the event: ids from elsewhere must not be bumped.
    const other = await createEvent({ revealMode: 'instant' });
    const otherTok = (await join(other.joinCode, 'Other Guest')).json?.sessionToken;
    if (otherTok) await upload(otherTok);
    const otherPhoto = dbq(`SELECT id FROM photos WHERE event_id='${other.id}' LIMIT 1`);
    if (otherPhoto) {
      await api('POST', '/api/track/photos', { body: { joinCode: src.joinCode, kind: 'view', ids: [otherPhoto] } });
      await new Promise((r) => setTimeout(r, 3500));   // dev COUNTER_FLUSH_MS=2500
      ok('a photo from another event is NOT counted',
         Number(dbq(`SELECT view_count FROM photos WHERE id='${otherPhoto}'`)) === 0,
         dbq(`SELECT view_count FROM photos WHERE id='${otherPhoto}'`));
    }

    // The funnel endpoint reflects it (admin-only).
    const fLogin = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
      ? await api('POST', '/api/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } })
      : { status: 0 };
    if (fLogin.status === 200) {
      const f = await api('GET', '/api/admin/referral-funnel');
      ok('funnel endpoint returns totals', f.status === 200 && typeof f.json?.totals?.gallery_views !== 'undefined', `status ${f.status}`);
      ok('funnel lists the source gallery',
         (f.json?.sources || []).some((r) => r.join_code === src.joinCode), JSON.stringify(f.json?.sources || []).slice(0, 120));
      session.cookie = ownerCookie;
    }
  }
}, {});

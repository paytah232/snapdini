// Snapdini integration spec — 'Referral funnel + write-behind counters'.
//
// The counters here are write-behind: the request path touches memory only and a global interval
// timer (COUNTER_FLUSH_MS) writes the coalesced totals. That makes every assertion in this spec a
// timing question, and the old version answered it with three `setTimeout(3500)` against a 2500ms
// window — about a second of slack before an EXACT-equality read. It passed, but a busy box turned
// it red for a reason that had nothing to do with the product.
//
// Two different shapes of fix, because they are two different problems:
//   · "the total eventually reaches N" is a condition — POLL for it (`waitFor`), never sleep.
//   · "nothing has been written YET" is a genuine race against a timer nobody controls, so it is
//     probed against the flusher rather than against the clock. See probeWriteBehind() below.
import { adminLogin, api, createEvent, dbq, group, join, ok, org, session, spec, upload, waitFor } from '../lib/harness.mjs';

// Poll until a counter reaches `want`, then hand back what it actually read, so the assertion can
// still be an EXACT equality (a counter that overshoots is a bug, not a pass) and the failure
// message is the real value rather than a stale one.
async function counterReaches(sql, want, what) {
  const read = () => Number(dbq(sql));
  const v = await waitFor(() => { const n = read(); return n >= want ? n : false; }, what);
  return v === false ? read() : v;
}

// "Counters do NOT write on the request path" is an assertion that something has NOT happened yet,
// and read naively it is a bet on a timer: the flusher ticks on its own global schedule, so it can
// land between the track POST and the read through no fault of the request path. Reading `=== 0`
// immediately after the POSTs gave that bet zero margin.
//
// The well-formed version synchronises to the flusher first. Send one hit and wait for it to land:
// that means a tick has JUST fired, so the next is a whole window away. Fire the real hits inside
// that fresh window and read. If a tick still beats us the probe is inconclusive, not a failure —
// so re-synchronise and try again. A genuine write-through regression fails every attempt; a lost
// race does not survive three. Run against a THROWAWAY event so the retries cannot disturb the
// exact totals asserted on the source event.
async function probeWriteBehind(ev) {
  const q = `SELECT gallery_views FROM events WHERE id='${ev.id}'`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const base = Number(dbq(q));
    await api('POST', `/api/track/gallery/${ev.joinCode}`);
    if (await counterReaches(q, base + 1, 'the flusher to tick') !== base + 1) {
      return { ok: false, detail: 'the counter flusher never landed the sync hit' };
    }
    const settled = base + 1;
    await api('POST', `/api/track/gallery/${ev.joinCode}`);
    await api('POST', `/api/track/gallery/${ev.joinCode}`);
    const immediate = Number(dbq(q));
    if (immediate === settled) return { ok: true, detail: `unchanged at ${settled}` };
    if (attempt === 3) return { ok: false, detail: `${settled} -> ${immediate} on the request path, 3 of 3 attempts` };
    await counterReaches(q, settled + 2, 'the raced window to settle');
  }
}

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

    const probe = await probeWriteBehind(await createEvent({ revealMode: 'instant' }));
    ok('counters do NOT write on the request path', probe.ok, probe.detail);

    // …and are coalesced into one additive update after the flush window.
    await api('POST', `/api/track/gallery/${src.joinCode}`);
    await api('POST', `/api/track/gallery/${src.joinCode}`);
    await api('POST', '/api/track/ref', { body: { ref: src.joinCode } });
    const v1 = await counterReaches(`SELECT gallery_views FROM events WHERE id='${src.id}'`, 2, 'the gallery views to flush');
    ok('gallery views land after the flush, coalesced', v1 === 2, String(v1));
    const v2 = await counterReaches(`SELECT referral_clicks FROM events WHERE id='${src.id}'`, 1, 'the referral click to flush');
    ok('referral click counted on the SOURCE event', v2 === 1, String(v2));

    // A shared-link page must never hand out the join code (that would let a viewer join and shoot),
    // so its referral link carries `s:<share token>` instead. Same attribution, no extra exposure.
    const refShare = await api('POST', `/api/events/${src.joinCode}/shares`, { headers: org(src.organizerCode), body: { kind: 'all' } });
    const stok = refShare.json?.token;
    ok('share created for share-token referral', !!stok, `status ${refShare.status}`);
    const sref = await api('POST', '/api/track/ref', { body: { ref: `s:${stok}` } });
    ok('share-token referral accepted', sref.status === 200, `status ${sref.status}`);
    ok('a share token that does not exist is ignored',
       (await api('POST', '/api/track/ref', { body: { ref: 's:nosuchsharetoken' } })).status === 200);
    const v3 = await counterReaches(`SELECT referral_clicks FROM events WHERE id='${src.id}'`, 2, 'the share-token referral to flush');
    ok('share-token referral credits the same source event', v3 === 2, String(v3));

    // Photo counters are scoped to the event: ids from elsewhere must not be bumped.
    const other = await createEvent({ revealMode: 'instant' });
    const otherTok = (await join(other.joinCode, 'Other Guest')).json?.sessionToken;
    if (otherTok) await upload(otherTok);
    const otherPhoto = dbq(`SELECT id FROM photos WHERE event_id='${other.id}' LIMIT 1`);
    const srcPhoto  = dbq(`SELECT id FROM photos WHERE event_id='${src.id}' LIMIT 1`);
    if (otherPhoto && srcPhoto) {
      // Track BOTH ids in one call. The one that legitimately belongs to this gallery is the
      // barrier: flushCounters() writes every pending photo view in a single statement, so once
      // the legitimate count has landed, anything the request path accepted for the foreign photo
      // would have landed with it. A zero is then a fact about the scoping rather than a guess
      // about how long to sleep.
      await api('POST', '/api/track/photos', { body: { joinCode: src.joinCode, kind: 'view', ids: [otherPhoto, srcPhoto] } });
      const mine = await counterReaches(`SELECT view_count FROM photos WHERE id='${srcPhoto}'`, 1, 'the in-event photo view to flush');
      ok('a photo from this event IS counted', mine === 1, String(mine));
      const v4 = dbq(`SELECT view_count FROM photos WHERE id='${otherPhoto}'`);
      ok('a photo from another event is NOT counted', Number(v4) === 0, v4);
    }

    // The funnel endpoint reflects it (admin-only).
    const fLogin = await adminLogin();
    if (fLogin.status === 200) {
      const f = await api('GET', '/api/admin/referral-funnel');
      ok('funnel endpoint returns totals', f.status === 200 && typeof f.json?.totals?.gallery_views !== 'undefined', `status ${f.status}`);
      ok('funnel lists the source gallery',
         (f.json?.sources || []).some((r) => r.join_code === src.joinCode), JSON.stringify(f.json?.sources || []).slice(0, 120));
      session.cookie = ownerCookie;
    }
  }
}, {});

// Snapdini integration spec — 'nothing hands out a photo before the reveal'.
//
// /uploads is served by express.static with NO authentication (index.ts). That is a deliberate
// design — the path is <uuid>/<uuid>, unguessable — but it means the ONLY thing standing between a
// hidden event and its photos is that no endpoint ever hands out a filename before the reveal. A
// leaked URL is not a smaller problem than a leaked gallery; it is the same problem, permanently,
// because a URL can be forwarded and never expires.
//
// So this spec does not check "is the gallery empty". It checks that no filename, URL or thumbnail
// path appears ANYWHERE in what a stranger or another guest can reach while the event is hidden.
import { BASE, api, createEvent, dbq, group, ok, org, spec, img, session } from '../lib/harness.mjs';

const shoot = async (token) => {
  const fd = new FormData();
  fd.append('sessionToken', token);
  fd.append('photo', new Blob([img], { type: 'image/jpeg' }), 'p.jpg');
  return api('POST', '/api/photos', { body: fd });
};
const join = (code, name) => api('POST', '/api/participants', { body: { joinCode: code, name } });
// A stranger: no cookie, no token, nothing but the join code off a QR.
const bare = async (path) => {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, text: await r.text() };
};

await spec('97b-reveal-leak', async () => {
  group('Nothing hands out a photo before the reveal');
  {
    // at_end, ending far in the future: hidden, and no clock can rescue it.
    const ev = await createEvent({ revealMode: 'at_end', durationHours: 48 });
    const a = await join(ev.joinCode, 'Guest A');
    const tokenA = a.json?.sessionToken;
    const up = await shoot(tokenA);
    ok('a guest can shoot while the event is hidden', up.status === 200, `status ${up.status}`);

    // The real filename, straight from the database — this is what must never appear.
    const filename = dbq(`SELECT p.filename FROM photos p JOIN events e ON e.id = p.event_id
                          WHERE e.join_code = '${ev.joinCode}' LIMIT 1`).trim();
    ok('the file exists on disk and is servable', filename.length > 0, filename);
    const direct = await fetch(`${BASE}/uploads/${filename}`);
    ok('…and is reachable by anyone who has its URL — which is WHY the URL must not leak',
      direct.status === 200, `status ${direct.status}`);

    const leaks = (body, where) => {
      const hay = String(body);
      const bits = [filename, filename.split('/').pop(), filename.replace(/\.[a-z0-9]+$/i, '')];
      const found = bits.filter((b) => b && hay.includes(b));
      ok(`no filename leaks from ${where}`, found.length === 0, found.join(', ').slice(0, 80));
    };

    // Every surface a stranger can reach with just the join code.
    leaks((await bare(`/api/photos/${ev.joinCode}?gallery=true`)).text, 'the public gallery');
    leaks((await bare(`/api/events/${ev.joinCode}`)).text, 'the public event payload');
    leaks((await bare(`/gallery/${ev.joinCode}`)).text, 'the rendered gallery page');
    leaks((await bare(`/join/${ev.joinCode}`)).text, 'the rendered join page');

    // A SECOND guest, legitimately in the event, must not see the first one's shots.
    const b = await join(ev.joinCode, 'Guest B');
    const tokenB = b.json?.sessionToken;
    const asB = await api('GET', `/api/photos/${ev.joinCode}?sessionToken=${tokenB}`);
    leaks(JSON.stringify(asB.json ?? asB.text), 'another guest’s own-roll view');
    const meB = await api('GET', `/api/participants/me?sessionToken=${tokenB}`);
    leaks(JSON.stringify(meB.json ?? meB.text), 'another guest’s /me');

    // A share link made BEFORE the reveal must not become a back door.
    const share = await api('POST', `/api/events/${ev.joinCode}/shares`,
      { body: { label: 'early' }, headers: org(ev.organizerCode) });
    const token = share.json?.token || share.json?.share?.token;
    if (token) {
      leaks((await bare(`/api/shares/${token}`)).text, 'a share link opened early');
      leaks((await bare(`/s/${token}`)).text, 'the rendered share page');
    } else {
      ok('a share link could be made to test', false, JSON.stringify(share.json).slice(0, 90));
    }

    // The guest who TOOK it may always see their own — that is the product, not a leak.
    const asA = await api('GET', `/api/photos/${ev.joinCode}?sessionToken=${tokenA}`);
    ok('the shooter still sees their own roll before the reveal',
      JSON.stringify(asA.json ?? '').includes(filename.split('/').pop() ?? 'x'),
      `status ${asA.status}`);

    // The gallery-only link the host copies is just /gallery/<code> — no token, nothing extra — so
    // it can never out-rank the reveal. Asserted rather than assumed, because "a link that shows
    // the gallery" is exactly the shape of thing that grows a bypass later.
    const galleryOnly = await bare(`/api/photos/${ev.joinCode}?gallery=true`);
    const gj = JSON.parse(galleryOnly.text || '{}');
    ok('the gallery-only link answers, but hands over nothing',
      galleryOnly.status === 200 && gj.revealed === false && (gj.photos || []).length === 0,
      `status ${galleryOnly.status} revealed=${gj.revealed} photos=${(gj.photos || []).length}`);
  }

  // ── A photo held back by MODERATION must stay held back after the reveal ──
  group('Moderation survives the reveal');
  {
    // NOT 'instant' — that mode CLAMPS moderation off (see spec 08), so asking for both gives an
    // event with moderation disabled and a test that proves nothing. This is the combination a host
    // who wants to vet photos actually ends up with.
    const ev = await createEvent({ revealMode: 'manual', moderationEnabled: true });
    const g = await join(ev.joinCode, 'Guest');
    const token = g.json?.sessionToken;
    const up2 = await shoot(token);
    const filename = dbq(`SELECT p.filename FROM photos p JOIN events e ON e.id = p.event_id
                          WHERE e.join_code = '${ev.joinCode}' LIMIT 1`).trim();
    const status = dbq(`SELECT p.status FROM photos p JOIN events e ON e.id = p.event_id
                        WHERE e.join_code = '${ev.joinCode}' LIMIT 1`).trim();
    ok('a moderated upload starts pending', status === 'pending', status);
    // What the guest is TOLD must match the event they are in. Every photo is stored 'pending' so
    // that switching moderation on later still vets the shots already taken — but on an event with
    // moderation off that column must not surface as "waiting for approval", because it is not.
    ok('…and the guest is told it is waiting', up2.json?.pendingModeration === true,
      String(up2.json?.pendingModeration));
    // Reveal it — the photos are now "out", but an unapproved one must stay held back.
    await api('POST', `/api/events/${ev.joinCode}/reveal`, { headers: org(ev.organizerCode) });
    const pub = await bare(`/api/photos/${ev.joinCode}?gallery=true`);
    const pj = JSON.parse(pub.text || '{}');
    ok('the event really is revealed now', pj.revealed === true, String(pj.revealed));
    ok('but an unapproved photo is still not in the gallery',
      !pub.text.includes(filename.split('/').pop() ?? 'x'), pub.text.slice(0, 90));
    ok('and its file name leaked nowhere in that response', (pj.photos || []).length === 0,
      `${(pj.photos || []).length} photos`);
  }

  // ── A guest may zip their OWN roll before the reveal, and nothing else ──
  //
  // This is the one route that hands a non-organizer a file before the reveal, so it is the one
  // most worth pinning down. The zip stores its entry names uncompressed as
  // "<Event> - <Who> - <n>.<ext>", which means another guest's NAME appearing anywhere in the bytes
  // is proof their photo is in there — a stronger check than counting entries.
  group('The own-roll zip hands over the guest\u2019s own photos and no one else\u2019s');
  {
    const ev = await createEvent({ revealMode: 'at_end', durationHours: 48 });
    const a = await join(ev.joinCode, 'Zipper Ann');
    const b = await join(ev.joinCode, 'Zipper Bob');
    const tokenA = a.json?.sessionToken;
    const tokenB = b.json?.sessionToken;
    await shoot(tokenA);
    await shoot(tokenB);

    const dl = `/api/photos/${ev.joinCode}/download`;
    const zipBytes = async (path) => {
      const r = await fetch(`${BASE}${path}`);
      const body = Buffer.from(await r.arrayBuffer()).toString('latin1');
      return { status: r.status, body };
    };

    const mine = await zipBytes(`${dl}?sessionToken=${tokenA}`);
    ok('a guest can zip their own roll before the reveal', mine.status === 200, `status ${mine.status}`);
    ok('\u2026and their own photo is in it', mine.body.includes('Zipper Ann'), mine.body.slice(0, 60));
    ok('\u2026and the other guest\u2019s is not', !mine.body.includes('Zipper Bob'));

    // ids are a filter WITHIN the scope, never a way out of it: asking for the whole event, or
    // explicitly for the other guest's photo, still yields only your own.
    const bFile = dbq(`SELECT p.id FROM photos p
                       JOIN participants pa ON pa.id = p.participant_id
                       JOIN events e ON e.id = p.event_id
                       WHERE e.join_code = '${ev.joinCode}' AND pa.name = 'Zipper Bob' LIMIT 1`).trim();
    const grab = await zipBytes(`${dl}?sessionToken=${tokenA}&ids=${bFile}`);
    ok('naming another guest\u2019s photo id does not widen the scope',
      grab.status === 404 || !grab.body.includes('Zipper Bob'), `status ${grab.status}`);

    // No token, and a wrong token, must be indistinguishable — a different answer for a bad token
    // would confirm the event holds photos worth guessing at.
    const none = await zipBytes(dl);
    const wrong = await zipBytes(`${dl}?sessionToken=not-a-real-token`);
    ok('a stranger gets nothing', none.status === 403, `status ${none.status}`);
    ok('a wrong token gets nothing', wrong.status === 403, `status ${wrong.status}`);
    ok('\u2026and is told exactly what the stranger is told', none.body === wrong.body,
      `${none.body.slice(0, 40)} vs ${wrong.body.slice(0, 40)}`);

    // The host's switch still outranks the guest's session.
    await api('POST', `/api/events/${ev.joinCode}/allow-downloads`,
      { body: { allowDownloads: false }, headers: org(ev.organizerCode) });
    const off = await zipBytes(`${dl}?sessionToken=${tokenA}`);
    ok('turning downloads off stops the own-roll zip too', off.status === 403, `status ${off.status}`);
  }

  // ── The live heart counts must obey the same visibility rule as everything else ──
  //
  // A security audit found this endpoint scoping by EVENT alone: it never joined photos, so it
  // never applied the reveal or moderation rules, and a stranger holding only the join code could
  // read back the ids of photos hidden from them. No filename or /uploads path leaked and an id is
  // not a capability here — but ids are still something a hidden photo should not be handing out.
  group('Heart counts do not leak the photos they are counting');
  {
    const ev = await createEvent({ revealMode: 'at_end', durationHours: 48 });
    const a = await join(ev.joinCode, 'Hearty Ann');
    const b = await join(ev.joinCode, 'Hearty Bob');
    const tokenA = a.json?.sessionToken, tokenB = b.json?.sessionToken;
    await shoot(tokenA);
    await shoot(tokenB);

    const own = async (token) => (await api('GET', `/api/photos/${ev.joinCode}?sessionToken=${token}`)).json?.photos ?? [];
    const aPhoto = (await own(tokenA))[0]?.id;
    const bPhoto = (await own(tokenB))[0]?.id;
    ok('both guests have a shot to heart', !!aPhoto && !!bPhoto);

    // Each hearts their own — the only thing either can see before the reveal.
    for (const [tok, id] of [[tokenA, aPhoto], [tokenB, bPhoto]]) {
      const r = await api('POST', `/api/photos/${id}/heart`, { body: { sessionToken: tok, heart: true } });
      ok('a guest can heart their own shot before the reveal', r.status === 200, `status ${r.status}`);
    }

    const stranger = await api('GET', `/api/photos/${ev.joinCode}/hearts`);
    const sj = stranger.json ?? {};
    ok('a stranger is told nothing at all before the reveal',
      Object.keys(sj.hearts ?? {}).length === 0, JSON.stringify(sj).slice(0, 120));

    // And a guest sees their own, never the other guest's.
    const asA = (await api('GET', `/api/photos/${ev.joinCode}/hearts?sessionToken=${tokenA}`)).json ?? {};
    ok('a guest sees the count on their own shot', (asA.hearts ?? {})[aPhoto] === 1, JSON.stringify(asA).slice(0, 120));
    ok('\u2026and not the other guest\u2019s', !(bPhoto in (asA.hearts ?? {})));

    // Moderation is the other half of the rule: a rejected photo drops out of the counts.
    const mev = await createEvent({ revealMode: 'manual', moderationEnabled: true });
    const g = await join(mev.joinCode, 'Moderated');
    const gtok = g.json?.sessionToken;
    await shoot(gtok);
    const gPhoto = dbq(`SELECT p.id FROM photos p JOIN events e ON e.id=p.event_id
                        WHERE e.join_code='${mev.joinCode}' LIMIT 1`).trim();
    await api('POST', `/api/events/${mev.joinCode}/reveal`, { headers: org(mev.organizerCode) });
    await api('POST', `/api/events/${mev.joinCode}/moderate`,
      { body: { photoIds: [gPhoto], action: 'approve' }, headers: org(mev.organizerCode) });
    await api('POST', `/api/photos/${gPhoto}/heart`, { body: { sessionToken: gtok, heart: true } });
    const before = (await api('GET', `/api/photos/${mev.joinCode}/hearts`)).json ?? {};
    ok('an approved photo is counted', (before.hearts ?? {})[gPhoto] === 1, JSON.stringify(before).slice(0, 110));

    await api('POST', `/api/events/${mev.joinCode}/moderate`,
      { body: { photoIds: [gPhoto], action: 'reject' }, headers: org(mev.organizerCode) });
    const after = (await api('GET', `/api/photos/${mev.joinCode}/hearts`)).json ?? {};
    ok('a rejected photo stops being counted, and its id stops being handed out',
      !(gPhoto in (after.hearts ?? {})), JSON.stringify(after).slice(0, 110));
  }

  // ── Guest comments obey the same rules, and are OFF unless asked for ──
  group('Comments are opt-in, and cannot be read or written where the photo cannot be seen');
  {
    const ev = await createEvent({ revealMode: 'at_end', durationHours: 48 });
    const a = await join(ev.joinCode, 'Chatty Ann');
    const b = await join(ev.joinCode, 'Chatty Bob');
    const tokenA = a.json?.sessionToken, tokenB = b.json?.sessionToken;
    await shoot(tokenA);
    const aPhoto = dbq(`SELECT p.id FROM photos p JOIN participants pa ON pa.id=p.participant_id
                        WHERE pa.name='Chatty Ann' LIMIT 1`).trim();

    // OFF by default. This is the whole reason comments differ from hearts.
    ok('a new event has comments off',
      dbq(`SELECT comments_enabled FROM events WHERE id='${ev.id}'`).trim() === 'f');
    const refused = await api('POST', `/api/photos/${aPhoto}/comment`,
      { body: { sessionToken: tokenA, body: 'hello' } });
    ok('and posting is refused until the host opts in', refused.status === 403, `status ${refused.status}`);

    await api('PUT', `/api/events/${ev.joinCode}/settings`,
      { body: { commentsEnabled: true }, headers: org(ev.organizerCode) });
    ok('the host can switch them on',
      dbq(`SELECT comments_enabled FROM events WHERE id='${ev.id}'`).trim() === 't');

    const mine = await api('POST', `/api/photos/${aPhoto}/comment`,
      { body: { sessionToken: tokenA, body: 'my own shot' } });
    ok('a guest can comment on a photo they can see', mine.status === 200, `status ${mine.status}`);

    // Bob cannot see Ann's photo before the reveal, so he cannot comment on it or read its thread.
    const cross = await api('POST', `/api/photos/${aPhoto}/comment`,
      { body: { sessionToken: tokenB, body: 'peeking' } });
    ok('another guest cannot comment on a photo hidden from them before the reveal',
      cross.status === 404, `status ${cross.status}`);
    const bobReads = await api('GET', `/api/photos/${ev.joinCode}/comments?ids=${aPhoto}&sessionToken=${tokenB}`);
    ok('\u2026nor read its thread', Object.keys(bobReads.json?.comments ?? {}).length === 0,
      JSON.stringify(bobReads.json).slice(0, 110));
    const strangerReads = await api('GET', `/api/photos/${ev.joinCode}/comments?ids=${aPhoto}`);
    ok('and a stranger is told nothing at all',
      Object.keys(strangerReads.json?.comments ?? {}).length === 0,
      JSON.stringify(strangerReads.json).slice(0, 110));

    // Who may remove one.
    const cid = mine.json?.id;
    const bobDelete = await api('DELETE', `/api/photos/comments/${cid}`, { body: { sessionToken: tokenB } });
    ok('a third party cannot delete somebody else\u2019s comment', bobDelete.status === 404, `status ${bobDelete.status}`);
    const hostDelete = await api('DELETE', `/api/photos/comments/${cid}`, { headers: org(ev.organizerCode) });
    ok('the host can delete any comment on their event', hostDelete.status === 200, `status ${hostDelete.status}`);
    ok('and it is really gone', dbq(`SELECT count(*) FROM photo_comments WHERE id='${cid}'`).trim() === '0');

    // The text is stored exactly as typed — escaping belongs to the renderer, not the column.
    const raw = await api('POST', `/api/photos/${aPhoto}/comment`,
      { body: { sessionToken: tokenA, body: '<b>hi</b> & bye' } });
    ok('markup is stored verbatim, not half-sanitised on the way in',
      raw.json?.body === '<b>hi</b> & bye', JSON.stringify(raw.json?.body));

    const long = await api('POST', `/api/photos/${aPhoto}/comment`,
      { body: { sessionToken: tokenA, body: 'x'.repeat(5000) } });
    ok('an over-long comment is cut, not refused and not stored whole',
      long.status === 200 && (long.json?.body?.length ?? 0) <= 300, `len ${long.json?.body?.length}`);
  }

  group('An unmoderated event does not claim a photo is waiting');
  {
    const ev = await createEvent({ revealMode: 'instant' });
    const g = await join(ev.joinCode, 'Guest');
    const up = await shoot(g.json?.sessionToken);
    ok('the photo is stored pending, as every photo is',
      dbq(`SELECT p.status FROM photos p JOIN events e ON e.id = p.event_id
           WHERE e.join_code = '${ev.joinCode}' LIMIT 1`).trim() === 'pending');
    ok('but the guest is NOT told it is waiting for approval',
      up.json?.pendingModeration === false, String(up.json?.pendingModeration));
    const pub = await bare(`/api/photos/${ev.joinCode}?gallery=true`);
    ok('because it is already in the gallery', (JSON.parse(pub.text || '{}').photos || []).length === 1,
      pub.text.slice(0, 70));
  }
});

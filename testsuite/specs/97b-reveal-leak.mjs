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

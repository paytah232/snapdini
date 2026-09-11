// Snapdini integration spec — 'Photo missions: the host's list, the guest's card'.
//
// An event can carry several SETS of missions so a host hands out different cards — table A gets
// one list, table B another — which spreads coverage instead of producing forty photos of the same
// cake. The things that matter and are easy to get wrong:
//
//  • a guest sees exactly one set, and keeps it when they come back on another device;
//  • a guest cannot tag a photo with a mission from a card they were never handed, because that
//    text is shown as the photo's caption;
//  • progress is DERIVED from photos, so deleting one un-ticks its mission with nothing to drift;
//  • the mission becomes the photo's CAPTION everywhere the album is read — which is the whole
//    payoff of the feature, and is resolved from the event's list rather than the guest's card.
//
// SERIAL (9x- prefix): creates and removes its own events.
import { BASE, api, dbq, gallery, group, ok, session, spec, createEvent, org, upload, img } from '../lib/harness.mjs';

// The harness upload() carries no mission, so tagging needs its own form post.
const uploadFor = async (token, challengeId) => {
  const fd = new FormData();
  fd.append('sessionToken', token);
  if (challengeId !== undefined) fd.append('challengeId', challengeId);
  fd.append('photo', new Blob([img], { type: 'image/jpeg' }), 'p.jpg');
  return api('POST', '/api/photos', { body: fd });
};

const put = (code, orgCode, body) => api('PUT', `/api/events/${code}/challenges`, { body, headers: org(orgCode) });
const joinWith = (code, name, extra = {}) => api('POST', '/api/participants', { body: { joinCode: code, name, ...extra } });

await spec('98-photo-missions', async () => {
  const ownerCookie = session.cookie;

  group('Photo missions: one set');
  {
    const ev = await createEvent({ maxGuests: 10 });
    const saved = await put(ev.joinCode, ev.organizerCode, {
      eventType: 'wedding',
      challenges: [{ id: 'wed-first-dance', text: 'The couple’s first dance' },
                   { id: 'wed-cake', text: 'The cake, before it’s cut' }],
    });
    ok('a host can save a plain list', saved.status === 200, `status ${saved.status}`);
    ok('and it comes back as one set', saved.json?.sets?.length === 1 && saved.json.sets[0].items.length === 2,
      JSON.stringify(saved.json).slice(0, 120));

    const adm = await api('GET', `/api/events/${ev.joinCode}/admin`, { headers: org(ev.organizerCode) });
    ok('the organizer sees the event type they chose', adm.json?.eventType === 'wedding', String(adm.json?.eventType));
    ok('and the set', adm.json?.challengeSets?.[0]?.items?.length === 2, JSON.stringify(adm.json?.challengeSets || []).slice(0, 90));

    const g = await joinWith(ev.joinCode, 'Ana');
    ok('a guest is handed a card on join', g.json?.challengeSet === 'a', String(g.json?.challengeSet));
    ok('with the missions on it', g.json?.challenges?.length === 2, JSON.stringify(g.json?.challenges || []).slice(0, 90));
    ok('and nothing ticked off yet', Array.isArray(g.json?.challengesDone) && g.json.challengesDone.length === 0);

    const up = await uploadFor(g.json.sessionToken, undefined);
    ok('an untagged shot is accepted and ticks nothing', up.status === 200 &&
      dbq(`SELECT count(*) FROM photos WHERE participant_id='${g.json.participant.id}' AND challenge_id IS NULL`) === '1',
      `status ${up.status}`);

    const tag = await uploadFor(g.json.sessionToken, 'wed-cake');
    ok('a shot tagged with a mission ON their card is stored against it', tag.status === 200 &&
      dbq(`SELECT count(*) FROM photos WHERE participant_id='${g.json.participant.id}' AND challenge_id='wed-cake'`) === '1',
      `status ${tag.status}`);

    const me = await api('GET', '/api/participants/me', { headers: { 'x-session-token': g.json.sessionToken } });
    ok('progress is derived from the photos, not tracked separately',
      (me.json?.challengesDone || []).includes('wed-cake'), JSON.stringify(me.json?.challengesDone));

    // The guard that matters: the mission text becomes the photo's caption, so an unchecked value
    // would let a guest write arbitrary words under a photo.
    for (const bad of ['not-a-mission', 'wed-band', '../../etc', 'own-99', '']) {
      const r = await uploadFor(g.json.sessionToken, bad);
      ok(`"${bad || '(empty)'}" is refused as a mission and stored as none`, r.status === 200 &&
        dbq(`SELECT count(*) FROM photos WHERE participant_id='${g.json.participant.id}' AND challenge_id='${bad.replace(/'/g, "''")}'`) === '0',
        `status ${r.status}`);
    }

    // Derived means derived: remove the photo and the mission un-ticks with nothing to reconcile.
    dbq(`DELETE FROM photos WHERE participant_id='${g.json.participant.id}' AND challenge_id='wed-cake'`);
    const after = await api('GET', '/api/participants/me', { headers: { 'x-session-token': g.json.sessionToken } });
    ok('deleting the photo un-ticks its mission', !(after.json?.challengesDone || []).includes('wed-cake'),
      JSON.stringify(after.json?.challengesDone));

    dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);
  }

  group('Photo missions: several cards, one event');
  {
    const ev = await createEvent({ maxGuests: 10 });
    const r = await put(ev.joinCode, ev.organizerCode, {
      eventType: 'wedding',
      challenges: { sets: [
        { key: 'a', label: 'Table A', items: [{ id: 'wed-cake', text: 'The cake' }] },
        { key: 'b', label: 'Table B', items: [{ id: 'wed-band', text: 'The band, mid-song' }] },
      ] },
    });
    ok('both cards save', r.json?.sets?.length === 2, JSON.stringify(r.json?.sets || []).slice(0, 120));
    ok('each keeps the host’s own label', r.json.sets.map((s) => s.label).join('|') === 'Table A|Table B');

    // Round-robin, not random: several sets exist for even coverage, and random clusters.
    const a = await joinWith(ev.joinCode, 'One');
    const b = await joinWith(ev.joinCode, 'Two');
    const c = await joinWith(ev.joinCode, 'Three');
    ok('guests are spread across the cards', new Set([a, b, c].map((x) => x.json.challengeSet)).size === 2,
      [a, b, c].map((x) => x.json.challengeSet).join(','));
    ok('a guest is shown ONLY their own card',
      a.json.challenges.length === 1 && b.json.challenges.length === 1 &&
      a.json.challenges[0].id !== b.json.challenges[0].id,
      `${a.json.challenges[0]?.id} vs ${b.json.challenges[0]?.id}`);

    // A printed card can name its own set.
    const asked = await joinWith(ev.joinCode, 'Picky', { set: 'b' });
    ok('a card that names its set is honoured', asked.json.challengeSet === 'b', String(asked.json.challengeSet));
    const bogus = await joinWith(ev.joinCode, 'Bogus', { set: 'zz' });
    ok('an unknown set falls back rather than failing', !!bogus.json.challengeSet && bogus.json.challengeSet !== 'zz',
      String(bogus.json.challengeSet));

    // Their card survives coming back on another device.
    const again = await joinWith(ev.joinCode, 'Picky', { email: '' });
    ok('a returning guest keeps the card they were given',
      !again.json.recovered || again.json.challengeSet === 'b', String(again.json.challengeSet));

    dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);
  }

  group('Photo missions: what a host may save');
  {
    const ev = await createEvent({ maxGuests: 10 });
    const P = (c) => put(ev.joinCode, ev.organizerCode, { challenges: c });

    ok('a non-list is refused outright', (await P('nope')).status === 400);
    ok('an empty list clears the feature', (await P([])).json?.sets?.length === 0);

    const long = await P([{ id: 'own-1', text: 'x'.repeat(49) }]);
    ok('an over-long mission is dropped, not saved', long.json.sets.length === 0, JSON.stringify(long.json.sets));

    const dupes = await P([{ id: 'own-1', text: 'One' }, { id: 'own-1', text: 'Two' }]);
    ok('a duplicate id is dropped — ids tag photos', dupes.json.sets[0].items.length === 1);

    const messy = await P([{ id: 'own-1', text: '  spaced   out  ' }, { id: 'BAD ID', text: 'x' }, { nope: 1 }]);
    ok('whitespace is tidied for the card', messy.json.sets[0].items[0].text === 'spaced out', messy.json.sets[0].items[0].text);
    ok('malformed entries are dropped without losing the good ones', messy.json.sets[0].items.length === 1);

    const many = await P(Array.from({ length: 30 }, (_, i) => ({ id: `own-${i + 1}`, text: `Mission ${i + 1}` })));
    ok('the list is capped at 20', many.json.sets[0].items.length === 20, String(many.json.sets[0].items.length));

    const lots = await put(ev.joinCode, ev.organizerCode, {
      challenges: { sets: Array.from({ length: 12 }, (_, i) => ({ key: `s${i}`, label: `S${i}`, items: [{ id: 'own-1', text: 'x' }] })) },
    });
    ok('the number of cards is capped at 8', lots.json.sets.length === 8, String(lots.json.sets.length));

    ok('a bad event type is stored as none rather than rejected',
      (await put(ev.joinCode, ev.organizerCode, { eventType: 'Not A Type!', challenges: [] })).status === 200);
    ok('and reads back as null',
      dbq(`SELECT coalesce(event_type,'NULL') FROM events WHERE join_code='${ev.joinCode}'`) === 'NULL');

    // The harness attaches the owner's cookie to everything, so a real stranger needs a bare fetch.
    const strangerRes = await fetch(`${BASE}/api/events/${ev.joinCode}/challenges`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenges: [] }) });
    ok('a stranger with no credentials cannot set them', strangerRes.status === 404 || strangerRes.status === 401,
      `status ${strangerRes.status}`);

    dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);
  }

  group('Photo missions: the caption in the gallery');
  {
    const ev = await createEvent({ maxGuests: 10 });
    await put(ev.joinCode, ev.organizerCode, { eventType: 'wedding', challenges: { sets: [
      { key: 'a', label: 'Table A', items: [{ id: 'wed-cake', text: 'The cake, before it’s cut' }] },
      { key: 'b', label: 'Table B', items: [{ id: 'wed-band', text: 'The band, mid-song' }] },
    ] } });

    const ana = await joinWith(ev.joinCode, 'Ana', { set: 'a' });
    const ben = await joinWith(ev.joinCode, 'Ben', { set: 'b' });
    await uploadFor(ana.json.sessionToken, 'wed-cake');
    await uploadFor(ana.json.sessionToken, undefined);
    await uploadFor(ben.json.sessionToken, 'wed-band');

    const caps = (r) => (r.json?.photos || []).map((p) => p.challenge);

    const gal = await gallery(ev.joinCode);
    ok('a tagged shot is captioned with the host’s own wording',
      caps(gal).includes('The cake, before it’s cut'), JSON.stringify(caps(gal)));
    ok('an untagged shot has no caption rather than an empty one',
      caps(gal).filter((c) => c === null).length === 1, JSON.stringify(caps(gal)));

    // Resolved from the EVENT's whole list, not one guest's card: a host reviewing an event with
    // several cards out would otherwise get captions on only the fraction of the album that
    // happened to match whichever card resolved first.
    const rev = await api('GET', `/api/photos/${ev.joinCode}`, { headers: org(ev.organizerCode) });
    ok('the host’s review list captions shots from every card',
      caps(rev).filter(Boolean).sort().join('|') === 'The band, mid-song|The cake, before it’s cut',
      JSON.stringify(caps(rev)));

    const mine = await api('GET', `/api/photos/${ev.joinCode}`, { headers: { 'x-session-token': ana.json.sessionToken } });
    ok('a guest’s gallery is captioned too',
      caps(mine).includes('The band, mid-song'), JSON.stringify(caps(mine)));

    // A share link is the copy that actually leaves the event, so the annotation has to travel.
    const sh = await api('POST', `/api/events/${ev.joinCode}/shares`, { body: { kind: 'all' }, headers: org(ev.organizerCode) });
    const shared = await api('GET', `/api/shares/${sh.json.token}`);
    ok('a shared gallery carries the captions',
      caps(shared).includes('The cake, before it’s cut'), JSON.stringify(caps(shared)));

    // Wording lives on the event, so a mission the host later removed leaves photos pointing at an
    // id with nothing behind it. An uncaptioned photo is fine; `wed-gone` under someone's photo is
    // not — a raw slug is a bug wearing a caption's clothes.
    dbq(`UPDATE photos SET challenge_id='wed-gone' WHERE event_id='${ev.id}' AND challenge_id='wed-cake'`);
    const stale = await gallery(ev.joinCode);
    ok('a mission the host has since deleted degrades to no caption, not a raw id',
      !JSON.stringify(caps(stale)).includes('wed-gone') && caps(stale).filter((c) => c === null).length === 2,
      JSON.stringify(caps(stale)));

    dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);

    // A guest's own roll before the reveal is where missions are actually ticked off, and it is its
    // own query — so it gets its own proof.
    const hidden = await createEvent({ maxGuests: 10, revealMode: 'manual' });
    await put(hidden.joinCode, hidden.organizerCode, { challenges: [{ id: 'own-1', text: 'Something blue' }] });
    const zoe = await joinWith(hidden.joinCode, 'Zoe');
    await uploadFor(zoe.json.sessionToken, 'own-1');
    const roll = await api('GET', `/api/photos/${hidden.joinCode}`, { headers: { 'x-session-token': zoe.json.sessionToken } });
    ok('a guest’s own roll is captioned before the gallery is revealed',
      roll.json?.revealed === false && caps(roll).includes('Something blue'),
      `revealed ${roll.json?.revealed} ${JSON.stringify(caps(roll))}`);

    dbq(`DELETE FROM events WHERE join_code='${hidden.joinCode}'`);
  }

  group('Photo missions: the card in your hand matches the list in the app');
  {
    // The point of printing several cards is that each table hunts for different things. That only
    // holds if a card's QR carries its own set — otherwise the guest gets round-robin and the card
    // in their hand can disagree with their app.
    const ev = await createEvent({ maxGuests: 10 });
    await put(ev.joinCode, ev.organizerCode, { eventType: 'wedding', challenges: { sets: [
      { key: 'a', label: 'Table A', items: [{ id: 'wed-cake', text: 'The cake' }] },
      { key: 'b', label: 'Table B', items: [{ id: 'wed-band', text: 'The band, mid-song' }] },
    ] } });

    const plain = await api('GET', `/api/events/${ev.joinCode}/qr?print=1`);
    ok('the plain event QR names no set', !/[?&]set=/.test(plain.json?.joinUrl || ''), plain.json?.joinUrl);
    const qrB = await api('GET', `/api/events/${ev.joinCode}/qr?print=1&set=b`);
    ok('the Table B card’s QR encodes set=b', (qrB.json?.joinUrl || '').endsWith('?set=b'), qrB.json?.joinUrl);
    // A typo here would be printed onto every card before anyone noticed, so it must fail at the
    // endpoint rather than at the table.
    const qrBad = await api('GET', `/api/events/${ev.joinCode}/qr?print=1&set=zz`);
    ok('an unknown set never reaches a printed QR', !/[?&]set=/.test(qrBad.json?.joinUrl || ''), qrBad.json?.joinUrl);

    const gb = await joinWith(ev.joinCode, 'TableB', { set: 'b' });
    ok('scanning the B card hands over the B list',
      gb.json?.challengeSet === 'b' && gb.json?.challenges?.[0]?.id === 'wed-band',
      `${gb.json?.challengeSet} ${JSON.stringify(gb.json?.challenges)}`);

    dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);
  }

  session.cookie = ownerCookie;
}, {});

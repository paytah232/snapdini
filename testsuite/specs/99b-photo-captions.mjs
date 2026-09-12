// Snapdini integration spec — 'Photo captions: the words under a photo'.
//
// A caption is the one part of a photo that is TEXT someone chose, which makes it the one part that
// can be wrong in a way a rating never can. The things that matter and are easy to get wrong:
//
//  • only two people may write one: the guest who took the shot, and the event's organizer. Another
//    guest at the same event is a stranger here;
//  • a photo you may not touch answers 404, not 403 — the API must not confirm that someone else's
//    photo id exists;
//  • blank clears. Clearing and "saving nothing" are the same action, and the result is NULL rather
//    than '', so "has a caption" stays one test everywhere;
//  • an over-long caption is CUT, never rejected — bouncing a guest's sentence back at them at a
//    party is a worse product than keeping the first 140 characters;
//  • a captioned trick shot keeps BOTH. The caption is a second field beside `challenge`, so the
//    mission attribution survives someone writing their own words on a mission photo.
//
// SERIAL (9x- prefix): creates and removes its own events.
import { api, dbq, gallery, group, ok, session, spec, createEvent, org, img } from '../lib/harness.mjs';

// The harness upload() carries no mission, so a trick shot needs its own form post.
const uploadFor = async (token, challengeId) => {
  const fd = new FormData();
  fd.append('sessionToken', token);
  if (challengeId !== undefined) fd.append('challengeId', challengeId);
  fd.append('photo', new Blob([img], { type: 'image/jpeg' }), 'p.jpg');
  return api('POST', '/api/photos', { body: fd });
};
const joinWith = (code, name, extra = {}) => api('POST', '/api/participants', { body: { joinCode: code, name, ...extra } });
const putCaption = (photoId, body, headers = {}) => api('PUT', `/api/photos/${photoId}/caption`, { body, headers });
// NULL and '' must never be confused here — the whole point of the column is that only one of them
// is a legal "no caption" — so read the raw value with an unambiguous marker for each.
const stored = (photoId) => dbq(`SELECT coalesce(caption, '<NULL>') FROM photos WHERE id='${photoId}'`);

await spec('99b-photo-captions', async () => {
  const ownerCookie = session.cookie;

  group('Photo captions: the guest who took the shot');
  {
    const ev = await createEvent({ maxGuests: 10 });
    const ana = await joinWith(ev.joinCode, 'Ana');
    const shot = await uploadFor(ana.json.sessionToken, undefined);
    const id = shot.json.photoId;

    const set = await putCaption(id, { sessionToken: ana.json.sessionToken, caption: 'Dad dancing, 11pm' });
    ok('the guest who took it can write a caption', set.status === 200 && set.json?.caption === 'Dad dancing, 11pm',
      `status ${set.status} ${JSON.stringify(set.json)}`);
    ok('and it is what is stored', stored(id) === 'Dad dancing, 11pm', stored(id));

    const edited = await putCaption(id, { sessionToken: ana.json.sessionToken, caption: 'Dad dancing, 11:30pm' });
    ok('and change it afterwards', edited.json?.caption === 'Dad dancing, 11:30pm' && stored(id) === 'Dad dancing, 11:30pm',
      `${edited.json?.caption} / ${stored(id)}`);

    const cleared = await putCaption(id, { sessionToken: ana.json.sessionToken, caption: '' });
    ok('an empty caption clears it', cleared.status === 200 && cleared.json?.caption === null,
      `status ${cleared.status} ${JSON.stringify(cleared.json)}`);
    // '' would render as an empty caption strip under the photo and would make every "has a
    // caption" test two tests instead of one.
    ok('and clears it to NULL, not to an empty string', stored(id) === '<NULL>', stored(id));

    const blank = await putCaption(id, { sessionToken: ana.json.sessionToken, caption: '   \n\t  ' });
    ok('a whitespace-only caption clears it too', blank.json?.caption === null && stored(id) === '<NULL>',
      `${JSON.stringify(blank.json)} / ${stored(id)}`);

    const messy = await putCaption(id, { sessionToken: ana.json.sessionToken, caption: '  the   cake\n\nwas   real  ' });
    ok('whitespace is collapsed and trimmed, not stored as typed', messy.json?.caption === 'the cake was real', JSON.stringify(messy.json));

    // A phone keyboard will produce this eventually. Refusing it loses the sentence; cutting it
    // keeps what they meant to say.
    const long = await putCaption(id, { sessionToken: ana.json.sessionToken, caption: 'x'.repeat(400) });
    ok('an over-long caption is cut to 140, not rejected',
      long.status === 200 && long.json?.caption?.length === 140 && stored(id).length === 140,
      `status ${long.status} len ${long.json?.caption?.length}`);
    ok('and the response says exactly what was kept', long.json.caption === stored(id));

    dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);
  }

  group('Photo captions: who may not write one');
  {
    const ev = await createEvent({ maxGuests: 10 });
    const ana = await joinWith(ev.joinCode, 'Ana');
    const ben = await joinWith(ev.joinCode, 'Ben');
    const shot = await uploadFor(ana.json.sessionToken, undefined);
    const id = shot.json.photoId;
    await putCaption(id, { sessionToken: ana.json.sessionToken, caption: 'Ana wrote this' });

    // 404 rather than 403 throughout: a 403 would confirm to Ben that this photo id exists and is
    // somebody else's, which is not his business. Same reasoning as DELETE /api/photos/:id.
    for (const [what, body] of [
      ['write over', { sessionToken: ben.json.sessionToken, caption: 'Ben wrote this' }],
      ['clear',      { sessionToken: ben.json.sessionToken, caption: '' }],
    ]) {
      const r = await putCaption(id, body);
      ok(`another guest cannot ${what} someone else's caption`, r.status === 404, `status ${r.status}`);
    }
    ok('and the original survives all of it', stored(id) === 'Ana wrote this', stored(id));

    const none = await putCaption(id, { caption: 'nobody in particular' });
    ok('a caller with no credentials at all gets 404, not 401', none.status === 404, `status ${none.status}`);

    const wrongCode = await putCaption(id, { caption: 'wrong code' }, org('deadbeef'.repeat(4)));
    ok('a bogus organizer code gets 404 too', wrongCode.status === 404, `status ${wrongCode.status}`);

    // An organizer code is a capability for ONE event. Held against a photo in a different event it
    // is just a stranger's string.
    const other = await createEvent({ maxGuests: 10 });
    const crossed = await putCaption(id, { caption: 'from next door' }, org(other.organizerCode));
    ok("another event's organizer code is not a key to this one", crossed.status === 404, `status ${crossed.status}`);
    ok('and nothing any of them sent was written', stored(id) === 'Ana wrote this', stored(id));

    const gone = await putCaption('00000000-0000-0000-0000-000000000000',
      { sessionToken: ana.json.sessionToken, caption: 'nothing here' });
    ok('a photo that does not exist answers the same 404', gone.status === 404, `status ${gone.status}`);

    dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);
    dbq(`DELETE FROM events WHERE join_code='${other.joinCode}'`);
  }

  group('Photo captions: the host');
  {
    const ev = await createEvent({ maxGuests: 10 });
    const ana = await joinWith(ev.joinCode, 'Ana');
    const shot = await uploadFor(ana.json.sessionToken, undefined);
    const id = shot.json.photoId;

    // The host curates the album and answers for what a shared gallery says, so they hold the same
    // pen as the guest — on any photo in their event, including ones they did not take. Captions
    // carry no author label, by design: they read as words about the photo, not as a quote.
    const wrote = await putCaption(id, { caption: 'The speech nobody expected' }, org(ev.organizerCode));
    ok('the organizer can caption a photo they did not take',
      wrote.status === 200 && stored(id) === 'The speech nobody expected', `status ${wrote.status} ${stored(id)}`);

    const edited = await putCaption(id, { caption: 'The speech nobody saw coming' }, org(ev.organizerCode));
    ok('and edit one that is already there', edited.json?.caption === 'The speech nobody saw coming', stored(id));

    // The reason the host has a pen at all: something offensive under a photo in a gallery they
    // have shared has to be removable by the person whose event it is.
    const cleared = await putCaption(id, { caption: '' }, org(ev.organizerCode));
    ok('and clear one', cleared.status === 200 && cleared.json?.caption === null && stored(id) === '<NULL>',
      `status ${cleared.status} ${stored(id)}`);

    // The code rides in the body as well as the header — older clients post it — so both doors work.
    const viaBody = await putCaption(id, { organizerCode: ev.organizerCode, caption: 'Via the body' });
    ok('the organizer code is accepted in the body as well as the header',
      viaBody.status === 200 && stored(id) === 'Via the body', `status ${viaBody.status} ${stored(id)}`);

    // A guest keeps their own pen regardless: the host writing does not take the photo off them.
    const backToAna = await putCaption(id, { sessionToken: ana.json.sessionToken, caption: 'Mine again' });
    ok('the guest can still rewrite their own after the host has been in',
      backToAna.status === 200 && stored(id) === 'Mine again', `status ${backToAna.status} ${stored(id)}`);

    dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);
  }

  group('Photo captions: a caption and a trick, on the same shot');
  {
    const ev = await createEvent({ maxGuests: 10 });
    await api('PUT', `/api/events/${ev.joinCode}/challenges`, {
      body: { eventType: 'wedding', challenges: [{ id: 'wed-cake', text: 'The cake, before it’s cut' }] },
      headers: org(ev.organizerCode),
    });
    const ana = await joinWith(ev.joinCode, 'Ana', { set: 'a' });
    const trick = await uploadFor(ana.json.sessionToken, 'wed-cake');
    const plain = await uploadFor(ana.json.sessionToken, undefined);
    await putCaption(trick.json.photoId, { sessionToken: ana.json.sessionToken, caption: 'Nobody saw me take this' });

    const find = (r, id) => (r.json?.photos || []).find((p) => p.id === id);

    // The payoff, and the reason caption is a SECOND field rather than a smarter `challenge`: a
    // guest writing their own words on a mission photo must not silently erase which mission it was.
    const gal = await gallery(ev.joinCode);
    const gt = find(gal, trick.json.photoId);
    ok('a captioned trick shot carries BOTH in the gallery payload',
      gt?.caption === 'Nobody saw me take this' && gt?.challenge === 'The cake, before it’s cut',
      JSON.stringify({ caption: gt?.caption, challenge: gt?.challenge }));
    const gp = find(gal, plain.json.photoId);
    ok('an uncaptioned shot reports caption null rather than omitting the field',
      gp !== undefined && 'caption' in gp && gp.caption === null, JSON.stringify(gp && { caption: gp.caption }));

    // Every surface that reads the album has to carry it, not just the guest gallery.
    const rev = await api('GET', `/api/photos/${ev.joinCode}`, { headers: org(ev.organizerCode) });
    ok("the host's review list carries the caption", find(rev, trick.json.photoId)?.caption === 'Nobody saw me take this',
      JSON.stringify(find(rev, trick.json.photoId)?.caption));
    const mine = await api('GET', `/api/photos/${ev.joinCode}`, { headers: { 'x-session-token': ana.json.sessionToken } });
    ok("the guest's own roll carries it", find(mine, trick.json.photoId)?.caption === 'Nobody saw me take this',
      JSON.stringify(find(mine, trick.json.photoId)?.caption));

    // A share is the copy that actually leaves the event, so the words have to travel with it.
    const sh = await api('POST', `/api/events/${ev.joinCode}/shares`, { body: { kind: 'all' }, headers: org(ev.organizerCode) });
    const shared = await api('GET', `/api/shares/${sh.json.token}`);
    const st = find(shared, trick.json.photoId);
    ok('a shared gallery carries the caption AND the trick',
      st?.caption === 'Nobody saw me take this' && st?.challenge === 'The cake, before it’s cut',
      JSON.stringify({ caption: st?.caption, challenge: st?.challenge }));

    // The caption lives on the photo row, so the existing cascade is the whole deletion story —
    // there is no second place for a deleted photo's words to survive.
    dbq(`DELETE FROM photos WHERE id='${trick.json.photoId}'`);
    ok('deleting the photo takes its caption with it',
      dbq(`SELECT count(*) FROM photos WHERE id='${trick.json.photoId}'`) === '0');

    dbq(`DELETE FROM events WHERE join_code='${ev.joinCode}'`);
  }

  session.cookie = ownerCookie;
}, {});

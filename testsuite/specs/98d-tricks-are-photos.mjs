// Snapdini integration spec — 'a trick is a photo, and a clip never ticks one'.
//
// Every challenge we ship is worded as a still, and the saved shape ({id,text}) carries no notion of
// a clip. The point of the list is that a roll is finite: spending one of a fixed number of shots on
// a trick is a real decision. A clip is a different currency — seconds, usually paid — and one
// ten-second clip plausibly contains several tricks at once, which makes ticking them arbitrary.
//
// The server had no opinion on the medium, so a video tagged with a trick ticked it off. This pins
// the rule server-side, because the camera hiding the option is a courtesy, not an enforcement.
import { api, createEvent, group, ok, org, spec, img } from '../lib/harness.mjs';

const send = async (token, challengeId, video) => {
  const fd = new FormData();
  fd.append('sessionToken', token);
  if (challengeId !== undefined) fd.append('challengeId', challengeId);
  fd.append('photo', new Blob([img], { type: video ? 'video/mp4' : 'image/jpeg' }), video ? 'v.mp4' : 'p.jpg');
  return api('POST', '/api/photos', { body: fd });
};

await spec('98d-tricks-are-photos', async () => {
  group('A trick is a photo, and a clip never ticks one');
  {
    const items = [{ id: 'general-laugh', text: 'Someone laughing' },
                   { id: 'general-shoes', text: 'Everyone’s shoes' }];
    const ev = await createEvent({ videoSeconds: 15 });
    await api('PUT', `/api/events/${ev.joinCode}/challenges`,
      { body: { challenges: { sets: [{ key: 'a', label: 'Card A', items }] } }, headers: org(ev.organizerCode) });

    const j = await api('POST', '/api/participants', { body: { joinCode: ev.joinCode, name: 'Guest' } });
    const token = j.json?.sessionToken;
    ok('a guest joins and is handed the card', (j.json?.challenges || []).length === 2);

    // A PHOTO tagged with a trick ticks it — the behaviour we are protecting, not removing.
    const shot = await send(token, 'general-laugh', false);
    ok('a photo tagged with a trick is accepted', shot.status === 200, `status ${shot.status}`);
    let me = await api('GET', `/api/participants/me?sessionToken=${token}`);
    ok('and ticks it off', (me.json?.challengesDone || []).includes('general-laugh'),
      JSON.stringify(me.json?.challengesDone));

    // A VIDEO tagged with a trick is kept, but ticks nothing.
    const clip = await send(token, 'general-shoes', true);
    ok('a clip tagged with a trick is still accepted', clip.status === 200, `status ${clip.status}`);
    me = await api('GET', `/api/participants/me?sessionToken=${token}`);
    ok('but it does NOT tick the trick', !(me.json?.challengesDone || []).includes('general-shoes'),
      JSON.stringify(me.json?.challengesDone));
    ok('and the photo before it is untouched', (me.json?.challengesDone || []).includes('general-laugh'));

    // …and the clip carries no mission caption either, or the gallery would label it with a trick
    // it never completed.
    const g = await api('GET', `/api/photos/${ev.joinCode}?gallery=true`);
    const vid = (g.json?.photos || []).find((p) => p.mediaType === 'video');
    ok('the clip is in the gallery', !!vid);
    ok('with no trick attributed to it', vid && !vid.challenge, JSON.stringify(vid?.challenge));
  }
});

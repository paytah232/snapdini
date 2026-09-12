// Snapdini integration spec — 'a host editing the list mid-event does not corrupt a guest's count'.
//
// Progress is derived from photos.challenge_id, which is right, but it was returned unfiltered: a
// guest who had done one of three saw "1/6" after the host replaced the list, where that 1 was none
// of the 6. Progress is only ever counted against the card the guest is HOLDING.
//
// Nothing is destroyed by that: the photo keeps its challenge_id, so restoring the trick makes it
// count again. That is the difference between scoping a view and deleting history.
import { api, createEvent, group, ok, org, spec, img } from '../lib/harness.mjs';

const shoot = async (token, challengeId) => {
  const fd = new FormData();
  fd.append('sessionToken', token);
  if (challengeId) fd.append('challengeId', challengeId);
  fd.append('photo', new Blob([img], { type: 'image/jpeg' }), 'p.jpg');
  return api('POST', '/api/photos', { body: fd });
};
const setList = (ev, items) => api('PUT', `/api/events/${ev.joinCode}/challenges`,
  { body: { challenges: { sets: [{ key: 'a', label: 'Card A', items }] } }, headers: org(ev.organizerCode) });
const me = async (token) => (await api('GET', `/api/participants/me?sessionToken=${token}`)).json;

const A = [{ id: 'general-laugh', text: 'Someone laughing' },
           { id: 'general-shoes', text: 'Everyone’s shoes' },
           { id: 'general-hands', text: 'Two people’s hands' }];
const B = [{ id: 'general-cake', text: 'The cake' },
           { id: 'general-dance', text: 'Someone dancing' }];

await spec('98e-trick-list-edited', async () => {
  group('A host editing the list mid-event does not corrupt a guest’s count');
  {
    const ev = await createEvent();
    await setList(ev, A);
    const j = await api('POST', '/api/participants', { body: { joinCode: ev.joinCode, name: 'Guest' } });
    const token = j.json?.sessionToken;

    await shoot(token, 'general-laugh');
    let m = await me(token);
    ok('one of three is done', m.challenges.length === 3 && m.challengesDone.length === 1,
      `${m.challengesDone.length}/${m.challenges.length}`);

    // The host replaces the list with entirely different tricks.
    await setList(ev, B);
    m = await me(token);
    ok('the guest sees the NEW list', m.challenges.length === 2 && m.challenges[0].id === 'general-cake',
      JSON.stringify(m.challenges.map((c) => c.id)));
    ok('and none of it is ticked, because none of it was done', m.challengesDone.length === 0,
      JSON.stringify(m.challengesDone));

    // The photo is untouched — restore the trick and the tick comes back.
    await setList(ev, [...B, { id: 'general-laugh', text: 'Someone laughing' }]);
    m = await me(token);
    ok('restoring a trick restores its tick', m.challengesDone.includes('general-laugh'),
      JSON.stringify(m.challengesDone));
    ok('and the count is against the card being held', m.challenges.length === 3,
      `${m.challengesDone.length}/${m.challenges.length}`);

    // A partial edit keeps what is still on the card.
    await setList(ev, [{ id: 'general-laugh', text: 'Someone laughing' }, ...B]);
    m = await me(token);
    ok('a trick that survived the edit stays ticked', m.challengesDone.length === 1,
      JSON.stringify(m.challengesDone));
    ok('progress can never exceed the list', m.challengesDone.length <= m.challenges.length);
  }
});

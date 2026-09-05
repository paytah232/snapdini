// Snapdini integration spec — guest feedback: collected, readable, and it survives the purge.
//
// Two things are worth pinning here. First, collecting feedback nobody can read is the same as not
// collecting it, so the operator endpoint is part of the feature, not an extra. Second, feedback is
// about the PRODUCT, so it has to outlive the event's 31-day media retention — it used to cascade
// off participants and quietly delete itself.
import { api, createEvent, dbq, group, join, ok, spec } from '../lib/harness.mjs';

const send = (body) => api('POST', '/api/participants/feedback', { body });

await spec('15-guest-feedback', async () => {
  group('A guest can be asked once, and answering is optional');
  const ev = await createEvent({ revealMode: 'instant', maxPhotos: 12 });
  const tok = (await join(ev.joinCode, 'Opinionated Guest')).json?.sessionToken;
  ok('guest joined', !!tok);
  const pid = dbq(`SELECT id FROM participants WHERE session_token='${tok}'`);

  ok('no session is refused', (await send({ rating: 5 })).status === 400);
  ok('a bogus session is refused', (await send({ sessionToken: 'nope', rating: 5 })).status === 403);
  ok('an empty answer is refused', (await send({ sessionToken: tok })).status === 400);

  group('Dismissing is respected and never asked again');
  const dev = await createEvent({ revealMode: 'instant', maxPhotos: 12 });
  const dtok = (await join(dev.joinCode, 'Not Interested')).json?.sessionToken;
  const dres = await send({ sessionToken: dtok, dismissed: true });
  ok('dismissal accepted', dres.status === 200 && dres.json?.recorded === false);
  const dpid = dbq(`SELECT id FROM participants WHERE session_token='${dtok}'`);
  ok('dismissal leaves no opinion behind',
     dbq(`SELECT count(*) FROM guest_feedback WHERE participant_id='${dpid}'`) === '0');
  ok('but it is marked asked, so we do not nag',
     dbq(`SELECT feedback_asked_at IS NOT NULL FROM participants WHERE id='${dpid}'`) === 't');

  group('A rating is stored, and one guest is one opinion');
  const r1 = await send({ sessionToken: tok, rating: 5, comment: 'Dead easy, loved it' });
  ok('feedback recorded', r1.status === 200 && r1.json?.recorded === true);
  ok('stored with its rating', dbq(`SELECT rating FROM guest_feedback WHERE participant_id='${pid}'`) === '5');
  await send({ sessionToken: tok, rating: 1, comment: 'changed my mind twice' });
  ok('a second submission does not become a second opinion',
     dbq(`SELECT count(*) FROM guest_feedback WHERE participant_id='${pid}'`) === '1');
  ok('and the first answer stands',
     dbq(`SELECT rating FROM guest_feedback WHERE participant_id='${pid}'`) === '5');

  group('An out-of-range rating is dropped, not stored as nonsense');
  const oev = await createEvent({ revealMode: 'instant', maxPhotos: 12 });
  const otok = (await join(oev.joinCode, 'Ten Out Of Five')).json?.sessionToken;
  const opid = dbq(`SELECT id FROM participants WHERE session_token='${otok}'`);
  ok('a 9-star rating with a comment is still accepted',
     (await send({ sessionToken: otok, rating: 9, comment: 'off the scale' })).status === 200);
  ok('but the impossible rating is not stored',
     dbq(`SELECT rating IS NULL FROM guest_feedback WHERE participant_id='${opid}'`) === 't');

  group('The operator can actually read it');
  // Asserted BEFORE the admin login below, because logging in swaps this session's cookie.
  ok('guest feedback is gated to the operator',
     [401, 403].includes((await api('GET', '/api/admin/guest-feedback')).status));
  const admLogin = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
    ? await api('POST', '/api/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } })
    : { status: 0 };
  if (admLogin.status === 200) {
    const list = await api('GET', '/api/admin/guest-feedback');
    const rows = list.json?.feedback || [];
    const mine = rows.find((r) => r.id === dbq(`SELECT id FROM guest_feedback WHERE participant_id='${pid}'`));
    ok('the operator sees the guest opinion', !!mine && Number(mine.rating) === 5,
       JSON.stringify(mine || rows.slice(0, 1)));
    ok('with the comment the guest actually wrote', mine?.comment === 'Dead easy, loved it', `${mine?.comment}`);
    ok('and it names the event it came from', !!mine?.join_code && !!mine?.event_name);
    ok('an average is reported', typeof list.json?.average === 'number' || list.json?.average === null);
  } else {
    ok('operator read skipped — no admin creds on this env', true);
  }

  group('Retention purges the guest but keeps the opinion');
  // The sweep deletes participants; feedback used to cascade away with them. It must now detach.
  const fid = dbq(`SELECT id FROM guest_feedback WHERE participant_id='${pid}'`);
  dbq(`DELETE FROM participants WHERE id='${pid}'`);
  ok('the feedback outlives the guest', dbq(`SELECT count(*) FROM guest_feedback WHERE id='${fid}'`) === '1');
  ok('and no longer points at a person', dbq(`SELECT participant_id IS NULL FROM guest_feedback WHERE id='${fid}'`) === 't');
  ok('while the rating itself is intact', dbq(`SELECT rating FROM guest_feedback WHERE id='${fid}'`) === '5');
});

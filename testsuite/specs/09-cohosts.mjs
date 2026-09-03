// Snapdini integration spec — 'Co-hosts'.
//
// Registers a SECOND user (the invitee) and swaps sessions, so it owns its own file.
import { EMAIL, TS, api, createEvent, dbq, group, ok, org, session, spec } from '../lib/harness.mjs';

await spec('09-cohosts', async () => {
  group('Co-hosts');
  const ownerCookie = session.cookie;                       // current session = the owner (user1)
  const coEmail = `cohost_${TS}@example.com`;
  const eCo = await createEvent({ revealMode: 'instant' });
  const inv = await api('POST', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode), body: { email: coEmail } });
  ok('invite co-host → ok + devLink', inv.status === 200 && !!inv.json?.devLink);
  ok('co-host listed as invited (not accepted)', (await api('GET', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode) })).json?.cohosts?.some((c) => c.email === coEmail && !c.accepted));
  ok('duplicate invite → 409', (await api('POST', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode), body: { email: coEmail } })).status === 409);
  ok('invalid invite email → 400', (await api('POST', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode), body: { email: 'nope' } })).status === 400);
  ok('inviting the owner → 400', (await api('POST', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode), body: { email: EMAIL } })).status === 400);
  const coToken = String(inv.json.devLink).split('/cohost/')[1];

  // Accept requires auth — logged out → 401.
  session.cookie = '';
  ok('accept logged-out → 401', (await api('POST', `/api/cohosts/${coToken}/accept`)).status === 401);
  ok('accept bad token (logged-out) → 401 before lookup', (await api('POST', `/api/cohosts/nope/accept`)).status === 401);
  session.cookie = ownerCookie;
  // The owner (a DIFFERENT, verified email than the invite) must NOT be able to accept it.
  ok('accept with a non-matching email → 403', (await api('POST', `/api/cohosts/${coToken}/accept`)).status === 403);

  // A second user accepts the invite, then manages by identity.
  const reg2 = await api('POST', '/api/auth/register', { body: { email: coEmail, password: 'hunter2hunter2', displayName: 'Co Host' } });
  ok('co-host user registers', [200, 201].includes(reg2.status) && !!reg2.json?.devLink);
  const v2 = new URL(reg2.json.devLink); await api('GET', v2.pathname + v2.search);   // verify → logs in user2
  ok('pending invite appears in co-host dashboard list', ((await api('GET', '/api/cohosts')).json?.invites ?? []).some((i) => i.token === coToken && i.joinCode === eCo.joinCode));
  const acc = await api('POST', `/api/cohosts/${coToken}/accept`);
  ok('co-host accepts → ok + joinCode', acc.status === 200 && acc.json?.joinCode === eCo.joinCode);
  ok('accepted invite drops off the pending list', !((await api('GET', '/api/cohosts')).json?.invites ?? []).some((i) => i.token === coToken));
  ok('co-host manages by identity (admin 200, no org code)', (await api('GET', `/api/events/${eCo.joinCode}/admin`)).status === 200);
  ok('co-host can edit settings', (await api('PUT', `/api/events/${eCo.joinCode}/settings`, { body: { name: 'Co-renamed' } })).status === 200);
  ok('co-hosted event in /mine with coHost flag', (await api('GET', '/api/events/mine')).json?.events?.some((e) => e.joinCode === eCo.joinCode && e.coHost === true));
  ok('co-host CANNOT delete the owner\'s event (403)', (await api('DELETE', `/api/events/${eCo.joinCode}`)).status === 403);

  // Back to the owner: sees the accepted co-host, can remove them; owner is never a removable row.
  session.cookie = ownerCookie;
  const list = (await api('GET', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode) })).json;
  ok('owner sees co-host accepted + owner row present', list?.cohosts?.some((c) => c.email === coEmail && c.accepted) && !!list?.owner && list?.youAreOwner === true);
  const coId = list.cohosts.find((c) => c.email === coEmail).id;
  await api('DELETE', `/api/events/${eCo.joinCode}/cohosts/${coId}`, { headers: org(eCo.organizerCode) });
  ok('co-host removed', !(await api('GET', `/api/events/${eCo.joinCode}/cohosts`, { headers: org(eCo.organizerCode) })).json.cohosts.some((c) => c.email === coEmail));
  dbq(`DELETE FROM users WHERE email='${coEmail}'`);   // tidy the second user (owns nothing)
}, {});

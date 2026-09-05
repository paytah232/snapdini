// Snapdini integration spec — guest-paid top-ups and the "ask the host" signal.
//
// The dangerous property is the ALLOWANCE, not the payment: a guest's purchased shots are added on
// top of the event's roll, so a second sum anywhere would hand a paying guest their old limit back.
// These tests pin that, plus the host's ability to switch the whole thing off.
import { api, createEvent, dbq, group, join, ok, spec, upload } from '../lib/harness.mjs';

const remaining = async (tok) => (await api('GET', '/api/participants/me', { headers: { 'X-Session-Token': tok } })).json?.photosRemaining;

await spec('13-guest-upgrades', async () => {
  group('A purchased top-up adds to the roll, it does not replace it');
  const ev = await createEvent({ revealMode: 'instant', maxPhotos: 12 });
  const tok = (await join(ev.joinCode, 'Keen Guest')).json?.sessionToken;
  ok('guest joined', !!tok);
  const pid = dbq(`SELECT id FROM participants WHERE session_token='${tok}'`);
  ok('starts on the event roll', (await remaining(tok)) === 12, `${await remaining(tok)}`);

  await upload(tok);
  ok('a shot spends one', (await remaining(tok)) === 11, `${await remaining(tok)}`);

  // Simulate what the webhook does on a settled top-up.
  dbq(`UPDATE participants SET extra_photos = extra_photos + 12 WHERE id='${pid}'`);
  ok('the top-up ADDS to the event roll (12 + 12 - 1)', (await remaining(tok)) === 23, `${await remaining(tok)}`);

  // The point of the additive design: the host cutting the event roll must not take away what a
  // guest paid for.
  dbq(`UPDATE events SET max_photos = 6 WHERE id='${ev.id}'`);
  ok('lowering the event roll does not remove purchased shots', (await remaining(tok)) === 17, `${await remaining(tok)}`);
  dbq(`UPDATE events SET max_photos = 12 WHERE id='${ev.id}'`);

  group('The upload gate respects the topped-up roll');
  const ev2 = await createEvent({ revealMode: 'instant', maxPhotos: 1 });
  const t2 = (await join(ev2.joinCode, 'One Shot')).json?.sessionToken;
  const p2 = dbq(`SELECT id FROM participants WHERE session_token='${t2}'`);
  await upload(t2);
  const blocked = await upload(t2);
  ok('a spent roll is refused', blocked.status === 403, `status ${blocked.status}`);
  dbq(`UPDATE participants SET extra_photos = 2 WHERE id='${p2}'`);
  const afterTopUp = await upload(t2);
  ok('and the same guest can shoot again after topping up', afterTopUp.status === 200, `status ${afterTopUp.status}`);

  group('The host decides whether guests may buy at all');
  const t3 = (await join(ev.joinCode, 'Shopper')).json?.sessionToken;
  dbq(`UPDATE events SET guest_may_buy_shots = false WHERE id='${ev.id}'`);
  const off = await api('POST', '/api/billing/guest-upgrade', { body: { sessionToken: t3 } });
  ok('top-up refused when the host has switched it off', off.status === 403, `status ${off.status}`);
  dbq(`UPDATE events SET guest_may_buy_shots = true WHERE id='${ev.id}'`);

  // Shots bought minutes before the camera closes are worthless and come back as refund requests.
  const nearlyOver = Date.now() + 5 * 60 * 1000;
  dbq(`UPDATE events SET expires_at = ${nearlyOver} WHERE id='${ev.id}'`);
  const late = await api('POST', '/api/billing/guest-upgrade', { body: { sessionToken: t3 } });
  ok('top-up closes near the end of an event', late.status === 409, `status ${late.status}`);
  dbq(`UPDATE events SET expires_at = ${Date.now() + 86400000} WHERE id='${ev.id}'`);

  const noSession = await api('POST', '/api/billing/guest-upgrade', { body: { sessionToken: 'nope' } });
  ok('an unknown session cannot buy', noSession.status === 403, `status ${noSession.status}`);

  group('Asking the host is free, and recorded once');
  const askTok = (await join(ev.joinCode, 'Asker')).json?.sessionToken;
  const askPid = dbq(`SELECT id FROM participants WHERE session_token='${askTok}'`);
  ok('no request recorded to begin with',
     dbq(`SELECT COALESCE(requested_more_at::text,'null') FROM participants WHERE id='${askPid}'`) === 'null');
  ok('asking succeeds', (await api('POST', '/api/billing/guest-request-more', { body: { sessionToken: askTok } })).status === 200);
  const first = dbq(`SELECT requested_more_at FROM participants WHERE id='${askPid}'`);
  ok('the ask is recorded', first !== '' && first !== 'null', first);
  await new Promise((r) => setTimeout(r, 1100));
  await api('POST', '/api/billing/guest-request-more', { body: { sessionToken: askTok } });
  ok('asking twice does not move the timestamp — one ask per guest',
     dbq(`SELECT requested_more_at FROM participants WHERE id='${askPid}'`) === first,
     `${first} -> ${dbq(`SELECT requested_more_at FROM participants WHERE id='${askPid}'`)}`);

  group('Buying and asking are separate switches — all four combinations');
  // A host may want the money without the interruptions, or the control without refusing to be
  // asked. Both switches are independent and both are enforced server-side.
  const combos = [
    { buy: true,  ask: true,  buyStatus: [200, 503], askStatus: 200, label: 'both on' },
    { buy: true,  ask: false, buyStatus: [200, 503], askStatus: 403, label: 'buy on, ask off' },
    { buy: false, ask: true,  buyStatus: [403],      askStatus: 200, label: 'buy off, ask on' },
    { buy: false, ask: false, buyStatus: [403],      askStatus: 403, label: 'both off — full control' },
  ];
  for (const c of combos) {
    const cev = await createEvent({ revealMode: 'instant', maxPhotos: 12 });
    dbq(`UPDATE events SET guest_may_buy_shots=${c.buy}, guest_may_request=${c.ask} WHERE id='${cev.id}'`);
    const ct = (await join(cev.joinCode, `Guest ${c.label}`)).json?.sessionToken;
    const buy = await api('POST', '/api/billing/guest-upgrade',      { body: { sessionToken: ct } });
    const ask = await api('POST', '/api/billing/guest-request-more', { body: { sessionToken: ct } });
    // 503 = Stripe not configured on this stack; either way it is NOT a permission refusal.
    ok(`${c.label}: buying ${c.buy ? 'allowed' : 'refused'}`, c.buyStatus.includes(buy.status), `status ${buy.status}`);
    ok(`${c.label}: asking ${c.ask ? 'allowed' : 'refused'}`, ask.status === c.askStatus, `status ${ask.status}`);
    // and the guest's own /me must advertise exactly the options that will actually work
    const me = (await api('GET', '/api/participants/me', { headers: { 'X-Session-Token': ct } })).json;
    ok(`${c.label}: /me advertises the right options`,
       me?.canBuyShots === c.buy && me?.canAskHost === c.ask,
       `canBuyShots=${me?.canBuyShots} canAskHost=${me?.canAskHost}`);
  }
});

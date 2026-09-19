// Snapdini integration spec — guest-paid top-ups and the "ask the host" signal.
//
// The dangerous property is the ALLOWANCE, not the payment: a guest's purchased shots are added on
// top of the event's roll, so a second sum anywhere would hand a paying guest their old limit back.
// These tests pin that, plus the host's ability to switch the whole thing off.
import { adminLogin, api, createEvent, dbq, group, join, ok, org, session, spec, upload } from '../lib/harness.mjs';

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
  // GUEST_UPGRADE_CUTOFF_MS is 15 minutes; one minute left is unambiguously inside it whatever the
  // box is doing, where a value AT the boundary would be a bet on how long the next line takes.
  dbq(`UPDATE events SET expires_at = ${Date.now() + 60_000} WHERE id='${ev.id}'`);
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
  // The old version slept 1.1s so that a re-write would land on a different millisecond and be
  // visible. Age the stored value by an hour instead: a second ask that overwrote it would be
  // unmistakably NOW rather than an hour ago, so the same claim is pinned harder and instantly —
  // no sleep, and nothing that gets weaker on a slow box.
  const aged = String(Number(first) - 3_600_000);
  dbq(`UPDATE participants SET requested_more_at = ${aged} WHERE id='${askPid}'`);
  await api('POST', '/api/billing/guest-request-more', { body: { sessionToken: askTok } });
  const after = dbq(`SELECT requested_more_at FROM participants WHERE id='${askPid}'`);
  ok('asking twice does not move the timestamp — one ask per guest', after === aged, `${aged} -> ${after}`);

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

  group('Host settings never leak to guests');
  // These went on the PUBLIC event GET by mistake once. A guest reading the event should learn
  // nothing about the host's permission settings or how many people have asked for more.
  const lev = await createEvent({ revealMode: 'instant' });
  const pub = (await api('GET', `/api/events/${lev.joinCode}`)).json || {};
  const leaked = Object.keys(pub).filter((k) => k.startsWith('guestMay') || k === 'upgradeRequests');
  ok('public event GET exposes no host permission fields', leaked.length === 0, leaked.join(', '));
  const adm = (await api('GET', `/api/events/${lev.joinCode}/admin`, { headers: org(lev.organizerCode) })).json || {};
  ok('the organiser DOES see them', typeof adm.guestMayBuyShots === 'boolean' && typeof adm.upgradeRequests === 'number',
     JSON.stringify({ b: adm.guestMayBuyShots, r: adm.upgradeRequests }));

  // and the count is real, not a stub
  const lt = (await join(lev.joinCode, 'Asker Two')).json?.sessionToken;
  await api('POST', '/api/billing/guest-request-more', { body: { sessionToken: lt } });
  const adm2 = (await api('GET', `/api/events/${lev.joinCode}/admin`, { headers: org(lev.organizerCode) })).json || {};
  ok('upgradeRequests counts a real ask', adm2.upgradeRequests === 1, `${adm2.upgradeRequests}`);

  group('Guest payments are visible and refundable to the operator');
  // The paying guest's event is created BEFORE the operator login, and the owner session is put
  // back afterwards. Created under the operator session it belonged to the OPERATOR account, which
  // outlives the run — so the harness teardown (which deletes the test user and lets the cascade
  // take their events) never reached it, and every run left one more behind.
  const pev = await createEvent({ revealMode: 'instant', maxPhotos: 12 });
  const pt = (await join(pev.joinCode, 'Payer')).json?.sessionToken;
  const ownerCookie = session.cookie;
  const admLogin = await adminLogin();
  if (admLogin.status === 200) {
    const ppid = dbq(`SELECT id FROM participants WHERE session_token='${pt}'`);
    // stand in for a settled webhook
    dbq(`UPDATE participants SET extra_photos=12, amount_paid_cents=300, upgrade_email='payer@example.com' WHERE id='${ppid}'`);
    const list = await api('GET', '/api/admin/guest-payments');
    // The endpoint pages (LIMIT 100, newest join first) and this guest joined moments ago, so the
    // lookup is by OUR participant id — never by position, and never an assertion about how many
    // rows the whole table happens to hold.
    const payments = list.json?.payments || [];
    const mine = payments.find((g) => g.id === ppid);
    ok('a paid guest appears in the operator list', !!mine && Number(mine.amount_paid_cents) === 300,
       JSON.stringify(mine || (list.json?.payments || []).slice(0, 1)));
    // Deliberately over the whole page: this is the endpoint's own WHERE clause under test, and no
    // other spec can put a zero-paying guest in it — only a product change could.
    ok('a guest who never paid does NOT appear', !payments.some((g) => Number(g.amount_paid_cents) === 0));
    // no Stripe intent on file -> refund must refuse clearly rather than half-succeed
    const noPi = await api('POST', `/api/admin/refund-guest/${ppid}`);
    ok('refund without a Stripe payment on file is refused with a clear reason',
       noPi.status === 400 && /stripe dashboard/i.test(noPi.text || ''), `status ${noPi.status}`);
    ok('and nothing was taken away by the failed attempt',
       Number(dbq(`SELECT extra_photos FROM participants WHERE id='${ppid}'`)) === 12,
       dbq(`SELECT extra_photos FROM participants WHERE id='${ppid}'`));
    ok('refunding an unknown guest is a 404',
       (await api('POST', '/api/admin/refund-guest/nope')).status === 404);
    session.cookie = ownerCookie;   // hand the owner session back before teardown
  } else {
    ok('guest payment admin skipped — no admin creds on this env', true);
  }
});

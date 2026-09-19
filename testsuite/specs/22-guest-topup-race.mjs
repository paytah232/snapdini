// Snapdini integration spec — 'a guest who pays for shots gets the shots'.
//
// The guest top-up is the one place in this product where money arrives for an entitlement that is
// then GRANTED BY US, in a second statement, off a number we read a moment earlier:
//
//     const [cur] = await db.select({ extraPhotos, amountPaidCents, stripePaymentIntent })…
//     if (paymentIntent && cur.stripePaymentIntent === paymentIntent) return;   // check
//     set({ extraPhotos: (cur.extraPhotos || 0) + shots,                        // …then act
//           amountPaidCents: (cur.amountPaidCents || 0) + paidNow })
//
// Two settled top-ups for ONE guest arriving together both read the same `extra_photos`, both add
// their own pack to it, and the second write lands on top of the first: the guest paid twice and
// was given one pack. `amount_paid_cents` loses the same way, which also hides it — the refund the
// guest then asks for is priced off a total that never recorded what they were charged.
//
// Stripe's own replay guard does NOT cover this. processed_stripe_events (0050) claims each Stripe
// event id with an INSERT … RETURNING, so a REDELIVERY of one event cannot be applied twice; but
// two DIFFERENT settled sessions are two different event ids, and both claims succeed. The
// `cur.stripePaymentIntent === paymentIntent` line is not a guard against this either — it is
// itself a read followed by a write, and under concurrency every racer reads the same NULL.
//
// Is it reachable? The top-up is a Stripe Checkout hop, so the guest cannot double-submit a form.
// But Stripe delivers webhooks from a fleet, with retries, and a guest at a party whose phone is on
// a venue's wifi is the normal case for "the success page never loaded, so they bought again". Two
// deliveries landing inside the same few milliseconds is Stripe's behaviour, not an exotic one.
//
// The cost is the worst this product can charge: money taken, nothing delivered. So this fires the
// deliveries for real, against the real webhook, with real signatures — the grant, the recorded
// amount and the rows actually stored all have to agree.
//
// SIGNING: the webhook verifies a real Stripe signature, so the payload must be HMAC'd with
// STRIPE_WEBHOOK_SECRET. That secret is only ever read INSIDE the app container — the signing and
// the POST both happen there (`docker exec … node -e`), and only the response status comes back.
// Nothing here can print it.
import { execFileSync } from 'node:child_process';
import { api, createEvent, dbq, group, join, ok, spec, teardownSql, UNIQ } from '../lib/harness.mjs';

const APP = process.env.TEST_APP_CONTAINER || 'snapdini-dev-app';

const extraOf  = (pid) => Number(dbq(`SELECT extra_photos      FROM participants WHERE id='${pid}'`));
const paidOf   = (pid) => Number(dbq(`SELECT amount_paid_cents FROM participants WHERE id='${pid}'`));
const intentOf = (pid) => dbq(`SELECT COALESCE(stripe_payment_intent,'') FROM participants WHERE id='${pid}'`);
const emailOf  = (pid) => dbq(`SELECT COALESCE(email,'') FROM participants WHERE id='${pid}'`);
const upEmailOf = (pid) => dbq(`SELECT COALESCE(upgrade_email,'') FROM participants WHERE id='${pid}'`);
const pidOf    = (tok) => dbq(`SELECT id FROM participants WHERE session_token='${tok}'`);

/** One `checkout.session.completed`, exactly as Stripe shapes it. */
function sessionCompleted({ id, intent, participantId, shots = 12, amount = 300, status = 'paid', email = null, meta = {} }) {
  return JSON.stringify({
    id, object: 'event', type: 'checkout.session.completed', api_version: '2025-01-01',
    data: { object: {
      id: `cs_${id}`, object: 'checkout.session', payment_status: status,
      amount_total: amount, payment_intent: intent,
      customer_details: email ? { email } : undefined,
      metadata: { kind: 'guest_upgrade', participantId, shots: String(shots), ...meta },
    } },
  });
}

// Signed and POSTed from inside the container, all of them dispatched before any of them answers —
// which is the whole point. In series the pre-fix code passes.
const DRIVER = `
  const crypto = require('crypto');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const url = 'http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/billing/webhook';
  const bodies = JSON.parse(process.argv[1]);
  const send = (body) => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', secret).update(t + '.' + body).digest('hex');
    return fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=' + t + ',v1=' + v1 },
      body }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 160) }));
  };
  Promise.all(bodies.map(send)).then((rs) => console.log(JSON.stringify(rs)),
                                     (e) => { console.log(JSON.stringify([{ status: 0, body: String(e) }])); });
`;
function deliver(bodies) {
  const out = execFileSync('docker', ['exec', APP, 'node', '-e', DRIVER, JSON.stringify(bodies)],
    { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}
const bin = (rs) => rs.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});

// A guest, and the assertion that they exist. Every group makes it: the /api rate-limit backstop is
// shared with whatever else is running against this box, and a join that came back 429 left `pid`
// null — which the webhook then ignores, and which reads in the output as "the money was not
// granted". That is a phantom of precisely the bug under test, so it is named rather than inferred.
async function guestOn(joinCode, name) {
  const r = await join(joinCode, name);
  const tok = r.json?.sessionToken;
  ok(`guest "${name}" joined`, !!tok, `status ${r.status} ${String(r.text).slice(0, 80)}`);
  return { tok, pid: tok ? pidOf(tok) : null };
}

await spec('22-guest-topup-race', async () => {
  // processed_stripe_events is global and deliberately outlives the events it refers to, so the
  // user-cascade teardown never reaches the claims this spec makes. UNIQ carries this process's pid
  // and a random suffix, so the prefix matches only ids this run minted — never another run's.
  teardownSql.push(`DELETE FROM processed_stripe_events WHERE id LIKE 'evt_${UNIQ}_%'`);

  const ev = await createEvent({ maxPhotos: 12 });

  group('Simultaneous settled top-ups each grant their own pack');
  {
    const { tok, pid } = await guestOn(ev.joinCode, 'Paid Twice');
    ok('starts with nothing bought', extraOf(pid) === 0 && paidOf(pid) === 0,
      `extra=${extraOf(pid)} paid=${paidOf(pid)}`);

    // Six distinct settled sessions — six Stripe event ids, six payment intents, one guest. Every
    // claim on processed_stripe_events succeeds, so nothing upstream of the grant deduplicates
    // these: they are six real payments.
    const N = 6, SHOTS = 12, CENTS = 300;
    const bodies = Array.from({ length: N }, (_, i) => sessionCompleted({
      id: `evt_${UNIQ}_burst_${i}`, intent: `pi_${UNIQ}_burst_${i}`, participantId: pid,
      shots: SHOTS, amount: CENTS,
    }));
    const rs = deliver(bodies);
    console.log(`   statuses=${JSON.stringify(bin(rs))} extra=${extraOf(pid)} paid=${paidOf(pid)}c`);

    ok(`all ${N} deliveries are acknowledged`, rs.every((r) => r.status === 200), JSON.stringify(bin(rs)));
    // The headline. Before the fix this was a single pack for six payments.
    ok(`...and ${N} paid packs granted ${N * SHOTS} shots`, extraOf(pid) === N * SHOTS,
      `extra_photos=${extraOf(pid)}, expected ${N * SHOTS}`);
    ok(`...and every cent taken is recorded`, paidOf(pid) === N * CENTS,
      `amount_paid_cents=${paidOf(pid)}, expected ${N * CENTS}`);
    // The number the guest is actually shown by their camera. A counter that is right while the
    // roll reads as spent is still a guest who cannot shoot what they bought.
    const roll = Number(dbq(`SELECT max_photos FROM events WHERE id='${ev.id}'`));
    const me = (await api('GET', '/api/participants/me', { headers: { 'X-Session-Token': tok } })).json;
    ok('...and the guest is offered every frame they bought',
      me?.photosRemaining === roll + N * SHOTS, `photosRemaining=${me?.photosRemaining}, expected ${roll + N * SHOTS}`);
    // One of the six intents is on the row as the refund handle; it must be one we actually saw.
    ok('...and a payment intent is on file for the refund path',
      bodies.some((b) => JSON.parse(b).data.object.payment_intent === intentOf(pid)), intentOf(pid));
  }

  group('A redelivery is still counted exactly once');
  {
    const { tok, pid } = await guestOn(ev.joinCode, 'Retried');
    const body = sessionCompleted({ id: `evt_${UNIQ}_replay`, intent: `pi_${UNIQ}_replay`, participantId: pid });

    const first = deliver([body]);
    ok('the first delivery grants the pack', extraOf(pid) === 12 && paidOf(pid) === 300,
      `extra=${extraOf(pid)} paid=${paidOf(pid)}`);
    ok('...answered 200', first[0].status === 200, JSON.stringify(first));

    // Stripe redelivering the identical event. processed_stripe_events is what catches this.
    const again = deliver([body, body, body]);
    ok('three redeliveries of the same event are acknowledged', again.every((r) => r.status === 200), JSON.stringify(bin(again)));
    ok('...and grant nothing further', extraOf(pid) === 12 && paidOf(pid) === 300,
      `extra=${extraOf(pid)} paid=${paidOf(pid)}`);

    // The second line of defence, and the one the fix moves into the statement: a NEW Stripe event
    // id carrying a payment intent we have already credited. The event-id claim cannot see this;
    // only the payment intent on the row can.
    const resent = deliver([sessionCompleted({
      id: `evt_${UNIQ}_replay_newid`, intent: `pi_${UNIQ}_replay`, participantId: pid })]);
    ok('a fresh event id for a payment already credited is acknowledged', resent[0].status === 200, JSON.stringify(resent));
    ok('...and grants nothing further', extraOf(pid) === 12 && paidOf(pid) === 300,
      `extra=${extraOf(pid)} paid=${paidOf(pid)}`);

    // …and the same intent racing ITSELF. Both racers read the same NULL-or-other intent, so this
    // is the check-then-act half of the guard, not the claim table's job.
    const { pid: pid2 } = await guestOn(ev.joinCode, 'Raced Replay');
    const sameIntent = Array.from({ length: 4 }, (_, i) => sessionCompleted({
      id: `evt_${UNIQ}_sameintent_${i}`, intent: `pi_${UNIQ}_sameintent`, participantId: pid2 }));
    const raced = deliver(sameIntent);
    console.log(`   same-intent race: statuses=${JSON.stringify(bin(raced))} extra=${extraOf(pid2)} paid=${paidOf(pid2)}c`);
    ok('four simultaneous deliveries of ONE payment grant one pack',
      extraOf(pid2) === 12, `extra_photos=${extraOf(pid2)}, expected 12`);
    ok('...and charge it once', paidOf(pid2) === 300, `amount_paid_cents=${paidOf(pid2)}, expected 300`);
  }

  group('Nothing is granted for a session that never settled');
  {
    const { pid } = await guestOn(ev.joinCode, 'Never Paid');
    const rs = deliver([
      sessionCompleted({ id: `evt_${UNIQ}_unpaid`, intent: `pi_${UNIQ}_unpaid`, participantId: pid, status: 'unpaid' }),
      sessionCompleted({ id: `evt_${UNIQ}_nostat`, intent: `pi_${UNIQ}_nostat`, participantId: pid, status: 'no_payment_required' }),
    ]);
    ok('both are acknowledged', rs.every((r) => r.status === 200), JSON.stringify(bin(rs)));
    // 'no_payment_required' IS settled (a genuine 100%-off comp), 'unpaid' never is.
    ok('an unpaid session grants nothing, a $0 comp grants its pack',
      extraOf(pid) === 12, `extra_photos=${extraOf(pid)}, expected 12`);
    ok('...and a comp records no money', paidOf(pid) === 300, `amount_paid_cents=${paidOf(pid)}`);
  }

  group('The guest’s own address is never overwritten by the card’s');
  {
    // A guest who gave us an address at join keeps it — it is what they type to recover the roll on
    // another device, so the billing email must not replace it.
    const { pid: known } = await guestOn(ev.joinCode, 'Has Email');
    dbq(`UPDATE participants SET email='mine_${UNIQ}@example.com' WHERE id='${known}'`);
    deliver([sessionCompleted({ id: `evt_${UNIQ}_email_keep`, intent: `pi_${UNIQ}_email_keep`,
      participantId: known, email: `card_${UNIQ}@example.com` })]);
    ok('the guest’s own address survives the top-up', emailOf(known) === `mine_${UNIQ}@example.com`, emailOf(known));
    ok('...and the card’s address is kept separately', upEmailOf(known) === `card_${UNIQ}@example.com`, upEmailOf(known));

    // A guest who gave us none gets the card's, which is the only address we have for them.
    const { pid: blank } = await guestOn(ev.joinCode, 'No Email');
    ok('joined without an address', emailOf(blank) === '', emailOf(blank));
    deliver([sessionCompleted({ id: `evt_${UNIQ}_email_fill`, intent: `pi_${UNIQ}_email_fill`,
      participantId: blank, email: `card2_${UNIQ}@example.com` })]);
    ok('a blank address is filled from the card', emailOf(blank) === `card2_${UNIQ}@example.com`, emailOf(blank));
  }

  group('An unknown participant is acknowledged, never credited');
  {
    const rs = deliver([sessionCompleted({ id: `evt_${UNIQ}_nobody`, intent: `pi_${UNIQ}_nobody`,
      participantId: `no-such-participant-${UNIQ}` })]);
    ok('acknowledged rather than retried forever', rs[0].status === 200, JSON.stringify(rs));
  }
});

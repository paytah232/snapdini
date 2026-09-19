// Snapdini integration spec — 'Sending: who was mailed, who was NOT, and why'.
//
// This is the one feature in 1.5.0 that puts mail in real people's inboxes, so the things worth
// asserting are not the happy path — they are the refusals:
//
//  • A SUPPRESSED ADDRESS IS `skipped`, NEVER COUNTED AS `sent`. Two different refusals reach the
//    same place: the GLOBAL list (a bounce, a complaint, "never email me again") and this event's
//    own opt-outs. Both are reported back BY ADDRESS AND BY REASON — "we sent 19 of your 20" with
//    no explanation is how a guest ends up never invited and nobody finding out until the day.
//  • ONE GALLERY LINK PER ADDRESS, EVER (share_sends + the two partial unique indexes from 0052).
//    Two presses of Send, or the host's blast landing alongside the automatic guest delivery, used
//    to put the same link in the same inbox twice.
//  • AN ORGANIZER CODE ALONE CANNOT SEND. The product HANDS ONE OUT: POST /api/events/demo mints
//    an event with no account and no payment and returns its organizer code to whoever asked. Every
//    other organizer route is fine on that capability; putting caller-supplied text in
//    caller-supplied inboxes from a domain carrying our SPF, DKIM and DMARC is not.
//  • AND A DEMO REPORTS SUCCESS AND MAILS NOBODY. Refusing it would put a red error on the one
//    feature the demo exists to demonstrate, so it takes the same path, records the same rows and
//    returns the same shape — and the transport is never called.
//  • THE LEDGER ROW IS CORRECTED TO ok:false WHEN THE SEND DOES NOT HAPPEN. The claim row is
//    written `ok: true` BEFORE the send, so anything that is not a delivery has to go back and fix
//    it — and under 0052 that row is the address's ONE row for ever, so a false `ok: true` would
//    refuse them the real link later, permanently.
//
// ── THIS SPEC SENDS NO REAL MAIL, AND DOES NOT DEPEND ON ANY LEAVING ───────────────────────────
// Every address is @example.com with a per-run unique prefix (IANA-reserved; it has no MX record,
// and devel's Mailgun sandbox refuses any recipient that is not on its authorised list). The
// suppression path is exercised by writing the suppression row DIRECTLY rather than provoking a
// real bounce, which is also the only way to get a deterministic one. Every assertion is on the
// API's own accounting and on the database — counts, ledger rows, suppression state — never on
// delivery, so nothing here changes on a machine with no transport at all.
//
// The single mailable guest is asserted as an INVARIANT rather than an outcome: exactly one send
// was attempted, exactly one ledger row exists for it, and its recorded status agrees with the
// count the route returned. That holds whether the transport accepted it, refused it, or was not
// there to ask.
import { api, createEvent, dbq, group, ok, org, session, spec, UNIQ } from '../lib/harness.mjs';

const addr = (tag) => `${tag}_${UNIQ}@example.com`;
const MS = () => Number(dbq('SELECT (extract(epoch from now())*1000)::bigint'));
/** The invite token is the webhook's join key AND the bearer token in the guest's unsubscribe
 *  links, so its shape is load-bearing (UNSUB_TOKEN_RE in unsubscribe.ts pins the same thing). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const list   = (ev)       => api('GET',  `/api/events/${ev.joinCode}/guests`, { headers: org(ev.organizerCode) });
const add    = (ev, body) => api('POST', `/api/events/${ev.joinCode}/guests`, { body, headers: org(ev.organizerCode) });
const invite = (ev, body = {}) => api('POST', `/api/events/${ev.joinCode}/guests/invite`, { body, headers: org(ev.organizerCode) });
const emailLink = (ev, body) => api('POST', `/api/events/${ev.joinCode}/email-link`, { body, headers: org(ev.organizerCode) });

const invitesFor = (ev) => Number(dbq(`SELECT count(*) FROM guest_invites WHERE event_id='${ev.id}'`));
/** Every ledger row this address has, as a comma-joined list of its `ok` flags — so "how many
 *  rows" and "what do they claim" are one read and one failure message. `<none>` when there are no
 *  rows at all, which must never be confused with one row saying false. */
const sendsFor = (ev, email) =>
  dbq(`SELECT coalesce(string_agg(ok::text, ',' ORDER BY id), '<none>') FROM share_sends
       WHERE event_id='${ev.id}' AND lower(btrim(email))='${email}'`);

await spec('19-guest-invites', async () => {
  try {
    const ev = await createEvent();

    group('An empty list is refused before anything is sent');
    {
      const none = await invite(ev);
      ok('a send with nobody on the list is a 400', none.status === 400, `status ${none.status}`);
      ok('and says so in words', none.json?.error === 'Nobody to send to', JSON.stringify(none.json).slice(0, 120));
      ok('and wrote no ledger rows', invitesFor(ev) === 0, `${invitesFor(ev)}`);
    }

    group('Two ways to be un-mailable, one place they are reported');
    // Written directly rather than provoked: a real bounce needs a real recipient, and the
    // suppression row is the state the send path actually reads.
    dbq(`INSERT INTO email_suppressions (email, reason, detail, created_at)
         VALUES ('${addr('bounced')}', 'bounced', '550 no such user', ${MS()})`);
    await add(ev, { name: 'Dead Address', email: addr('bounced') });
    // The narrower refusal: this guest asked to hear nothing more about THIS event. They have not
    // bounced and are not globally suppressed, so a send path reading only the global table would
    // show them as perfectly mailable right up until it mailed them.
    await add(ev, { name: 'Asked To Stop', email: addr('optout') });
    dbq(`INSERT INTO guest_unsubscribes (event_id, email, scope, source, created_at, updated_at)
         VALUES ('${ev.id}', '${addr('optout')}', 'event', 'page', ${MS()}, ${MS()})`);
    const mailable = await add(ev, { name: 'Mailable', email: addr('mailable') });
    const mailableId = (mailable.json.guests || []).find((g) => g.email === addr('mailable')).id;
    {
      const before = (await list(ev)).json;
      const byEmail = Object.fromEntries((before.guests || []).map((g) => [g.email, g]));
      ok('the list flags a globally suppressed guest, with the provider’s own reason',
        byEmail[addr('bounced')]?.suppressed?.reason === 'bounced'
        && byEmail[addr('bounced')]?.suppressed?.scope === 'global',
        JSON.stringify(byEmail[addr('bounced')]?.suppressed));
      ok('and the detail travels with the flag, so the host knows what to DO about it',
        byEmail[addr('bounced')]?.suppressed?.detail === '550 no such user',
        JSON.stringify(byEmail[addr('bounced')]?.suppressed));
      ok('an event-scoped opt-out is flagged too, and says it is event-scoped',
        byEmail[addr('optout')]?.suppressed?.reason === 'unsubscribed'
        && byEmail[addr('optout')]?.suppressed?.scope === 'event',
        JSON.stringify(byEmail[addr('optout')]?.suppressed));
      ok('while the mailable guest is flagged as nothing', byEmail[addr('mailable')]?.suppressed === null,
        JSON.stringify(byEmail[addr('mailable')]?.suppressed));
      ok('and this deployment has email configured at all, or none of this could be asserted',
        before.emailEnabled === true, String(before.emailEnabled));
      ok('with the list saying honestly whether a "sent" here will ever become anything else',
        typeof before.deliveryTracking === 'boolean', String(before.deliveryTracking));
    }

    group('A suppressed address is skipped — never counted as sent');
    {
      const r = await invite(ev);
      ok('the send itself succeeds', r.status === 200, `status ${r.status} ${JSON.stringify(r.json?.error || '').slice(0, 120)}`);
      const skipped = Object.fromEntries((r.json?.skipped || []).map((s) => [s.email, s]));
      ok('both refusals come back, by address', Object.keys(skipped).length === 2,
        JSON.stringify(r.json?.skipped));
      ok('the bounced address is reported with the reason it bounced',
        skipped[addr('bounced')]?.reason === 'bounced', JSON.stringify(skipped[addr('bounced')]));
      ok('the opt-out is reported as an unsubscribe',
        skipped[addr('optout')]?.reason === 'unsubscribed', JSON.stringify(skipped[addr('optout')]));
      ok('and each carries the guest’s NAME, so the host can find them on their own list',
        skipped[addr('bounced')]?.name === 'Dead Address' && skipped[addr('optout')]?.name === 'Asked To Stop',
        JSON.stringify(r.json?.skipped));

      // THE assertion. `sent` may only ever mean "this many messages left the building" — a
      // suppressed address folded into it is a delivery the host is shown that never happened.
      ok('exactly ONE of the three was even attempted', (r.json?.sent || 0) + (r.json?.failed || 0) === 1,
        `sent=${r.json?.sent} failed=${r.json?.failed} skipped=${(r.json?.skipped || []).length}`);
      ok('and every guest is accounted for exactly once',
        (r.json?.sent || 0) + (r.json?.failed || 0) + (r.json?.skipped || []).length === 3,
        JSON.stringify({ sent: r.json?.sent, failed: r.json?.failed, skipped: (r.json?.skipped || []).length }));

      // The ledger is the other half: a skipped address must leave no trace of a message, because a
      // guest_invites row is the record that something was SENT to them.
      ok('one ledger row was written, and only one', invitesFor(ev) === 1, `${invitesFor(ev)}`);
      ok('and it belongs to the guest who was actually mailable',
        dbq(`SELECT email FROM guest_invites WHERE event_id='${ev.id}'`) === addr('mailable'));
      ok('neither suppressed address has an invite recorded against it',
        dbq(`SELECT count(*) FROM guest_invites WHERE event_id='${ev.id}'
             AND email IN ('${addr('bounced')}', '${addr('optout')}')`) === '0');

      const row = dbq(`SELECT status || '|' || coalesce(provider,'<NULL>') || '|' || token || '|' || coalesce(guest_id,'<NULL>')
                       FROM guest_invites WHERE event_id='${ev.id}'`).split('|');
      ok('the row records WHICH transport carried it — that is what a "sent" means here',
        row[1] === 'mailgun' || row[1] === 'smtp', row.join('|'));
      ok('and mints its own correlation token before the send, so a lost provider reply cannot orphan it',
        UUID_V4.test(row[2] || ''), row[2]);
      ok('and links back to the guest on the list', row[3] === mailableId, `${row[3]} vs ${mailableId}`);
      // Whichever way the transport went, the recorded status and the returned count must agree.
      // They are the same fact written down twice, and the bug worth catching is them disagreeing.
      ok('the recorded status agrees with the count the host was shown',
        (row[0] === 'sent') === (r.json?.sent === 1), `status ${row[0]} vs sent=${r.json?.sent}`);
      ok('and it is one of the words the schema defines', ['sent', 'failed'].includes(row[0]), row[0]);

      const shown = (r.json?.guests || []).find((g) => g.email === addr('mailable'));
      ok('the list comes back with the send already on the guest’s row',
        shown?.lastInvite?.status === row[0], JSON.stringify(shown?.lastInvite));
    }

    group('Removing a guest does not erase the evidence they were mailed');
    {
      // guest_id is ON DELETE SET NULL, and the address is denormalised onto the invite precisely
      // so the record still reads after the guest row is gone — otherwise a bounce the host still
      // has to act on disappears along with the typo that caused it.
      const del = await api('DELETE', `/api/events/${ev.joinCode}/guests/${mailableId}`, { headers: org(ev.organizerCode) });
      ok('the guest is removed', del.status === 200
        && dbq(`SELECT count(*) FROM event_guests WHERE id='${mailableId}'`) === '0', `status ${del.status}`);
      ok('but the invite survives, with the address it went to',
        dbq(`SELECT email FROM guest_invites WHERE event_id='${ev.id}'`) === addr('mailable'));
      ok('and its link to the guest is cleared rather than the row being taken with them',
        dbq(`SELECT coalesce(guest_id,'<NULL>') FROM guest_invites WHERE event_id='${ev.id}'`) === '<NULL>');
    }

    group('One gallery link per address, ever — and a send that did not happen says so');
    {
      // A suppressed recipient, so this whole group is decided by the suppression chokepoint and
      // never reaches a transport: sendMail RETURNS {suppressed:true} rather than throwing.
      const first = await emailLink(ev, { emails: [addr('bounced')] });
      ok('the host is told it was not sent', first.status === 200
        && first.json?.sent === 0 && first.json?.errors === 0 && first.json?.skipped === 1,
        JSON.stringify(first.json));
      // The claim row went in `ok: true` BEFORE the send. Withheld is not delivered, so it has to
      // have been corrected — and `ok` is exactly what both readers of this ledger count.
      ok('and the ledger row it claimed is corrected to ok:false', sendsFor(ev, addr('bounced')) === 'false',
        sendsFor(ev, addr('bounced')));

      const second = await emailLink(ev, { emails: [addr('bounced')] });
      ok('pressing Send again still sends nothing', second.json?.sent === 0 && second.json?.skipped === 1,
        JSON.stringify(second.json));
      ok('and does NOT write a second row for the same address (0052)',
        sendsFor(ev, addr('bounced')) === 'false', sendsFor(ev, addr('bounced')));

      // A resend is the host saying they meant it. The old row is cleared so the new attempt can
      // claim its place — one row per address per link is preserved, not bypassed.
      const resent = await emailLink(ev, { emails: [addr('bounced')], resend: true });
      ok('an explicit resend re-attempts rather than skipping the ledger check',
        resent.json?.sent === 0 && resent.json?.skipped === 1, JSON.stringify(resent.json));
      ok('and there is STILL exactly one row for that address, still ok:false',
        sendsFor(ev, addr('bounced')) === 'false', sendsFor(ev, addr('bounced')));

      // Case-folding: the ledger's unique index is on lower(btrim(email)) because both readers key
      // their set that way. An index on the raw column would let Mum@x.com through twice.
      const cased = await emailLink(ev, { emails: [`BOUNCED_${UNIQ}@Example.COM`] });
      ok('the same address in a different case is the same address to the ledger',
        cased.json?.sent === 0 && cased.json?.skipped === 1 && sendsFor(ev, addr('bounced')) === 'false',
        `${JSON.stringify(cased.json)} rows=${sendsFor(ev, addr('bounced'))}`);

      // An address with nothing standing in its way. Whether the transport takes it is not this
      // spec's business — that exactly one row exists for it afterwards, and that the row's `ok`
      // agrees with what the host was told, is.
      const fresh = await emailLink(ev, { emails: [addr('linked')] });
      ok('an unblocked address is attempted exactly once',
        (fresh.json?.sent || 0) + (fresh.json?.errors || 0) + (fresh.json?.skipped || 0) === 1,
        JSON.stringify(fresh.json));
      // One row, and its flag is the same fact the host was shown. `sendsFor` returns every row's
      // flag joined, so a second row would read "false,false" and fail this outright.
      ok('leaving exactly one ledger row, whose ok flag says whether the message actually left',
        sendsFor(ev, addr('linked')) === String(fresh.json?.sent === 1),
        `rows=[${sendsFor(ev, addr('linked'))}] sent=${fresh.json?.sent} errors=${fresh.json?.errors}`);

      const again = await emailLink(ev, { emails: [addr('linked')] });
      ok('and a second press sends nothing more', (again.json?.sent || 0) === 0, JSON.stringify(again.json));
      ok('with still exactly one row for that address',
        sendsFor(ev, addr('linked')) === String(fresh.json?.sent === 1), sendsFor(ev, addr('linked')));

      // A SEND THAT FAILED MUST BE RETRYABLE.
      //
      // markNotSent() leaves the row in place at ok:false, and the claim used to conflict with it
      // rather than reclaim it — so one transient SMTP 4xx locked that address out of every future
      // press, silently, counted as "skipped". The `resend: true` escape hatch works but no client
      // ever sends it, so a host had no way back. Forcing the flag here is exactly the state a
      // failed transport leaves behind.
      dbq(`UPDATE share_sends SET ok = false WHERE event_id='${ev.id}'
           AND lower(btrim(email)) = lower(btrim('${addr('linked')}'))`);
      const retried = await emailLink(ev, { emails: [addr('linked')] });
      ok('an address whose last attempt FAILED is attempted again',
        (retried.json?.sent || 0) + (retried.json?.errors || 0) === 1,
        JSON.stringify(retried.json));
      ok('\u2026and it is still one row, reclaimed rather than duplicated',
        dbq(`SELECT count(*) FROM share_sends WHERE event_id='${ev.id}'
             AND lower(btrim(email)) = lower(btrim('${addr('linked')}'))`).trim() === '1',
        dbq(`SELECT count(*) FROM share_sends WHERE event_id='${ev.id}'
             AND lower(btrim(email)) = lower(btrim('${addr('linked')}'))`));
    }


    group('An organizer code alone cannot put mail in anybody’s inbox');
    {
      // The SAME event and the SAME organizer code that worked above — only the session is gone.
      // That is the whole difference between a capability and an identity, and it is what stops a
      // leaked (or handed-out) code being a relay.
      const before = invitesFor(ev);
      const saved = session.cookie;
      session.cookie = '';
      const anon = await invite(ev);
      session.cookie = saved;
      ok('a send with no signed-in host is refused', anon.status === 403, `status ${anon.status} ${JSON.stringify(anon.json).slice(0, 160)}`);
      ok('and the refusal tells a REAL host what to do about it', /[Ss]ign in/.test(anon.json?.error || ''), anon.json?.error);
      ok('and nothing was recorded, so nothing was attempted', invitesFor(ev) === before, `${invitesFor(ev)} vs ${before}`);
      // …and the owner, with the same code, still sends. Without this the line above proves nothing.
      // A guest of its own, because by this point in the spec the earlier ones have been used up.
      const fresh = await add(ev, { name: 'Still Works', email: addr('stillworks') });
      const freshId = (fresh.json.guests || []).find((g) => g.email === addr('stillworks')).id;
      const owned = await invite(ev, { guestIds: [freshId] });
      ok('the owner’s own send still works', owned.status === 200, `status ${owned.status} ${JSON.stringify(owned.json).slice(0, 160)}`);
    }

    group('A DEMO event reports success and mails nobody — the regression that matters most');
    {
      // Minted the way a stranger does it: no account, no session, one unauthenticated POST.
      const saved = session.cookie;
      session.cookie = '';
      const d = await api('POST', '/api/events/demo');
      ok('anyone can still mint a demo', d.status === 200 && !!d.json?.organizerCode, `status ${d.status}`);
      const demo = { joinCode: d.json.joinCode, organizerCode: d.json.organizerCode };
      demo.id = dbq(`SELECT id FROM events WHERE join_code='${demo.joinCode}'`);

      const add1 = await api('POST', `/api/events/${demo.joinCode}/guests`,
        { body: { name: 'Stranger', email: addr('visitor') }, headers: org(demo.organizerCode) });
      ok('a stranger can put an address on its list', add1.status === 200, `status ${add1.status}`);

      const s = await api('POST', `/api/events/${demo.joinCode}/guests/invite`,
        { body: {}, headers: org(demo.organizerCode) });
      session.cookie = saved;

      // ── What the caller sees: a delivery, indistinguishable from a real one ──
      ok('the send succeeds', s.status === 200, `status ${s.status} ${JSON.stringify(s.json).slice(0, 200)}`);
      ok('and reports one sent, none failed', s.json?.sent === 1 && s.json?.failed === 0,
        JSON.stringify({ sent: s.json?.sent, failed: s.json?.failed }));
      ok('the guest row reads as delivered, so the feature demonstrates itself',
        s.json?.guests?.[0]?.lastInvite?.status === 'sent', JSON.stringify(s.json?.guests?.[0]?.lastInvite));
      // The marker lives in the row and in nothing the caller can read. A response that leaked it
      // would make the demo a worse demo AND tell an abuser exactly which events are pointless.
      ok('and NOTHING in the response says it was faked',
        !/mailed/i.test(JSON.stringify(s.json || {})), JSON.stringify(s.json?.invites || []).slice(0, 200));

      // ── What the database says: nothing was handed to a transport ──
      ok('the recorded row is marked as never mailed',
        dbq(`SELECT bool_and(NOT mailed) FROM guest_invites WHERE event_id='${demo.id}'`) === 't',
        dbq(`SELECT string_agg(mailed::text, ',') FROM guest_invites WHERE event_id='${demo.id}'`));
      ok('and carries no provider message id, so no webhook can ever match it',
        dbq(`SELECT count(*) FROM guest_invites WHERE event_id='${demo.id}' AND provider_message_id IS NOT NULL`) === '0');
      // THE CONTRAST. A real send on a real event writes mailed=true whatever the transport says
      // back — this run’s sandbox refuses every @example.com address, and those rows still read
      // true, because a refusal is an attempt. The demo’s row reads false because there was no
      // attempt to refuse.
      ok('a real send on a real event is recorded as mailed',
        dbq(`SELECT bool_and(mailed) FROM guest_invites WHERE event_id='${ev.id}'`) === 't',
        dbq(`SELECT string_agg(DISTINCT mailed::text, ',') FROM guest_invites WHERE event_id='${ev.id}'`));
      ok('and the operator’s month-to-date count ignores the demo’s rows',
        dbq(`SELECT count(*) FROM guest_invites WHERE event_id='${demo.id}' AND mailed`) === '0');

      dbq(`DELETE FROM events WHERE id='${demo.id}'`);
    }

    group('A list longer than one press says so, and a second press finishes it');
    {
      // Run on a DEMO, which is the only way to exercise a full 200-recipient batch without
      // attempting 200 real sends: the batch arithmetic is identical and the transport is untouched.
      const saved = session.cookie;
      session.cookie = '';
      const d = await api('POST', '/api/events/demo');
      const big = { joinCode: d.json.joinCode, organizerCode: d.json.organizerCode };
      big.id = dbq(`SELECT id FROM events WHERE join_code='${big.joinCode}'`);
      // 250 guests, written straight in: the import endpoint is spec 18's subject, not this one's.
      dbq(`INSERT INTO event_guests (id, event_id, name, email, notes, created_at, updated_at)
           SELECT gen_random_uuid()::text, '${big.id}', 'G' || n, 'bulk' || lpad(n::text,3,'0') || '_${UNIQ}@example.com',
                  NULL, ${MS()}, ${MS()} FROM generate_series(1, 250) n`);

      const first = await api('POST', `/api/events/${big.joinCode}/guests/invite`, { body: {}, headers: org(big.organizerCode) });
      ok('one press sends the batch, not the list', first.json?.sent === 200, `sent ${first.json?.sent}`);
      ok('and SAYS how many it did not attempt — the fifty that used to vanish',
        first.json?.notSent === 50, `notSent ${first.json?.notSent}`);
      ok('and names the batch size, so the UI need not hardcode it', first.json?.perSend === 200, `perSend ${first.json?.perSend}`);

      const second = await api('POST', `/api/events/${big.joinCode}/guests/invite`, { body: {}, headers: org(big.organizerCode) });
      ok('a second press reaches the people the first could not', second.status === 200, `status ${second.status}`);
      ok('every one of the 250 now has an invite recorded',
        dbq(`SELECT count(DISTINCT guest_id) FROM guest_invites WHERE event_id='${big.id}'`) === '250',
        dbq(`SELECT count(DISTINCT guest_id) FROM guest_invites WHERE event_id='${big.id}'`));

      // THE POINT OF THE SECOND PRESS, which the DISTINCT count above cannot see.
      //
      // The batch used to be filled up with people who already had an invite once the un-invited ran
      // out: press two mailed the remaining 50 AND 150 second copies, and `notSent` was measured
      // against the whole list so it answered "50 still to go" for ever. A host following the
      // instruction on screen sent ~750 messages to 250 people before the per-event cap stopped
      // them. Every one of those assertions passes on the broken code except these.
      ok('the second press mails only the fifty that were left — no second copies',
        second.json?.sent === 50, `sent ${second.json?.sent}`);
      ok('\u2026and stops telling the host there is more to do',
        second.json?.notSent === 0, `notSent ${second.json?.notSent}`);
      ok('so exactly 250 invites were attempted in total, not 400',
        dbq(`SELECT count(*) FROM guest_invites WHERE event_id='${big.id}'`) === '250',
        dbq(`SELECT count(*) FROM guest_invites WHERE event_id='${big.id}'`));

      const third = await api('POST', `/api/events/${big.joinCode}/guests/invite`, { body: {}, headers: org(big.organizerCode) });
      ok('and a third press mails nobody at all — the list is done',
        third.json?.sent === 0 && third.json?.notSent === 0,
        `sent ${third.json?.sent} notSent ${third.json?.notSent}`);
      ok('with no extra rows written for it',
        dbq(`SELECT count(*) FROM guest_invites WHERE event_id='${big.id}'`) === '250');

      session.cookie = saved;
      dbq(`DELETE FROM events WHERE id='${big.id}'`);
    }

    group('A lifetime cap per event, and a daily one per account');
    {
      const capped = await createEvent();
      await add(capped, { name: 'One Guest', email: addr('capped') });
      // The cap for a one-guest list is the floor, 100. Seeded directly rather than by pressing
      // Send a hundred times: what is being tested is the refusal, not the counting of real sends.
      dbq(`INSERT INTO guest_invites (id, event_id, guest_id, email, status, provider, token,
                                      provider_message_id, reason, severity, mailed, sent_at, updated_at, event_at)
           SELECT gen_random_uuid()::text, '${capped.id}', NULL, 'seed' || n || '_${UNIQ}@example.com',
                  'sent', 'mailgun', gen_random_uuid()::text, NULL, NULL, NULL, true, ${MS()}, ${MS()}, NULL
           FROM generate_series(1, 100) n`);
      const over = await invite(capped);
      ok('the hundred-and-first invite on a small event is refused', over.status === 429,
        `status ${over.status} ${JSON.stringify(over.json).slice(0, 200)}`);
      ok('nothing was sent', /Nothing was sent/.test(over.json?.error || ''), over.json?.error);
      ok('and the host is told where to go rather than just "no"',
        /support@/.test(over.json?.error || ''), over.json?.error);
      ok('and no row was written for the refused press',
        invitesFor(capped) === 100, `${invitesFor(capped)}`);

      // The account cap is the backstop for making MORE events: the rows below belong to a
      // different event owned by the same test user, and they still count.
      const other = await createEvent();
      await add(other, { name: 'Fresh', email: addr('fresh') });
      dbq(`INSERT INTO guest_invites (id, event_id, guest_id, email, status, provider, token,
                                      provider_message_id, reason, severity, mailed, sent_at, updated_at, event_at)
           SELECT gen_random_uuid()::text, '${capped.id}', NULL, 'day' || n || '_${UNIQ}@example.com',
                  'sent', 'mailgun', gen_random_uuid()::text, NULL, NULL, NULL, true, ${MS()}, ${MS()}, NULL
           FROM generate_series(1, 2000) n`);
      const day = await invite(other);
      ok('a fresh event on an account that has already mailed 2100 people today is refused',
        day.status === 429, `status ${day.status} ${JSON.stringify(day.json).slice(0, 200)}`);
      ok('and says it is the account, not the event', /last 24 hours/.test(day.json?.error || ''), day.json?.error);
      ok('and still nothing was sent', invitesFor(other) === 0, `${invitesFor(other)}`);
    }

    group('The delivery webhook refuses what it cannot verify');
    {
      // Public by necessity, so it is verified before anything else. 406 rather than 4xx-anything:
      // Mailgun treats 406 as "rejected, do not retry", and a bad signature is permanent — eight
      // hours of retries against forged traffic is a free amplifier.
      const forged = await api('POST', '/api/webhooks/mailgun', {
        body: {
          signature: { timestamp: '1700000000', token: 'f'.repeat(50), signature: 'deadbeef'.repeat(8) },
          'event-data': { event: 'bounced', severity: 'permanent', recipient: addr('forged') },
        },
      });
      ok('a forged signature is refused with 406, the one status Mailgun will not retry',
        forged.status === 406, `status ${forged.status} ${JSON.stringify(forged.json).slice(0, 120)}`);
      ok('and says why', forged.json?.error === 'signature verification failed', JSON.stringify(forged.json).slice(0, 120));
      ok('and it suppressed nothing on the strength of an unverified bounce',
        dbq(`SELECT count(*) FROM email_suppressions WHERE email='${addr('forged')}'`) === '0');
    }
  } finally {
    // email_suppressions is GLOBAL — no event, no owner — so nothing else in teardown can reach it.
    // Every address this spec touched carries the per-run unique prefix, so this takes exactly its
    // own rows and nobody else's, and it runs even when an assertion above throws.
    dbq(`DELETE FROM email_suppressions WHERE email LIKE '%${UNIQ}%'`);
  }
});

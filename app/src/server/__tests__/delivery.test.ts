// The delivery state machine and the suppression rules.
//
// These are the two places where being wrong is expensive in a way that is invisible at the time:
// a mis-ordered webhook shows a host "delivered" for an address that is dead, and a suppression
// rule that is too eager or too lax either loses real guests or burns the sending domain. Neither
// failure announces itself — the first one a host hears is that nobody got the invite.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldApply, suppresses, suppressionReason, rankOf, normaliseAddress, describe as describeStatus,
         quarantined, QUARANTINE_NOTE, type DeliveryStatus } from '../delivery';

const ALL: DeliveryStatus[] = ['sent', 'failed', 'delivered', 'unsubscribed', 'bounced', 'complained'];

describe('shouldApply — webhooks arrive out of order and more than once', () => {
  test('the ordinary forward path', () => {
    assert.equal(shouldApply('sent', 'delivered', 200, 100), true);
    assert.equal(shouldApply('sent', 'failed', 200, 100), true);
    assert.equal(shouldApply('sent', 'bounced', 200, 100), true);
  });

  test('a permanent bounce overwrites a delivery even when it is reported LATER', () => {
    // A forwarding rule accepts the message and bounces it on minutes afterwards. If the delivery
    // held, the host would keep mailing a dead address — the exact thing that ruins a domain.
    assert.equal(shouldApply('delivered', 'bounced', 999, 100), true);
    assert.equal(shouldApply('delivered', 'complained', 999, 100), true);
  });

  test('a bounce reported OUT OF ORDER — with an older timestamp — still wins', () => {
    // Rank beats time going up. Mailgun's retry queue really does deliver an older event after a
    // newer one, and "we heard about the bounce late" is not a reason to forget the bounce.
    assert.equal(shouldApply('delivered', 'bounced', 50, 100), true);
  });

  test('a TEMPORARY failure never downgrades a delivery', () => {
    // The single most dangerous mis-ordering: a deferral generated before the successful retry,
    // arriving after it. Showing "failed" on mail that arrived sends the host chasing a guest who
    // already has the invite — and, worse, re-sending to a perfectly good address.
    assert.equal(shouldApply('delivered', 'failed', 999, 100), false);
    assert.equal(shouldApply('bounced', 'failed', 999, 100), false);
    assert.equal(shouldApply('complained', 'delivered', 999, 100), false);
  });

  test('nothing displaces a complaint', () => {
    for (const s of ALL) {
      if (s === 'complained') continue;
      assert.equal(shouldApply('complained', s, 999, 1), false, `complained must survive ${s}`);
    }
  });

  test('redelivery of the SAME event is idempotent', () => {
    // Mailgun retries a webhook for hours. The same 'delivered' landing three times must not
    // rewrite the row three times, or the timestamp the host reads keeps moving for no reason.
    assert.equal(shouldApply('delivered', 'delivered', 100, 100), false);
    assert.equal(shouldApply('bounced', 'bounced', 100, 100), false);
  });

  test('at equal rank, only a strictly newer event wins', () => {
    assert.equal(shouldApply('delivered', 'delivered', 101, 100), true);
    assert.equal(shouldApply('delivered', 'delivered', 99, 100), false);
  });

  test('a missing timestamp at equal rank keeps what is already recorded', () => {
    // Unorderable, so the safe answer is "change nothing" rather than "assume this one is newer".
    assert.equal(shouldApply('delivered', 'delivered', null, 100), false);
    assert.equal(shouldApply('delivered', 'delivered', 100, null), false);
    // ...but rank still wins, because rank does not need a clock.
    assert.equal(shouldApply('delivered', 'bounced', null, 100), true);
  });

  test('the ranking is a total order with no ties', () => {
    const ranks = ALL.map(rankOf);
    assert.equal(new Set(ranks).size, ALL.length, 'two states share a rank — ordering would be ambiguous');
    assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, 'ALL is not in ascending rank order');
  });

  test('every state is reachable from sent', () => {
    for (const s of ALL) {
      if (s === 'sent') continue;
      assert.equal(shouldApply('sent', s, 200, 100), true, `sent → ${s} must be possible`);
    }
  });
});

describe('suppression — who must never be mailed again', () => {
  test('the three that suppress', () => {
    assert.equal(suppresses('bounced'), true);
    assert.equal(suppresses('complained'), true);
    assert.equal(suppresses('unsubscribed'), true);
  });

  test('a TEMPORARY failure must NOT suppress', () => {
    // This is the rule that costs real guests if it is wrong. A full mailbox, a greylisting, or an
    // hour of downtime would otherwise blacklist someone permanently — and silently, since the
    // host is never told why that person stopped receiving anything.
    assert.equal(suppresses('failed'), false);
    assert.equal(suppresses('sent'), false);
    assert.equal(suppresses('delivered'), false);
  });

  test('the suppression reason matches the status that caused it', () => {
    assert.equal(suppressionReason('bounced'), 'bounced');
    assert.equal(suppressionReason('complained'), 'complained');
    assert.equal(suppressionReason('unsubscribed'), 'unsubscribed');
    assert.equal(suppressionReason('failed'), null);
    assert.equal(suppressionReason('delivered'), null);
  });
});

describe('address normalisation', () => {
  test('case and surrounding space are removed, because suppression compares bytes', () => {
    // If this drifts, a suppressed "Mum@X.com " is re-mailed as "mum@x.com" and the suppression
    // list quietly does nothing.
    for (const s of [' Mum@X.com ', 'MUM@X.COM', 'mum@x.com\n', '\tmum@X.com']) {
      assert.equal(normaliseAddress(s), 'mum@x.com', JSON.stringify(s));
    }
  });

  test('a trailing dot is the DNS root label, not a different domain', () => {
    // `x.com.` is the fully-qualified spelling of `x.com` and every MTA delivers them to the same
    // place — and isEmail accepts both, so a host who types the dot got past a bounce we had on
    // record for the address without it. The only rewrite here that is a fact about DNS rather
    // than a guess about a provider.
    assert.equal(normaliseAddress('mum@x.com.'), 'mum@x.com');
    assert.equal(normaliseAddress(' Mum@X.COM. '), 'mum@x.com');
    assert.equal(normaliseAddress('mum@x.com..'), 'mum@x.com');
  });

  test('subaddressing and local-part dots are NOT collapsed, on purpose', () => {
    // Both are conventions of particular providers, not rules. RFC 5321 leaves the local part
    // opaque to everyone but the delivering host, and plenty of hosts deliver `mum+shop@` and
    // `m.um@` to mailboxes that have nothing to do with `mum@`. Collapsing them would mean one
    // person's spam complaint silently blocking a different real person's invitation — and
    // over-suppression is the failure nobody can see or report.
    assert.notEqual(normaliseAddress('mum+shop@x.com'), 'mum@x.com');
    assert.equal(normaliseAddress('Mum+Shop@X.com'), 'mum+shop@x.com');
    assert.notEqual(normaliseAddress('m.um@gmail.com'), 'mum@gmail.com');
    assert.equal(normaliseAddress('M.Um@Gmail.com'), 'm.um@gmail.com');
  });

  test('normalising is idempotent, because both sides of a suppression run through it', () => {
    // The rows are written normalised and the lookup key is built the same way. If one pass and two
    // passes disagreed, a row written by the webhook would not be found by the send that follows.
    for (const s of [' Mum+Shop@X.com. ', 'a@b.co', '', 'not an address']) {
      assert.equal(normaliseAddress(normaliseAddress(s)), normaliseAddress(s), JSON.stringify(s));
    }
  });
});

describe('how a state reads to the host', () => {
  test('"sent" means something different on a transport that cannot report back', () => {
    // The honest distinction. On SMTP no webhook is ever coming, so presenting 'sent' as if an
    // update were on its way is a lie the host would sit and wait on.
    assert.match(describeStatus('sent', 'mailgun').label, /awaiting/i);
    assert.match(describeStatus('sent', 'smtp').label, /unknown/i);
    assert.match(describeStatus('sent', null).label, /unknown/i);
  });

  test('the states a host must act on are marked bad, and a deferral is not', () => {
    assert.equal(describeStatus('bounced', 'mailgun').tone, 'bad');
    assert.equal(describeStatus('complained', 'mailgun').tone, 'bad');
    assert.equal(describeStatus('delivered', 'mailgun').tone, 'good');
    assert.equal(describeStatus('failed', 'mailgun').tone, 'warn');
  });

  test('every state has words, including one we do not recognise', () => {
    for (const s of ALL) assert.ok(describeStatus(s, 'mailgun').label.length > 0, s);
    assert.ok(describeStatus('nonsense' as DeliveryStatus, 'mailgun').label.length > 0);
  });
});

// ── The delivery that is not really a delivery ───────────────────────────────
//
// Mailgun reports a message Gmail quarantined as `delivered`, with a 2xx code. The only evidence is
// a phrase inside the receiving server's own reply, which normaliseEvent already stores in
// `guest_invites.reason`. Confirmed on a real send from this deployment. Read the status alone and
// delivery tracking shows a green tick for mail that went to spam — which is worse than showing
// nothing, because the host stops looking for the problem.

describe('a quarantined delivery is not reported as a clean one', () => {
  const OK_QUARANTINE = '2.0.0 OK DMARC:Quarantine';

  test('the exact string a real send produced', () => {
    assert.equal(quarantined('delivered', OK_QUARANTINE), true);
    assert.equal(describeStatus('delivered', 'mailgun', OK_QUARANTINE).label, 'Delivered to spam');
    // warn, not good and not bad: the message WAS accepted, so this is not a bounce — but the
    // guest has almost certainly not seen it, so it is not a tick either.
    assert.equal(describeStatus('delivered', 'mailgun', OK_QUARANTINE).tone, 'warn');
  });

  test('however the receiving server spells it', () => {
    for (const r of ['250 2.0.0 OK DMARC:Quarantine',
                     'dmarc=quarantine action=quarantine',
                     'ok - DMARC : QUARANTINE',
                     'Message accepted (dmarc:quarantine)']) {
      assert.equal(quarantined('delivered', r), true, r);
    }
  });

  test('and an ordinary delivery is left alone', () => {
    // The false-positive direction matters as much: telling a host their mail is being filtered
    // when it is not sends them off tuning DNS for nothing.
    for (const r of [null, '', '2.0.0 OK', '250 2.0.0 OK 1770146431 abc.12 - gsmtp',
                     'accepted for delivery', 'dmarc=pass', 'DMARC policy: none',
                     'spam score 0.1', 'quarantine folder cleanup']) {
      assert.equal(quarantined('delivered', r), false, JSON.stringify(r));
    }
    assert.equal(describeStatus('delivered', 'mailgun', '2.0.0 OK').label, 'Delivered');
    assert.equal(describeStatus('delivered', 'mailgun', '2.0.0 OK').tone, 'good');
  });

  test('only a delivery can be quarantined — every other state already says what happened', () => {
    for (const s of ALL) {
      if (s === 'delivered') continue;
      assert.equal(quarantined(s, OK_QUARANTINE), false,
        `${s} was relabelled as a quarantine; a bounce is not improved by mentioning DMARC`);
    }
    // And the labels for those states are untouched.
    assert.equal(describeStatus('bounced', 'mailgun', OK_QUARANTINE).label, 'Bounced');
    assert.equal(describeStatus('complained', 'mailgun', OK_QUARANTINE).label, 'Marked as spam');
  });

  test('describe() still works with no reason at all, because most callers have none', () => {
    assert.equal(describeStatus('delivered', 'mailgun').label, 'Delivered');
    assert.equal(describeStatus('delivered', 'mailgun', undefined as unknown as null).label, 'Delivered');
  });

  test('there is a sentence to show the host, not just a badge', () => {
    assert.match(QUARANTINE_NOTE, /spam/i);
    assert.ok(QUARANTINE_NOTE.length > 40, 'a note that does not say what happened is not a note');
  });
});

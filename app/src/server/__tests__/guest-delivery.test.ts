// Guest delivery: the rules that decide whether a stranger who came to somebody's wedding gets an
// email from us, and what is in it. Every test here stands for a way of getting that wrong that
// cannot be taken back once it has gone out.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_DELIVERY_MODES, parseGuestDelivery, parseGuestSendScope, effectiveGuestScope,
  revealOpensAt, guestLinkAt, clampGuestSendAt, guestReminderAt,
  dedupeRecipients, scopedVisibleCount, eventEndMessages, liveSendDue, sendToGuest,
  type GuestTiming, type GuestRecipient, type GuestDelivery,
} from '../guest-delivery';
import type { SendResult } from '../email';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 24, 8, 0);
const END = START + 6 * HOUR;

/** An event's timing fields, defaulting to what a brand-new one gets. */
const ev = (over: Partial<GuestTiming> = {}): GuestTiming => ({
  revealMode: 'at_end', revealedAt: null, revealHidden: false, revealAt: null,
  revealDelayHours: 0, startsAt: START, expiresAt: END,
  guestDelivery: 'all_on_reveal', guestSendAt: null, guestSendScope: 'all', ...over,
});

const guest = (n: number, over: Partial<{ email: string | null; wantsPhotos: boolean; name: string }> = {}) =>
  ({ id: `p${n}`, name: `Guest ${n}`, email: `guest${n}@example.com`, wantsPhotos: true, ...over });

// ── Withheld is not delivered ────────────────────────────────────────────────
//
// sendMail RETURNS `suppressed` rather than throwing, so that a caller can stamp its one-shot guard
// and record the truth instead of retrying a refusal forever. Every send loop in this file ignored
// it and ran `sent++` regardless. Three things were wrong at once and all of them were quiet: the
// host was shown a delivery that never happened, share_sends recorded the guest as holding a link
// they were never sent (so the "one link per address, ever" guard would refuse to send them the
// real one later), and the monthly Mailgun allowance was billed for paper. Nothing threw. Nothing
// logged. The three outcomes are separated here so they cannot quietly merge again.

describe('a message that was withheld is not a message that was sent', () => {
  // sendToGuest takes the built message as an object now — it gained a plain-text alternative part,
  // and (to, subject, html, text, eventId, what) is six strings in a row a caller can transpose.
  const MSG = { to: 'guest@example.com', subject: 'Subject', html: '<p>Body</p>', text: 'Body' };
  const send = (r: SendResult) =>
    sendToGuest(MSG, 'ev1', 'test', async () => r);
  const boom = () =>
    sendToGuest(MSG, 'ev1', 'test', async () => {
      throw new Error('provider 500');
    });

  test('a delivered message is "sent"', async () => {
    assert.equal(await send({ provider: 'mailgun', messageId: 'a@b' }), 'sent');
  });

  test('a suppressed address is "suppressed" — never "sent"', async () => {
    // The exact return the chokepoint gives for someone who unsubscribed.
    assert.equal(await send({ provider: 'mailgun', messageId: null, suppressed: true }), 'suppressed');
  });

  test('and it is not an error either, so nothing retries it', async () => {
    // This distinction is load-bearing. The sweeps give their one-shot guard BACK when a whole
    // batch fails, on the theory that the transport was down. If an opted-out guest counted as a
    // failure, an event whose recipients have all unsubscribed would unclaim and re-attempt itself
    // on every sweep, forever.
    const out = await send({ provider: 'mailgun', messageId: null, suppressed: true });
    assert.notEqual(out, 'failed');
  });

  test('a transport that throws is "failed", and is the only thing that is', async () => {
    assert.equal(await boom(), 'failed');
  });

  test('a send with no messageId but no suppression flag still counts as sent', async () => {
    // SMTP without a Message-ID header is a real, successful send. Inferring suppression from a
    // null id would silently stop counting every SMTP deployment's mail.
    assert.equal(await send({ provider: 'smtp', messageId: null }), 'sent');
  });
});

// ── The invariant: a link never arrives before the gallery opens ─────────────
// A guest who taps a link and lands on a locked page does not tap it again. There is no recovery
// from this one, so it is enforced three times: when the host picks the time, when the row is read,
// and at the moment of sending (isRevealed, exercised through sendGuestLink).

describe('a scheduled send is never earlier than the reveal', () => {
  const opens = END + 2 * DAY;

  test('a time before the reveal is moved up to it, and says so', () => {
    const r = clampGuestSendAt(opens - HOUR, opens);
    assert.equal(r.at, opens);
    assert.equal(r.clamped, true, 'clamped silently — the host would be shown a time they did not pick');
  });

  test('a time after the reveal is left exactly as chosen', () => {
    const r = clampGuestSendAt(opens + HOUR, opens);
    assert.equal(r.at, opens + HOUR);
    assert.equal(r.clamped, false);
  });

  test('the reveal instant itself is allowed — the floor is >=, not >', () => {
    const r = clampGuestSendAt(opens, opens);
    assert.equal(r.at, opens);
    assert.equal(r.clamped, false);
  });

  test('an unknown reveal cannot be clamped to, so the value stands and the send-time gate holds it', () => {
    // A manual reveal nobody has triggered: there is no instant to clamp against. Refusing to save
    // would be refusing a legitimate plan; sending early is prevented at the send instead.
    const r = clampGuestSendAt(END + DAY, null);
    assert.equal(r.at, END + DAY);
    assert.equal(r.clamped, false);
    assert.equal(revealOpensAt(ev({ revealMode: 'manual' })), null);
  });

  test('and the floor is applied AGAIN on read, because a host can move the reveal later', () => {
    // The value was clamped when it was written. Then the reveal moved out by a day and nothing
    // rewrote it. Reading it back must not hand the sweep a send that is now early.
    const e = ev({ guestDelivery: 'scheduled', guestSendAt: END + HOUR, revealMode: 'at_end', revealDelayHours: 48 });
    assert.equal(guestLinkAt(e), END + 48 * HOUR);
  });

  test('a hidden gallery has no release moment at all, so nothing is scheduled', () => {
    assert.equal(revealOpensAt(ev({ revealHidden: true, revealDelayHours: 24 })), null);
    assert.equal(guestLinkAt(ev({ revealHidden: true, revealDelayHours: 24 })), null);
  });
});

// ── Never a link onto an empty page ─────────────────────────────────────────

describe('what the chosen scope actually resolves to', () => {
  const rows = [
    { status: 'approved', isHighlighted: true },
    { status: 'approved', isHighlighted: false },
    { status: 'pending', isHighlighted: true },
    { status: 'rejected', isHighlighted: true },
  ];

  test("'all' counts what the gallery would show, by the gallery's own rule", () => {
    assert.equal(scopedVisibleCount(rows, 'all', false), 3);   // everything not binned
    assert.equal(scopedVisibleCount(rows, 'all', true), 2);    // only what a host approved
  });

  test("'favourites' narrows to the starred ones, still through that rule", () => {
    assert.equal(scopedVisibleCount(rows, 'favourites', false), 2);
    assert.equal(scopedVisibleCount(rows, 'favourites', true), 1);
  });

  test('a host who starred nothing resolves to zero — the empty-scope refusal', () => {
    // sendGuestLink turns this into refused:'empty_scope', mails the HOST instead of the guests,
    // and sends no link at all. This is the number that decides it.
    const unstarred = rows.map((r) => ({ ...r, isHighlighted: false }));
    assert.equal(scopedVisibleCount(unstarred, 'favourites', false), 0);
    assert.ok(scopedVisibleCount(unstarred, 'all', false) > 0, 'the whole gallery is not empty — only the favourites are');
  });

  test('an event where a host binned everything is empty in both scopes', () => {
    const binned = [{ status: 'rejected', isHighlighted: true }];
    assert.equal(scopedVisibleCount(binned, 'all', false), 0);
    assert.equal(scopedVisibleCount(binned, 'favourites', false), 0);
  });

  test("'favourites_manual' is a scope as well as a mode", () => {
    // A stale guest_send_scope of 'all' left over from an earlier choice must not quietly widen a
    // send the host narrowed.
    assert.equal(effectiveGuestScope({ guestDelivery: 'favourites_manual', guestSendScope: 'all' }), 'favourites');
    assert.equal(effectiveGuestScope({ guestDelivery: 'manual', guestSendScope: 'favourites' }), 'favourites');
    assert.equal(effectiveGuestScope({ guestDelivery: 'all_on_reveal', guestSendScope: 'all' }), 'all');
  });
});

// ── One email per address, and only to people who asked ─────────────────────

describe('who is a recipient', () => {
  test('two guests sharing one inbox are one email', () => {
    const rows = [guest(1, { email: 'Mum@example.com' }), guest(2, { email: 'mum@example.com' })];
    const out = dedupeRecipients(rows);
    assert.equal(out.length, 1, 'a shared inbox got two copies of the same message');
    assert.equal(out[0].email, 'Mum@example.com', 'kept the first form of the address');
  });

  test('a guest who never asked is not a recipient, whatever the host switched on', () => {
    assert.deepEqual(dedupeRecipients([guest(1, { wantsPhotos: false })]), []);
  });

  test('a guest who asked but left no address is not a recipient either', () => {
    assert.deepEqual(dedupeRecipients([guest(1, { email: null })]), []);
    assert.deepEqual(dedupeRecipients([guest(1, { email: '   ' })]), []);
  });

  test('and nothing that is not an address gets mailed', () => {
    for (const bad of ['not-an-email', 'a@b', '@example.com', 'a b@example.com']) {
      assert.deepEqual(dedupeRecipients([guest(1, { email: bad })]), [], `accepted ${bad}`);
    }
  });

  test('the ones who did ask, with an address, are kept in join order', () => {
    const out = dedupeRecipients([guest(1), guest(2, { wantsPhotos: false }), guest(3)]);
    assert.deepEqual(out.map((r) => r.email), ['guest1@example.com', 'guest3@example.com']);
  });
});

// ── The event-end message: exactly one, whatever the combination ────────────
// The rule the owner set: a guest must never get two emails at the end of an event. The thank-you
// and "email me my photos" are ONE message whose content varies — not two that might both fire.

describe('what a guest gets when the event ends', () => {
  const view = (over: Partial<Parameters<typeof eventEndMessages>[1]> = {}) => ({
    eventName: 'Ruby & Sam', hostName: 'Ruby', galleryUrl: 'https://snapdini.com/gallery/ABC123',
    timezone: 'Australia/Brisbane', thanks: true, releaseAt: null as number | null,
    ownPhotoCount: () => 4, ...over,
  });

  for (const thanks of [true, false]) {
    for (const optedIn of [true, false]) {
      test(`thanks ${thanks ? 'on' : 'off'} + ${optedIn ? 'opted in' : 'not opted in'} → ${optedIn ? 'exactly one email' : 'nothing'}`, () => {
        const recipients = dedupeRecipients([guest(1, { wantsPhotos: optedIn }), guest(2, { wantsPhotos: optedIn })]);
        const messages = eventEndMessages(recipients, view({ thanks }));
        assert.equal(messages.length, optedIn ? 2 : 0);
        // One per ADDRESS, and no address twice — the double-send this design rules out.
        assert.equal(new Set(messages.map((m) => m.to)).size, messages.length);
      });
    }
  }

  test('the opt-in is the gate, not the host toggle', () => {
    // A host with thank-yous OFF still owes a guest who asked for their photos that one message.
    const recipients = dedupeRecipients([guest(1)]);
    const off = eventEndMessages(recipients, view({ thanks: false }));
    assert.equal(off.length, 1);
    assert.match(off[0].subject, /Your photos from Ruby & Sam/);
    assert.ok(off[0].html.includes('https://snapdini.com/gallery/ABC123'));
  });

  test('with thank-yous on, one message carries the thanks AND their photos', () => {
    const messages = eventEndMessages(dedupeRecipients([guest(1)]), view({ thanks: true }));
    assert.equal(messages.length, 1);
    assert.match(messages[0].subject, /Thanks for coming to Ruby & Sam/);
    assert.ok(messages[0].html.includes('https://snapdini.com/gallery/ABC123'), 'no link to their photos');
    assert.ok(/You took <b>4 photos<\/b>/.test(messages[0].html), 'did not say what they took');
  });

  test('the release line appears only when a release moment is known and still ahead', () => {
    const ahead = Date.now() + 3 * DAY;
    const withRelease = eventEndMessages(dedupeRecipients([guest(1)]), view({ thanks: true, releaseAt: ahead }))[0].html;
    assert.ok(/become visible on/.test(withRelease), 'did not state the release moment');

    // Already happened: saying it would be nonsense, so it is left out rather than softened.
    const past = eventEndMessages(dedupeRecipients([guest(1)]), view({ thanks: true, releaseAt: Date.now() - DAY }))[0].html;
    assert.ok(!/become visible on/.test(past), 'promised a release that has already happened');

    // Unknown (a manual reveal nobody has triggered): also left out. No vague wording.
    const unknown = eventEndMessages(dedupeRecipients([guest(1)]), view({ thanks: true, releaseAt: null }))[0].html;
    assert.ok(!/become visible on/.test(unknown), 'invented a release moment');
    assert.ok(!/soon|shortly|in a while/i.test(unknown), 'hedged instead of saying nothing');
  });

  test('with thank-yous off there is no release framing at all', () => {
    const html = eventEndMessages(dedupeRecipients([guest(1)]), view({ thanks: false, releaseAt: Date.now() + 3 * DAY }))[0].html;
    assert.ok(!/become visible on/.test(html));
    assert.ok(!/Thanks for coming/.test(html));
  });

  test('a guest who took nothing is not told they took 0 photos', () => {
    const html = eventEndMessages(dedupeRecipients([guest(1)]), view({ ownPhotoCount: () => 0 }))[0].html;
    assert.ok(!/0 photos/.test(html), 'deflating and useless');
    assert.ok(html.includes('https://snapdini.com/gallery/ABC123'), 'still needs the link');
  });

  test('an event name cannot inject markup into a guest email', () => {
    const html = eventEndMessages(dedupeRecipients([guest(1)]), view({ eventName: '<img src=x onerror=alert(1)>' }))[0].html;
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img src=x'));
  });
});

// ── Sch 1 cl 3(1)(a): factual information only ──────────────────────────────
// One promotional line in any of these forfeits the designated-message exemption for every guest at
// every event, retrospectively. This is the test that notices.

describe('a guest email carries nothing but facts', () => {
  const html = () => eventEndMessages(dedupeRecipients([guest(1)]), {
    eventName: 'Ruby & Sam', hostName: 'Ruby', galleryUrl: 'https://snapdini.com/gallery/ABC123',
    timezone: null, thanks: true, releaseAt: Date.now() + DAY, ownPhotoCount: () => 4,
  })[0].html;

  test('no offer, no price, no pitch', () => {
    const banned = [/A\$\d/, /from \$/, /start your own/i, /create (your|an) event/i, /sign up/i,
                    /try (it|snapdini)/i, /upgrade/i, /discount/i, /% off/i, /free trial/i];
    for (const re of banned) assert.ok(!re.test(html()), `promotional content matched ${re}`);
  });

  test('no link anywhere but the gallery this guest is already in', () => {
    const hrefs = [...html().matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const h of hrefs) {
      assert.ok(h.startsWith('https://snapdini.com/gallery/') || h.startsWith('mailto:'),
        `a guest email linked somewhere else: ${h}`);
    }
  });

  test('but it does identify us and how to reach us — cl 3(2) permits exactly that', () => {
    assert.ok(/Snapdini/.test(html()), 'no sender name');
    assert.ok(/mailto:support@snapdini\.com/.test(html()), 'no contact address (s17)');
  });

  test('and it says why they are getting it, naming the event and the host', () => {
    assert.ok(/joined Ruby &amp; Sam, hosted by Ruby/.test(html()));
  });
});

// ── "Photos release tomorrow" ───────────────────────────────────────────────

describe('when the day-before reminder exists at all', () => {
  test('a release more than a day after the event ends gets one, a day before it', () => {
    const e = ev({ revealDelayHours: 48 });
    assert.equal(guestReminderAt(e), END + 48 * HOUR - DAY);
  });

  test('exactly 24 hours does NOT — it would land in the same breath as the event-end message', () => {
    // That message already names the release moment. A reminder arriving with the thing it is
    // reminding you about is the duplicate this whole design exists to avoid.
    assert.equal(guestReminderAt(ev({ revealDelayHours: 24 })), null);
  });

  test('nor does anything shorter', () => {
    for (const h of [0, 1, 6, 23]) assert.equal(guestReminderAt(ev({ revealDelayHours: h })), null, `${h}h got a reminder`);
  });

  test('an instant-reveal event has no release to remind anyone about', () => {
    assert.equal(guestReminderAt(ev({ revealMode: 'instant' })), null);
  });

  test('nor does a manual reveal the host has not triggered', () => {
    assert.equal(guestReminderAt(ev({ revealMode: 'manual' })), null);
  });

  test('a host-chosen reveal instant is used ahead of the delay rule', () => {
    const at = END + 5 * DAY;
    assert.equal(guestReminderAt(ev({ revealDelayHours: 1, revealAt: at })), at - DAY);
  });
});

// ── Send-once, and the event-end message counting as the release message ────

describe('whether the gallery link is sent by the sweep', () => {
  const later = END + 2 * DAY;

  test('at the release moment, once', () => {
    const e = ev({ revealDelayHours: 48 });
    assert.equal(liveSendDue(e, later - 1), 'wait');
    assert.equal(liveSendDue(e, later), 'send');
  });

  test('an instant-reveal event is already covered by the event-end message', () => {
    // The photos were visible all along and every opted-in guest has had the link. A second email
    // saying "the photos are ready" is the duplicate the owner ruled out — so the event is marked
    // done rather than sent again.
    assert.equal(liveSendDue(ev({ revealMode: 'instant' }), END + HOUR), 'covered');
  });

  test('so is a reveal that lands exactly at the end of the event', () => {
    assert.equal(liveSendDue(ev({ revealDelayHours: 0 }), END + HOUR), 'covered');
  });

  test('the two manual modes never send by themselves', () => {
    for (const mode of ['manual', 'favourites_manual'] as const) {
      assert.equal(liveSendDue(ev({ guestDelivery: mode, revealDelayHours: 48 }), later + DAY), 'never',
        `${mode} sent without the host asking`);
    }
  });

  test('a scheduled send waits for its own moment, not the reveal', () => {
    const e = ev({ guestDelivery: 'scheduled', guestSendAt: later + DAY, revealDelayHours: 48 });
    assert.equal(liveSendDue(e, later), 'wait');
    assert.equal(liveSendDue(e, later + DAY), 'send');
  });

  test('a scheduled send with no moment set never fires', () => {
    assert.equal(liveSendDue(ev({ guestDelivery: 'scheduled', guestSendAt: null }), later), 'never');
  });
});

// ── Nothing changes for an event that already existed ───────────────────────

describe('an event created before any of this', () => {
  // 0046 adds defaults, not behaviour. The consent gate is participants.wants_photos, false on
  // every row that predates the column, and there is no backfill — so the defaults cannot reach
  // anybody. These pin that the defaults are what they are, and that the gate is what stops them.

  test('unrecognised or missing settings read as the defaults, never as a fault', () => {
    for (const v of [undefined, null, '', 'something_we_retired', 42]) {
      assert.equal(parseGuestDelivery(v), 'all_on_reveal');
      assert.equal(parseGuestSendScope(v), 'all');
    }
  });

  test('with no guest opted in, the end of the event produces no email at all', () => {
    const olds = [
      { id: 'p1', name: 'Guest 1', email: 'one@example.com', wantsPhotos: false },
      { id: 'p2', name: 'Guest 2', email: 'two@example.com', wantsPhotos: false },
    ];
    const recipients = dedupeRecipients(olds);
    assert.deepEqual(recipients, []);
    assert.deepEqual(eventEndMessages(recipients, {
      eventName: 'A party in 2025', hostName: 'Sam', galleryUrl: 'https://snapdini.com/gallery/OLD',
      timezone: null, thanks: true, releaseAt: END + 2 * DAY, ownPhotoCount: () => 9,
    }), []);
  });

  test('and no combination of the things the builder actually takes changes that', () => {
    // This used to loop four delivery modes past eventEndMessages, which does not take one — `mode`
    // appeared only in the failure message, so a single assertion ran eight times under four names.
    // These are its real inputs, and the opt-in gate has to survive all of them.
    const none: GuestRecipient[] = dedupeRecipients([{ id: 'p1', name: 'Guest', email: 'one@example.com', wantsPhotos: false }]);
    const base = { eventName: 'A party in 2025', galleryUrl: 'https://snapdini.com/gallery/OLD', timezone: null };
    for (const thanks of [true, false]) {
      for (const releaseAt of [null, Date.now() + 3 * DAY, Date.now() - DAY]) {
        for (const hostName of ['', 'Sam']) {
          for (const own of [0, 9]) {
            assert.deepEqual(
              eventEndMessages(none, { ...base, hostName, thanks, releaseAt, ownPhotoCount: () => own }), [],
              `thanks=${thanks} release=${releaseAt} host=${hostName || '(none)'} photos=${own} built a message for a guest who never asked`);
          }
        }
      }
    }
  });

  test('the delivery mode decides WHEN a send is due, which is the other half of the table', () => {
    // Where the mode actually lives. Four modes, four different answers — so each one carries its
    // own assertion instead of sharing one that ignores it. A default event ends at END, so
    // all_on_reveal's link was already in the event-end message: 'covered', not a second email.
    const due = (mode: GuestDelivery) => liveSendDue(ev({ guestDelivery: mode, guestSendAt: END + DAY }), END + 2 * DAY);
    assert.equal(due('all_on_reveal'), 'covered', 'a second email saying what the event-end one already said');
    assert.equal(due('scheduled'), 'send');
    assert.equal(due('manual'), 'never', 'a manual mode sent without the host pressing anything');
    assert.equal(due('favourites_manual'), 'never', 'a manual mode sent without the host pressing anything');
    assert.deepEqual([...GUEST_DELIVERY_MODES].sort(),
      ['all_on_reveal', 'favourites_manual', 'manual', 'scheduled'],
      'a delivery mode was added or removed and the table above does not cover it');
  });

  test('an old at_end event still reveals exactly when it did', () => {
    // revealOpensAt is the same instant scheduledRevealAt has always computed — guest delivery
    // reads the reveal, it does not redefine it.
    assert.equal(revealOpensAt(ev({ revealDelayHours: 12 })), END + 12 * HOUR);
    assert.equal(revealOpensAt(ev({ revealMode: 'instant' })), START);
    assert.equal(revealOpensAt(ev({ revealMode: 'manual', revealedAt: END + HOUR })), END + HOUR);
  });
});

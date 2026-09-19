// The guest unsubscribe. Every test here stands for a way of ending up with a live address on a
// list it asked to be off, or with a recipient reaching for the spam button instead — and neither
// of those throws, so neither shows up anywhere but here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNSUB_REASONS, isUnsubToken, isUnsubReason, parseScope, parseFeedback, FEEDBACK_MAX,
  oneClickUrl, unsubscribePageUrl, unsubscribeHeaders, mergeBlocks, partitionRecipients,
  targetFromToken, maskAddress, tokenFingerprint, type Block,
} from '../unsubscribe';
import unsubscribeRouter from '../routes/unsubscribe';

const BASE = 'https://snapdini.com';
const TOKEN = '9f0c2b41-6a7e-4f3d-8b21-5c0de7a41b9e';

// ── The token path ───────────────────────────────────────────────────────────
// The unsubscribe link carries the invite token and NOTHING else — never the address. That is the
// only reason the page can work with no login and no "confirm your email", and it is why an
// unsubscribe URL in a log, a referrer or a browser history leaks nobody's address.

describe('the token in the link', () => {
  test('a real invite token is accepted', () => {
    assert.equal(isUnsubToken(TOKEN), true);
    assert.equal(isUnsubToken(TOKEN.toUpperCase()), true, 'a client upper-cased the path and the link died');
  });

  test('anything that is not a uuid v4 is refused before it reaches the database', () => {
    for (const junk of ['', 'null', '../../etc/passwd', "' OR 1=1--", 'x'.repeat(64), TOKEN.slice(0, -1)]) {
      assert.equal(isUnsubToken(junk), false, `accepted ${JSON.stringify(junk)}`);
    }
    assert.equal(isUnsubToken(undefined), false);
    assert.equal(isUnsubToken(12345), false);
  });

  test('resolving a malformed token answers null without querying anything', async () => {
    // No database is running in this suite. If this ever starts hanging or throwing, the guard at
    // the top of targetFromToken has been removed and junk path segments are reaching Postgres.
    assert.equal(await targetFromToken('not-a-token'), null);
  });

  test('no link ever carries an address', () => {
    for (const url of [oneClickUrl(BASE, TOKEN), unsubscribePageUrl(BASE, TOKEN)]) {
      assert.ok(url.includes(TOKEN));
      assert.ok(!url.includes('@'), `${url} has an address in it`);
    }
  });

  test('a trailing slash on the base does not double up', () => {
    assert.equal(unsubscribePageUrl('https://snapdini.com/', TOKEN), `${BASE}/unsubscribe/${TOKEN}`);
    assert.equal(oneClickUrl('https://snapdini.com/', TOKEN), `${BASE}/api/guest-unsubscribe/${TOKEN}/one-click`);
  });

  test('the page names the address without handing it back', () => {
    const masked = maskAddress('gillian.kieran@example.com');
    assert.ok(masked.startsWith('g'));
    assert.ok(masked.endsWith('@example.com'));
    assert.ok(!masked.includes('illian'), 'leaked the local part');
    // Fixed-width: the length of someone's name is part of what we are not handing back.
    assert.equal(maskAddress('jo@example.com').length, maskAddress('jonathan-fitzwilliam@example.com').length);
  });

  // A log line is where a credential gets copied, shipped and kept, and this token is the bearer
  // credential for an unsubscribe — anyone holding it can stop someone else's mail. The failure
  // path in markInviteUnsubscribed() used to print it in full.
  test('a token in a log line is a fingerprint, not the token', () => {
    const fp = tokenFingerprint(TOKEN);
    assert.match(fp, /^[0-9a-f]{8}$/);
    assert.ok(!TOKEN.includes(fp), 'the fingerprint is a slice of the token itself');
    assert.equal(tokenFingerprint(TOKEN), fp, 'not stable — two lines about one invite would not match');
    assert.notEqual(tokenFingerprint('9f0c2b41-6a7e-4f3d-8b21-5c0de7a41b9f'), fp);
    // Short enough that it is not a token in disguise: 8 hex characters identify a row for a human
    // reading a log and are useless for replaying anything.
    assert.equal(fp.length, 8);
  });
});

// ── One-click (RFC 8058) ─────────────────────────────────────────────────────
// The mail client POSTs the header URL by itself. Everything below is a way that stops working
// silently — and a one-click unsubscribe that does not work is scored against the sending domain
// by Gmail and Yahoo, whose bulk-sender rules are the entire reason it is here.

describe('the one-click headers', () => {
  const h = unsubscribeHeaders(BASE, TOKEN);

  test('the URI is in angle brackets — a bare URL is ignored by the clients that matter', () => {
    assert.equal(h['List-Unsubscribe'], `<${oneClickUrl(BASE, TOKEN)}>`);
  });

  test('the POST header is the exact literal the standard defines, not a description of it', () => {
    // Anything else and the client falls back to treating the URI as a link to OPEN, which puts a
    // page in front of a person who already pressed unsubscribe.
    assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  });

  test('the header points at the one-click endpoint, never at the page', () => {
    // The page applies an EVENT-scoped opt-out and asks a question. A mail client sent there would
    // render it as a link, and the one-click press would do nothing at all.
    assert.ok(h['List-Unsubscribe'].includes('/api/guest-unsubscribe/'));
    assert.ok(!h['List-Unsubscribe'].includes('/unsubscribe/'));
  });

  test('only an https URI is offered — no mailto nobody reads', () => {
    assert.ok(!h['List-Unsubscribe'].includes('mailto:'));
    assert.ok(h['List-Unsubscribe'].startsWith('<https://'));
  });
});

describe('the one-click endpoint', () => {
  interface Layer { route?: { path: string; methods: Record<string, boolean> } }
  const routes = (unsubscribeRouter as unknown as { stack: Layer[] }).stack
    .map((l) => l.route)
    .filter((r): r is NonNullable<Layer['route']> => !!r);
  const oneClick = routes.filter((r) => r.path === '/:token/one-click');

  test('it accepts POST', () => {
    assert.equal(oneClick.length, 1);
    assert.equal(oneClick[0].methods.post, true);
  });

  test('it has NO GET handler', () => {
    // Two reasons, and both are load-bearing. RFC 8058 is a POST-only mechanism, so a GET here is
    // not part of the standard; and mail scanners (SafeLinks, Proofpoint) fetch every link in a
    // message before a human sees it — a GET that unsubscribed would opt out guests who never
    // opened the invite, and the host's resend would then skip them with no explanation.
    assert.equal(oneClick[0].methods.get, undefined);
    assert.equal(oneClick[0].methods.head, undefined);
  });

  test('the page route is separate, and the page GET is the read-only one', () => {
    const page = routes.filter((r) => r.path === '/:token');
    assert.deepEqual(page.map((r) => Object.keys(r.methods)).flat().sort(), ['get', 'post']);
  });

  test('feedback is its own endpoint, so it can never gate the unsubscribe', () => {
    // A field on the unsubscribe POST would make the opt-out and the question one transaction, and
    // a failure to answer would become a failure to unsubscribe.
    const fb = routes.filter((r) => r.path === '/:token/feedback');
    assert.equal(fb.length, 1);
    assert.equal(fb[0].methods.post, true);
  });
});

// ── Scope ────────────────────────────────────────────────────────────────────

describe('reading the choice off the page', () => {
  test('the two choices a guest actually has', () => {
    assert.equal(parseScope('event'), 'event');
    assert.equal(parseScope('all'), 'all');
  });

  test('anything else is a malformed request, not a default', () => {
    // Defaulting junk to 'event' would silently narrow someone who asked for 'all'.
    for (const junk of ['', 'ALL', 'global', true, null, undefined, {}]) {
      assert.equal(parseScope(junk), null, `accepted ${JSON.stringify(junk)}`);
    }
  });
});

// ── The optional "why" ───────────────────────────────────────────────────────

describe('feedback, asked after the fact', () => {
  test('a reason alone is an answer', () => {
    assert.deepEqual(parseFeedback({ reason: 'too-many' }), { reason: 'too-many', comment: null });
  });

  test('a comment alone is an answer too', () => {
    // Refusing this because no radio button was ticked would discard the only part with content.
    assert.deepEqual(parseFeedback({ comment: '  I never gave anyone my address  ' }),
      { reason: null, comment: 'I never gave anyone my address' });
  });

  test('nothing at all is nothing to record, not an error', () => {
    assert.equal(parseFeedback({}), null);
    assert.equal(parseFeedback({ reason: '', comment: '   ' }), null);
    assert.equal(parseFeedback(null), null);
  });

  test('an unknown reason is dropped rather than failing the whole submission', () => {
    assert.deepEqual(parseFeedback({ reason: 'ponies', comment: 'hello' }), { reason: null, comment: 'hello' });
  });

  test('the comment is capped, so an unauthenticated box is not free storage', () => {
    const r = parseFeedback({ comment: 'x'.repeat(FEEDBACK_MAX + 500) });
    assert.equal(r?.comment?.length, FEEDBACK_MAX);
  });

  test('"I never gave anyone my address" is one of the offered reasons', () => {
    // The answer that predicts complaints: a host importing a spreadsheet that was never theirs to
    // give us. Losing it from the list would lose the one signal worth acting on.
    assert.ok(UNSUB_REASONS.some((r) => r.key === 'never-signed-up'));
    assert.equal(isUnsubReason('never-signed-up'), true);
    for (const r of UNSUB_REASONS) assert.ok(r.label.length > 3, `${r.key} has no label`);
  });
});

// ── What the send path must not mail ─────────────────────────────────────────

const sup = (email: string, reason: string, detail: string | null = null, createdAt = 1000) =>
  ({ email, reason, detail, createdAt });

describe('merging the two reasons an address is off limits', () => {
  test('a per-event opt-out blocks, and says which kind it is', () => {
    const m = mergeBlocks([], [{ email: 'mum@example.com', createdAt: 500 }]);
    const b = m.get('mum@example.com');
    assert.equal(b?.reason, 'unsubscribed');
    assert.equal(b?.scope, 'event');
  });

  test('a global suppression wins over an event opt-out, even when the event one is newer', () => {
    // Not competing opinions: both are satisfied by not sending, and the global row carries the
    // real reason. Showing the host "unsubscribed from this event" for an address that actually
    // hard-bounced sends them off fixing the wrong problem.
    const m = mergeBlocks(
      [sup('dad@example.com', 'bounced', '550 no such user', 100)],
      [{ email: 'dad@example.com', createdAt: 9999 }],
    );
    assert.equal(m.get('dad@example.com')?.reason, 'bounced');
    assert.equal(m.get('dad@example.com')?.detail, '550 no such user');
    assert.equal(m.get('dad@example.com')?.scope, 'global');
  });

  test('addresses are keyed lower-cased on both sides', () => {
    // The one that gets this wrong re-mails a suppressed Mum@x.com as mum@x.com, which is precisely
    // the failure suppression exists to prevent.
    const m = mergeBlocks([sup('Mum@Example.COM', 'complained')], [{ email: ' Dad@Example.com ', createdAt: 1 }]);
    assert.ok(m.has('mum@example.com'));
    assert.ok(m.has('dad@example.com'));
  });
});

describe('suppression is honoured at send time', () => {
  const guests = [
    { id: 'a', name: 'Ada',  email: 'ada@example.com' },
    { id: 'b', name: 'Bo',   email: 'bounced@example.com' },
    { id: 'c', name: 'Cleo', email: 'unsubbed@example.com' },
    { id: 'd', name: 'Dev',  email: null },
    { id: 'e', name: 'Eve',  email: 'ADA2@Example.com' },
  ];
  const blocked = mergeBlocks(
    [sup('bounced@example.com', 'bounced', 'mailbox unavailable')],
    [{ email: 'unsubbed@example.com', createdAt: 42 }],
  );

  test('a bounced address is never mailed again', () => {
    const { mailable } = partitionRecipients(guests, blocked);
    assert.ok(!mailable.some((g) => g.email === 'bounced@example.com'));
  });

  test('a guest who opted out of THIS event is not mailed about it', () => {
    const { mailable } = partitionRecipients(guests, blocked);
    assert.ok(!mailable.some((g) => g.email === 'unsubbed@example.com'));
  });

  test('everyone else still gets their invite', () => {
    const { mailable } = partitionRecipients(guests, blocked);
    assert.deepEqual(mailable.map((g) => g.id), ['a', 'e']);
  });

  test('a suppressed address in different casing is still suppressed', () => {
    const { mailable, skipped } = partitionRecipients(guests, mergeBlocks([sup('ada2@example.com', 'complained')], []));
    assert.ok(!mailable.some((g) => g.id === 'e'), 'ADA2@Example.com escaped its own suppression');
    assert.equal(skipped[0].guest.id, 'e');
  });

  test('every skip is reported, by address and by reason', () => {
    // "We sent 19 of your 20" with no explanation is how a guest ends up never invited and nobody
    // finds out until the day.
    const { skipped } = partitionRecipients(guests, blocked);
    assert.deepEqual(skipped.map((s) => [s.guest.id, s.block.reason]), [['b', 'bounced'], ['c', 'unsubscribed']]);
  });

  test('a guest with no address is neither mailed nor reported as blocked', () => {
    // They are on the list for their phone number. Counting them as a suppression would tell the
    // host they had done something wrong.
    const { mailable, skipped } = partitionRecipients(guests, blocked);
    assert.ok(!mailable.some((g) => g.id === 'd'));
    assert.ok(!skipped.some((s) => s.guest.id === 'd'));
  });

  test('an empty block map mails everyone with an address', () => {
    const { mailable, skipped } = partitionRecipients(guests, new Map<string, Block>());
    assert.equal(mailable.length, 4);
    assert.equal(skipped.length, 0);
  });
});

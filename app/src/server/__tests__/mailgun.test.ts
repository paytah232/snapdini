// Mailgun webhook verification and event translation.
//
// The signature tests are the most important tests in this feature. An endpoint that accepts an
// unverified webhook lets anyone on the internet write delivery state for any address — and the
// damaging direction is not "mark it delivered", it is "mark it bounced", because a forged bounce
// puts a real guest's address on the suppression list and every future invite to them is silently
// dropped. So the REJECTION cases below matter more than the acceptance one, and every way a
// signature can be wrong gets its own case.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { verifySignature, normaliseEvent, stripBrackets, tokenSeen, rememberToken, _resetTokenCache,
         INVITE_VAR } from '../mailgun';

const KEY = 'test-webhook-signing-key-0123456789';
const NOW = 1_770_000_000_000;               // a fixed "now" so age checks are deterministic
const TS = String(Math.floor(NOW / 1000));
const TOKEN = 'a'.repeat(50);

/** Sign exactly the way Mailgun documents it: HMAC-SHA256 hex over timestamp + token. */
const sign = (ts: string, token: string, key = KEY) =>
  crypto.createHmac('sha256', key).update(ts + token).digest('hex');

const good = (over: Record<string, unknown> = {}) => ({
  timestamp: TS, token: TOKEN, signature: sign(TS, TOKEN), ...over,
});

describe('verifySignature — a genuine webhook', () => {
  test('accepts a correctly signed request', () => {
    assert.equal(verifySignature(good(), KEY, NOW).ok, true);
  });

  test('accepts an upper-case hex digest', () => {
    const sig = good({ signature: sign(TS, TOKEN).toUpperCase() });
    assert.equal(verifySignature(sig, KEY, NOW).ok, true);
  });

  test('accepts a numeric timestamp as well as a string one', () => {
    // It arrives as a string on the wire, but a proxy or a re-serialisation can turn it into a
    // number. The HMAC is over the decimal text either way.
    assert.equal(verifySignature(good({ timestamp: Number(TS) }), KEY, NOW).ok, true);
  });

  test('accepts a retry sent hours later — the window must not be tight', () => {
    // Mailgun's retry ladder spans about eight hours and the docs warn against being aggressive.
    // A five-minute window (the reflex from other providers) would reject precisely the retries
    // that exist to recover events we missed.
    for (const hoursAgo of [1, 4, 8, 20]) {
      const ts = String(Math.floor(NOW / 1000) - hoursAgo * 3600);
      const sig = { timestamp: ts, token: TOKEN, signature: sign(ts, TOKEN) };
      assert.equal(verifySignature(sig, KEY, NOW).ok, true, `${hoursAgo}h old should be accepted`);
    }
  });
});

describe('verifySignature — everything that must be REJECTED', () => {
  const reject = (sig: Record<string, unknown>, why: RegExp, key = KEY, now = NOW) => {
    const r = verifySignature(sig, key, now);
    assert.equal(r.ok, false, `should have been rejected: ${JSON.stringify(sig).slice(0, 120)}`);
    assert.match(r.reason || '', why);
  };

  test('a wrong signature', () => {
    reject(good({ signature: 'f'.repeat(64) }), /bad signature/);
  });

  test('a signature made with a DIFFERENT key — the forgery case', () => {
    // Someone who knows the algorithm but not the secret. This is the attack.
    const forged = { timestamp: TS, token: TOKEN, signature: sign(TS, TOKEN, 'not-the-real-key') };
    reject(forged, /bad signature/);
  });

  test('a valid signature for DIFFERENT content — token swapped after signing', () => {
    // A captured genuine request whose token has been edited. The HMAC covers the token, so this
    // must fail; if it passed, an attacker could replay one signature against any event.
    reject(good({ token: 'b'.repeat(50) }), /bad signature/);
  });

  test('a valid signature with the timestamp swapped after signing', () => {
    const other = String(Number(TS) - 60);
    reject({ timestamp: other, token: TOKEN, signature: sign(TS, TOKEN) }, /bad signature/);
  });

  test('the timestamp and token concatenated in the WRONG ORDER', () => {
    // The single most likely implementation slip. It fails uniformly, so it looks exactly like a
    // misconfigured key — and someone "fixing" that by loosening verification is the real danger.
    const backwards = crypto.createHmac('sha256', KEY).update(TOKEN + TS).digest('hex');
    reject(good({ signature: backwards }), /bad signature/);
  });

  test('a signature over the two values with a separator between them', () => {
    const separated = crypto.createHmac('sha256', KEY).update(`${TS}.${TOKEN}`).digest('hex');
    reject(good({ signature: separated }), /bad signature/);
  });

  test('a base64 digest instead of hex', () => {
    const b64 = crypto.createHmac('sha256', KEY).update(TS + TOKEN).digest('base64');
    reject(good({ signature: b64 }), /bad signature/);
  });

  test('an sha1 digest instead of sha256', () => {
    const sha1 = crypto.createHmac('sha1', KEY).update(TS + TOKEN).digest('hex');
    reject(good({ signature: sha1 }), /bad signature/);
  });

  test('a truncated or over-long signature does not throw', () => {
    // timingSafeEqual throws on a length mismatch. An unguarded call turns a malformed request
    // into a 500 and an unhandled rejection, which is a trivial denial of service.
    reject(good({ signature: 'abc' }), /bad signature/);
    reject(good({ signature: 'a'.repeat(200) }), /bad signature/);
  });

  test('missing pieces', () => {
    reject({ token: TOKEN, signature: sign(TS, TOKEN) }, /timestamp/);
    reject({ timestamp: TS, signature: sign(TS, TOKEN) }, /token/);
    reject({ timestamp: TS, token: TOKEN }, /signature/);
    reject({}, /timestamp/);
  });

  test('junk types instead of strings', () => {
    for (const junk of [null, undefined, 0, {}, [], true]) {
      const r = verifySignature({ timestamp: TS, token: TOKEN, signature: junk }, KEY, NOW);
      assert.equal(r.ok, false, `signature=${JSON.stringify(junk)} must be rejected`);
    }
    for (const junk of [null, {}, [], true]) {
      assert.equal(verifySignature({ timestamp: junk, token: TOKEN, signature: sign(TS, TOKEN) }, KEY, NOW).ok,
        false, `timestamp=${JSON.stringify(junk)} must be rejected`);
    }
  });

  test('a non-numeric timestamp', () => {
    const ts = '20260213T00:00';
    reject({ timestamp: ts, token: TOKEN, signature: sign(ts, TOKEN) }, /malformed timestamp/);
  });

  test('an ancient replay, even though it is correctly signed', () => {
    const ts = String(Math.floor(NOW / 1000) - 72 * 3600);
    reject({ timestamp: ts, token: TOKEN, signature: sign(ts, TOKEN) }, /too old/);
  });

  test('a timestamp far in the future', () => {
    const ts = String(Math.floor(NOW / 1000) + 3 * 3600);
    reject({ timestamp: ts, token: TOKEN, signature: sign(ts, TOKEN) }, /future/);
  });

  test('NO SIGNING KEY CONFIGURED rejects everything, including a genuine request', () => {
    // The most important case in the file. If a missing key fell through to "accept", a deployment
    // that simply had not set MAILGUN_WEBHOOK_SIGNING_KEY would have a fully open endpoint for
    // writing delivery state — and nothing about it would look broken.
    reject(good(), /no signing key/, '');
    assert.equal(verifySignature(good(), undefined as unknown as string, NOW).ok, false);
  });
});

describe('the replay-token cache', () => {
  test('remembers a token and recognises it again', () => {
    _resetTokenCache();
    assert.equal(tokenSeen('t1'), false);
    rememberToken('t1');
    assert.equal(tokenSeen('t1'), true);
    assert.equal(tokenSeen('t2'), false);
  });

  test('is bounded — a public endpoint must not be able to grow it without limit', () => {
    _resetTokenCache();
    for (let i = 0; i < 6000; i++) rememberToken(`t${i}`);
    assert.equal(tokenSeen('t5999'), true, 'the newest token must be remembered');
    assert.equal(tokenSeen('t0'), false, 'the oldest must have been evicted');
  });
});

describe('normaliseEvent — Mailgun’s vocabulary into ours', () => {
  const ev = (over: Record<string, unknown>) => normaliseEvent({
    event: 'delivered', id: 'evt1', timestamp: 1770146431.6585283,
    recipient: 'jo@x.com', message: { headers: { 'message-id': '2026@mg.x.com' } },
    'user-variables': { [INVITE_VAR]: 'tok-1' }, ...over,
  })!;

  test('the plain delivered event', () => {
    const r = ev({});
    assert.equal(r.status, 'delivered');
    assert.equal(r.recipient, 'jo@x.com');
    assert.equal(r.inviteToken, 'tok-1');
    assert.equal(r.messageId, '2026@mg.x.com');
    assert.equal(r.eventId, 'evt1');
  });

  test('the timestamp is fractional epoch SECONDS, not milliseconds', () => {
    // Read as milliseconds this lands in January 1970, every event sorts before every other one,
    // and the out-of-order protection in delivery.ts quietly stops working.
    assert.equal(ev({}).at, 1770146431659);
    assert.ok(ev({}).at! > 1_700_000_000_000, 'a millisecond-scale value, not a second-scale one');
    // The sub-second part is KEPT rather than rounded away. Two events for the same message can
    // land in the same second, and the ordering rule in delivery.ts compares these timestamps —
    // truncating to whole seconds would make them indistinguishable exactly when it matters.
    assert.notEqual(ev({}).at! % 1000, 0);
  });

  test('failed + permanent is a HARD bounce; failed + temporary is not', () => {
    // The distinction the whole feature turns on. Both arrive as "failed" — only `severity`
    // separates them, and getting it wrong suppresses guests whose mail server was merely busy.
    const hard = ev({ event: 'failed', severity: 'permanent', reason: 'bounce',
                      'delivery-status': { code: 550, message: '5.5.0 mailbox unavailable', 'bounce-type': 'hard' } });
    assert.equal(hard.status, 'bounced');
    assert.equal(hard.severity, 'permanent');
    assert.match(hard.reason!, /mailbox unavailable/);

    const soft = ev({ event: 'failed', severity: 'temporary', reason: 'generic',
                      'delivery-status': { code: 421, message: 'temporarily deferred', 'retry-seconds': 600 } });
    assert.equal(soft.status, 'failed');
    assert.equal(soft.severity, 'temporary');
  });

  test('a failed event with NO severity is treated as temporary, never as a bounce', () => {
    // The safe direction: a temporary state suppresses nobody, and a later permanent event can
    // still arrive and correct it. Guessing "permanent" strikes a live address off with no way back.
    const r = ev({ event: 'failed' });
    assert.equal(r.status, 'failed');
    assert.equal(r.severity, null);
  });

  test('an unrecognised severity value is not trusted into permanence', () => {
    assert.equal(ev({ event: 'failed', severity: 'PERMANENT' }).status, 'failed');
    assert.equal(ev({ event: 'failed', severity: 'hard' }).status, 'failed');
  });

  test('complained and unsubscribed map straight across', () => {
    // `complained` carries no delivery-status and only a partial envelope — reading those blindly
    // would throw on exactly the event a host most needs to see.
    const c = normaliseEvent({ event: 'complained', timestamp: 1770146431.5, recipient: 'jo@x.com',
                               'user-variables': { [INVITE_VAR]: 'tok-1' } })!;
    assert.equal(c.status, 'complained');
    assert.equal(c.reason, null);
    assert.equal(ev({ event: 'unsubscribed' }).status, 'unsubscribed');
  });

  test('rejected is recorded as a failure but is NOT a bounce', () => {
    // It says nothing about whether the mailbox exists — suppressing on it would let a temporary
    // Mailgun account limit quietly eat the guest list.
    const r = ev({ event: 'rejected', reject: { reason: 'Sandbox subdomains are for test purposes' } });
    assert.equal(r.status, 'failed');
    assert.match(r.reason!, /Sandbox/);
  });

  test('events we do not act on yield a null status rather than being dropped', () => {
    // Null, not undefined and not an exception: the route still logs the event name, so an
    // unexpected subscription shows up in the logs instead of vanishing.
    for (const name of ['accepted', 'opened', 'clicked', 'stored', 'something_new']) {
      const r = normaliseEvent({ event: name, timestamp: 1770146431.5 })!;
      assert.equal(r.status, null, name);
      assert.equal(r.name, name);
    }
  });

  test('user-variables serialised as an empty ARRAY does not become a phantom token', () => {
    // Mailgun really does send `"user-variables": []` when a message carried none. `[]` is
    // typeof 'object', so a naive cast yields something that answers undefined to every key.
    const r = ev({ 'user-variables': [] });
    assert.equal(r.inviteToken, null);
    assert.equal(r.messageId, '2026@mg.x.com', 'the fallback join key must still be read');
  });

  test('garbage in does not throw', () => {
    // This runs on a public endpoint. Anything that throws here is a 500 an attacker can trigger.
    assert.equal(normaliseEvent(null), null);
    assert.equal(normaliseEvent('a string'), null);
    assert.equal(normaliseEvent([]), null);
    assert.equal(normaliseEvent({}), null);
    assert.equal(normaliseEvent({ event: 123 }), null);
    const r = normaliseEvent({ event: 'failed', message: 'not an object', 'delivery-status': 7,
                               timestamp: 'nope', recipient: null })!;
    assert.equal(r.status, 'failed');
    assert.equal(r.at, null);
    assert.equal(r.messageId, null);
    assert.equal(r.recipient, null);
  });

  test('an over-long reason is cut, so one event cannot write an unbounded string', () => {
    const r = ev({ event: 'failed', 'delivery-status': { message: 'x'.repeat(5000) } });
    assert.ok(r.reason!.length <= 500);
  });
});

describe('message ids', () => {
  test('the send API brackets them and the webhook does not — both sides normalise', () => {
    // Compared as-is, the two never match and every webhook falls back to the token. Which works,
    // until a token is missing and the fallback is the only join key there is.
    assert.equal(stripBrackets('<2026@mg.x.com>'), '2026@mg.x.com');
    assert.equal(stripBrackets('2026@mg.x.com'), '2026@mg.x.com');
    assert.equal(stripBrackets(null), null);
    assert.equal(stripBrackets(''), null);
  });
});

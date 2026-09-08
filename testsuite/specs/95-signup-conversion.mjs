// Snapdini integration spec — 'Sign-up conversion fires on verification, once'.
//
// The sign-up conversion used to fire when the registration form succeeded, which counted spoofed
// addresses that never opened their inbox. It now fires the FIRST time an account's email becomes
// verified, signalled by a ?verified=<digest> marker on the redirect to /dashboard.
//
// Three separate paths verify an address (the verification link, a magic-link sign-in, and Google
// sign-in), so the rule is keyed on the TRANSITION to verified rather than on the endpoint. The
// expensive mistake this guards is the opposite one: marking on every sign-in, which would re-count
// a returning user as a new sign-up on every visit.
//
// SERIAL (9x- prefix): creates and deletes its own accounts.
import { BASE, api, dbq, group, ok, session, spec } from '../lib/harness.mjs';
import crypto from 'crypto';

// Follow nothing — the redirect target IS the assertion. devLink comes back absolute against the
// public hostname, so it is re-pointed at the local stack rather than traversing the proxy.
const local = (link) => BASE + new URL(link).pathname + new URL(link).search;
const location = async (link) => {
  const res = await fetch(local(link), { redirect: 'manual' });
  return { status: res.status, loc: res.headers.get('location') || '' };
};
const MARKER = /^\/dashboard\?verified=([0-9a-f]{16})$/;
const digestOf = (userId) => crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);

await spec('95-signup-conversion', async () => {
  const ownerCookie = session.cookie;
  const stamp = `${Date.now()}_${process.pid}`;
  const emails = [];

  group('Sign-up conversion fires on verification, once');
  {
    // ---- 1. the verification link marks the transition ----
    const email1 = `conv_verify_${stamp}@example.com`;
    emails.push(email1);
    const reg = await api('POST', '/api/auth/register',
      { body: { name: 'Conv Test', displayName: 'Conv Test', email: email1, password: 'Str0ngPass!23' } });
    ok('registration succeeds', reg.status === 201, `status ${reg.status} ${reg.text?.slice(0, 120)}`);
    ok('a verification link is available in dev', !!reg.json?.devLink, JSON.stringify(reg.json));

    // Registering must NOT itself be the conversion moment: until the link is opened the account
    // is unverified, which is exactly the state a spoofed sign-up sits in.
    const unverified = dbq(`SELECT email_verified_at IS NULL FROM users WHERE email='${email1}'`);
    ok('the account is unverified until the link is opened', unverified === 't', unverified);

    const v1 = await location(reg.json.devLink);
    ok('verifying redirects to the dashboard', v1.status === 302, `status ${v1.status}`);
    const m1 = MARKER.exec(v1.loc);
    ok('the redirect carries the conversion marker', !!m1, `location "${v1.loc}"`);

    // ---- 2. the marker is a one-way digest, not the user id ----
    const uid = dbq(`SELECT id FROM users WHERE email='${email1}'`);
    ok('the marker is a stable digest of the user id', m1 && m1[1] === digestOf(uid), `${m1?.[1]} vs ${digestOf(uid)}`);
    ok('the marker is NOT the user id itself', !v1.loc.includes(uid), `location "${v1.loc}"`);
    ok('the account is now verified', dbq(`SELECT email_verified_at IS NOT NULL FROM users WHERE email='${email1}'`) === 't');

    // ---- 3. the same link cannot fire it twice ----
    const v2 = await location(reg.json.devLink);
    ok('the link is single-use, so it cannot re-fire', v2.status === 400, `status ${v2.status}`);

    // ---- 4. THE REGRESSION: a returning sign-in must not re-count ----
    const ml = await api('POST', '/api/auth/magic-link', { body: { email: email1 } });
    ok('a sign-in link can be requested for the verified account', ml.status === 200, `status ${ml.status}`);
    const back = await location(ml.json.devLink);
    ok('signing back in still reaches the dashboard', back.status === 302, `status ${back.status}`);
    ok('a returning sign-in carries NO marker', back.loc === '/dashboard', `location "${back.loc}"`);
    ok('and does not merely hide it behind another param', !/verified=/.test(back.loc), `location "${back.loc}"`);

    // ---- 5. a first-time magic-link user IS a completed sign-up ----
    // The link goes to their own inbox, so opening it proves the address just as a verification
    // link does. This path doubles as passwordless sign-up and must count.
    const email2 = `conv_magic_${stamp}@example.com`;
    emails.push(email2);
    const ml2 = await api('POST', '/api/auth/magic-link', { body: { email: email2 } });
    ok('magic-link creates the account for a new address', ml2.status === 200, `status ${ml2.status}`);
    const first = await location(ml2.json.devLink);
    const m2 = MARKER.exec(first.loc);
    ok('a first-time magic-link sign-up DOES carry the marker', !!m2, `location "${first.loc}"`);
    const uid2 = dbq(`SELECT id FROM users WHERE email='${email2}'`);
    ok('with that account’s own digest', m2 && m2[1] === digestOf(uid2), `${m2?.[1]} vs ${digestOf(uid2)}`);
    ok('two accounts get different markers', m1 && m2 && m1[1] !== m2[1], `${m1?.[1]} vs ${m2?.[1]}`);

    // ---- 6. and that one also stops counting from then on ----
    dbq(`UPDATE email_tokens SET created_at = created_at - 600000 WHERE user_id='${uid2}'`);
    const ml3 = await api('POST', '/api/auth/magic-link', { body: { email: email2 } });
    ok('a second sign-in link is issued once the cooldown passes', ml3.status === 200, `status ${ml3.status}`);
    const second = await location(ml3.json.devLink);
    ok('the second sign-in carries no marker either', second.loc === '/dashboard', `location "${second.loc}"`);
  }

  group('Sign-up poll: verifying on another device');
  {
    // The browser that filled in the form is usually NOT the one that opens the email. It holds the
    // half-finished event in its own localStorage, so it needs to find out that the address was
    // proven elsewhere. That is what /api/auth/pending is for.
    const email3 = `conv_poll_${stamp}@example.com`;
    emails.push(email3);
    const reg = await api('POST', '/api/auth/register',
      { body: { name: 'Poll Test', displayName: 'Poll Test', email: email3, password: 'Str0ngPass!23' } });
    ok('registration returns a poll token', typeof reg.json?.pendingToken === 'string' && reg.json.pendingToken.length >= 32);
    ok('and how long it is good for', Number(reg.json?.pendingTtlMs) > 0, String(reg.json?.pendingTtlMs));
    const tok = reg.json.pendingToken;

    // It must never become an "is this address verified?" oracle: it takes an opaque token issued
    // to whoever registered, never an address.
    const noTok = await api('GET', '/api/auth/pending');
    ok('no token ⇒ nothing to report', noTok.json?.verified === false && noTok.json?.expired === true, JSON.stringify(noTok.json));
    const bogus = await api('GET', `/api/auth/pending?token=${'0'.repeat(64)}`);
    ok('an invented token reveals nothing', bogus.json?.verified === false && bogus.json?.expired === true, JSON.stringify(bogus.json));
    ok('and cannot be distinguished from an expired one', JSON.stringify(bogus.json) === JSON.stringify(noTok.json));

    // Before verification: an honest "not yet", and NO session handed out.
    const before = await api('GET', `/api/auth/pending?token=${tok}`);
    ok('before verifying it says not yet', before.json?.verified === false, JSON.stringify(before.json));
    ok('and does not claim to have expired', !before.json?.expired, JSON.stringify(before.json));
    ok('and hands out no marker to fire a conversion with', !before.json?.marker);
    // Polling repeatedly must not spend the token — the whole point is to keep asking.
    const again = await api('GET', `/api/auth/pending?token=${tok}`);
    ok('polling does not spend the token', again.json?.verified === false && !again.json?.expired, JSON.stringify(again.json));

    // Verify on the "other device" — a plain GET of the emailed link.
    const v = await location(reg.json.devLink);
    const marker = (MARKER.exec(v.loc) || [])[1];
    ok('the other device verifies fine', !!marker, `location "${v.loc}"`);

    // Now the waiting browser gets its answer, its session, and the SAME marker — identical ids are
    // what stop two devices counting two sign-ups.
    const after = await api('GET', `/api/auth/pending?token=${tok}`);
    ok('the waiting browser is told it is verified', after.json?.verified === true, JSON.stringify(after.json));
    ok('it gets the same marker the other device used', after.json?.marker === marker, `${after.json?.marker} vs ${marker}`);
    const me = await api('GET', '/api/auth/me');
    ok('and it is now signed in on this device', me.json?.user?.email === email3, JSON.stringify(me.json?.user || {}));

    // One hand-off per registration: a leaked token cannot be replayed into a fresh session later.
    const replay = await api('GET', `/api/auth/pending?token=${tok}`);
    ok('the token is spent after the hand-off', replay.json?.expired === true, JSON.stringify(replay.json));
    ok('a spent token yields no marker', !replay.json?.marker);
  }

  for (const e of emails) dbq(`DELETE FROM users WHERE email='${e}'`);
  session.cookie = ownerCookie;
}, {});

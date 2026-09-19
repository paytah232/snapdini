// What may be written down about a URL, and what may not.
//
// The defect this file exists to prevent: cleanPath() redacted a segment of EXACTLY 32 hex
// characters, the email preference-centre token is 64, and so a 400-day multi-use bearer token was
// being written verbatim into site_events.path AND handed to Google as page_location. Nothing
// failed; the token was simply in the column.
//
// Both halves are tested here, because a redaction rule is only half a rule:
//
//   CREDENTIALS must be redacted  — every token shape this product actually mints
//   REAL NAMES must NOT be        — walked off the live route tree and the real slug list, so
//                                    widening the bound cannot quietly start eating route patterns
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TOKEN_ROUTES, isTokenRoute, redactPath } from '../../../../shared/token-paths';
import { cleanPath } from '../analytics';

// Real token values, of the exact shapes the product mints (see auth.createEmailToken,
// routes/events.ts co-host invites, lifecycle.ts survey tokens).
const HEX32 = 'deadbeefdeadbeefdeadbeefdeadbeef';                                       // organizer code
const HEX48 = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';                       // co-host invite
const HEX64 = '3f7a1c9e5b2d8046af13e79c4d6b28f05e9a7c31bd48620fae5d93c17b8042e6';       // email prefs
const UUID = '7ecd750d-4b62-4391-bfe1-55a205962c39';                                     // invite token
const SURVEY = 'k3Nq-Zt7Rw1bQfX9aLp2Mv';                                                 // base64url

describe('every credential this product mints is redacted', () => {
  test('the 64-hex email preference-centre token — the one that was leaking', () => {
    assert.equal(cleanPath(`/email-preferences/${HEX64}`), '/email-preferences/:token');
    assert.ok(!cleanPath(`/email-preferences/${HEX64}`)!.includes(HEX64));
  });
  test('the 64-hex token is redacted on ANY route, not just the one it belongs to', () => {
    // A token pasted, mistyped or copied onto another path must not be recorded either.
    assert.equal(cleanPath(`/gallery/${HEX64}`), '/gallery/:token');
    assert.equal(cleanPath(`/x/${HEX64}/y`), '/x/:token/y');
  });
  test('the 48-hex co-host invite token', () => {
    assert.equal(cleanPath(`/cohost/${HEX48}`), '/cohost/:token');
  });
  test('the 32-hex organizer code still is (the old rule must not regress)', () => {
    assert.equal(cleanPath(`/admin/${HEX32}`), '/admin/:token');
  });
  test('a uuid invite token keeps reporting as :id, so the metric does not split', () => {
    assert.equal(cleanPath(`/unsubscribe/${UUID}`), '/unsubscribe/:id');
  });
  test('the base64url survey token, which NO hex rule can catch, is caught by route', () => {
    assert.equal(cleanPath(`/survey/${SURVEY}`), '/survey/:token');
  });
  test('query and fragment are still dropped — tokens travel there too', () => {
    assert.equal(cleanPath(`/x?token=${HEX64}`), '/x');
    assert.equal(cleanPath(`/x#${HEX32}`), '/x');
  });
});

describe('the 24-character bound does not eat anything real', () => {
  // The bound has to sit below the shortest credential (32) and above the longest legitimate run
  // of [0-9a-f] in a real path segment. These two tests measure both ends against reality rather
  // than against a guess.

  // Every static route name the site actually serves, taken off the route tree itself so a route
  // added later is covered without anyone updating a list here.
  const routesDir = path.join(__dirname, '..', '..', '..', '..', 'web', 'src', 'routes');
  function routeNames(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (!e.name.startsWith('[')) out.push(e.name);           // [param] segments are the tokens
      routeNames(path.join(dir, e.name), out);
    }
    return out;
  }

  test('the route tree is real (this test is worthless if it is not)', () => {
    assert.ok(fs.existsSync(routesDir), routesDir);
    const names = routeNames(routesDir);
    assert.ok(names.length > 20, `only found ${names.length} route names`);
    assert.ok(names.includes('email-preferences'));
    assert.ok(names.includes('wedding-disposable-camera'));    // the longest use-case slug
  });

  test('no static route name is redacted — not one', () => {
    for (const name of routeNames(routesDir)) {
      assert.equal(redactPath(`/${name}`), `/${name}`, name);
      // …nor when it sits below another segment, where the lookahead applies differently.
      assert.equal(redactPath(`/x/${name}`), `/x/${name}`, name);
    }
  });

  test('join codes are left for the :code rule, never mistaken for a token', () => {
    // Worst case for a hex rule: a code drawn entirely from the alphabet's hex characters. The
    // generator's alphabet is ABCDEFGHJKLMNPQRSTUVWXYZ23456789, so this is reachable.
    for (const code of ['ABCDEF23', 'DEADBEEF', 'FACEB234', 'EPZ8MYF2']) {
      assert.equal(redactPath(`/join/${code}`), `/join/${code}`, code);
      assert.equal(cleanPath(`/join/${code}`), '/join/:code', code);
    }
  });

  test('real event slugs survive, including the hex-flavoured ones', () => {
    // slugify() emits [a-z0-9-] up to 50 chars, so a slug is the only user-controlled segment that
    // COULD collide. A hyphen breaks the run, which is why even a deliberately hex-ish name is safe.
    for (const slug of [
      'sarah-and-toms-wedding-2026',      // 27 chars of [a-z0-9-] — a base64url rule would eat this
      'decade-of-facade-cafe-beef',       // every word is hex, every gap is a hyphen
      'dads-60th-at-the-beach-house',
    ]) {
      assert.equal(redactPath(`/e/${slug}`), `/e/${slug}`, slug);
    }
  });

  test('the one honest false positive, stated rather than hidden', () => {
    // A host who names their event with 24+ UNBROKEN hex characters does get redacted. It costs
    // that one event its own row in the path report and nothing else — and it is the price of a
    // rule that catches a credential on a route that does not exist yet. Documented, not fixed.
    const at24 = 'abcdef0123456789abcdef01';
    const at23 = 'abcdef0123456789abcdef0';
    assert.equal(at24.length, 24);
    assert.equal(at23.length, 23);
    assert.equal(redactPath(`/e/${at24}`), '/e/:token');
    // One character shorter and it is not — the bound is exactly where the comment says it is.
    assert.equal(redactPath(`/e/${at23}`), `/e/${at23}`);
  });

  test('the bound sits strictly between the two, with room on both sides', () => {
    const shortestCredential = 32;                              // organizer code
    const longestRealRun = 'abcdefabcdef'.length;               // no route name comes close
    assert.ok(longestRealRun < 24 && 24 < shortestCredential);
  });
});

describe('isTokenRoute matches whole segments, or it is a liability', () => {
  test('the four email-link routes', () => {
    for (const r of TOKEN_ROUTES) {
      assert.equal(isTokenRoute(r), true, r);
      assert.equal(isTokenRoute(`${r}/${HEX64}`), true, r);
    }
  });
  test('/signup is not /s-anything, and /unsubscribed is not /unsubscribe', () => {
    for (const p of ['/signup', '/s/abc', '/siteadmin', '/unsubscribed', '/surveys', '/cohosting']) {
      assert.equal(isTokenRoute(p), false, p);
    }
  });
  test('the marketing funnel is untouched — that is what keeps the deny-list affordable', () => {
    for (const p of ['/', '/pricing', '/signup', '/login', '/app', '/dashboard', '/demo',
                     '/join/EPZ8MYF2', '/e/sarahs-wedding', '/gallery/EPZ8MYF2', '/admin/EPZ8MYF2']) {
      assert.equal(isTokenRoute(p), false, p);
    }
  });
  test('a tail below a token route stays readable, only the token position goes', () => {
    assert.equal(redactPath(`/survey/${SURVEY}/thanks`), '/survey/:token/thanks');
  });
});

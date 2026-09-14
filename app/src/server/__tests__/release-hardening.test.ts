// The three release-audit findings that can silently come back, pinned so they cannot.
//
// Each of these was invisible in normal use: the relay route was unreachable from the product, the
// missing eventId only mattered to someone who had already opted out, and the 500 needed a body no
// client sends. So none of them would be noticed by using the app — only by asserting on them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import participantsRoutes, { asText } from '../routes/participants';

const SERVER = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SERVER, p), 'utf8');

/** Source with comments stripped, so a check for "does this code still do X" is not satisfied by a
 *  comment SAYING it no longer does — the tombstone left where a deleted route was names the thing
 *  it deleted, and should go on naming it. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The paths an express Router actually answers on. Read from the router itself rather than from
 *  the source text, so a route that came back under any name or spelling is still caught. */
function routePaths(router: unknown): string[] {
  const stack = (router as { stack?: { route?: { path?: string | string[] } }[] }).stack ?? [];
  return stack.flatMap((l) => {
    const p = l.route?.path;
    return p === undefined ? [] : Array.isArray(p) ? p : [p];
  });
}

describe('the arbitrary-recipient mail relay stays deleted', () => {
  // POST /api/participants/email-my-photos took a free, uncapped guest session token and an
  // `emailOverride`, and sent mail from our domain to whatever address the caller named. Nothing in
  // the product used it. If it ever reappears it will look like a convenience feature.
  test('POST /email-my-photos is not a route on the participants router', () => {
    assert.equal(routePaths(participantsRoutes).includes('/email-my-photos'), false,
      'the relay route is back — a session token must never choose the recipient');
  });

  test('nothing on the server reads an attacker-supplied recipient override', () => {
    // The specific mechanism, not just the path: any `emailOverride` read anywhere is the same bug
    // wearing a different route name.
    for (const f of ['routes/participants.ts', 'index.ts']) {
      assert.equal(/emailOverride/.test(code(f)), false, `${f} still reads emailOverride`);
    }
  });

  test('index.ts no longer mounts limiters on the path it lived at', () => {
    assert.equal(/email-my-photos/.test(code('index.ts')), false,
      'a limiter mounted on a path with no route is how /email-gallery went unnoticed for months');
  });
});

describe('every send about an event tells the suppression check which event', () => {
  // sendMail() consults blocksFor(eventId ?? '', …). Omit the id and only the GLOBAL opt-out is
  // consulted, so "stop emailing me about this event" is silently a no-op — and the gallery blast,
  // which is up to 200 host-supplied addresses per press, was omitting it.
  //
  // Asserted over the source because the alternative is a live Postgres and a mail transport. The
  // shape is narrow: find each email.sendMail({ … }) call and read its own option list.
  const callsIn = (file: string): string[] => {
    const text = read(file);
    const out: string[] = [];
    for (const m of text.matchAll(/email\.sendMail\(\{/g)) {
      let depth = 0;
      let i = m.index! + 'email.sendMail('.length;
      const start = i;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) break; }
      }
      out.push(text.slice(start, i + 1));
    }
    return out;
  };

  test('the gallery blast passes an eventId', () => {
    const blast = callsIn('routes/events.ts').find((c) => /Gallery from |\bshare\.label\b/.test(c));
    assert.ok(blast, 'could not find the gallery/share blast send in routes/events.ts');
    assert.match(blast, /eventId:\s*ev\.id/,
      'the blast is back to blocksFor("") — a per-event unsubscribe would not apply to it');
  });

  test('no send in the route layer omits both eventId and always', () => {
    // `always: true` is the deliberate exemption (our own support inbox, a sign-in link someone
    // just asked for). Everything else is mail to a person about something, and must be
    // suppressible at the scope they chose.
    for (const f of ['routes/events.ts', 'routes/contact.ts', 'routes/participants.ts', 'routes/guests.ts']) {
      for (const call of callsIn(f)) {
        assert.ok(/eventId:/.test(call) || /always:\s*true/.test(call),
          `a sendMail in ${f} passes neither eventId nor always:\n${call.slice(0, 200)}`);
      }
    }
  });
});

describe('the join route answers 4xx to a malformed body, never 500', () => {
  // POST /api/participants is the first request every guest makes and it is unauthenticated.
  // `{"joinCode":{"a":1}}` and `{"name":123}` both reached .trim() on a non-string and threw out of
  // the handler as HTTP 500 — a server fault reported for a bad request, and one an error-rate
  // alert cannot tell from a real outage.
  //
  // Driving the handler needs a database, so this pins the coercion that stands between the body
  // and every .trim() in it: it must be TOTAL over the values JSON can produce. Imported, not
  // reimplemented — a copy here would pass while the route still threw.

  test('the source coerces the join body instead of trimming it raw', () => {
    const src = read('routes/participants.ts');
    assert.match(src, /const asText = /, 'the coercion helper is gone');
    assert.match(src, /const joinCode = asText\(body\.joinCode\)/);
    assert.match(src, /const name = asText\(body\.name\)/);
    assert.match(src, /const participantEmail = asText\(body\.email\)/);
    // The exact shape that used to throw: destructuring the body and trimming what came out.
    assert.doesNotMatch(src, /const \{ joinCode, name, email: participantEmail \} = req\.body/,
      'the raw destructure is back, and with it the 500');
  });

  test('every value a JSON body can hold survives the coercion and a .trim()', () => {
    // The two confirmed live were an object where a string was expected, and a number. The last
    // three are the ones a plain String() still throws on: JSON.parse('{"toString":null}') leaves
    // an object with no callable toString and a valueOf that returns itself, and ToPrimitive throws
    // TypeError on it — the same 500, reached by a stranger body. An array containing one is the
    // same trap one level down.
    const hostile = JSON.parse('{"toString":null,"valueOf":null}') as unknown;
    for (const v of [{ a: 1 }, 123, null, undefined, true, false, 0, '', [], ['a', 'b'],
                     hostile, [hostile], Object.create(null) as unknown]) {
      const out = asText(v);
      assert.equal(typeof out, 'string', `asText(${JSON.stringify(v)}) is not a string`);
      assert.doesNotThrow(() => out.trim().toUpperCase().slice(0, 40));
    }
  });

  test('a missing or unusable joinCode/name still fails the required check', () => {
    // The 400 must survive the coercion: `null` and `undefined` become '' and stay falsy, so the
    // "joinCode and name are required" guard still fires rather than falling through to a lookup.
    assert.equal(asText(null) || asText(undefined), '');
    // And an ordinary object does NOT become empty — it becomes a string that simply matches no
    // event, which is a 404, not a 500.
    assert.equal(asText({ a: 1 }), '[object Object]');
    // One that cannot be converted at all falls back to '', so the required-fields guard catches it
    // rather than a TypeError escaping the handler.
    assert.equal(asText(JSON.parse('{"toString":null,"valueOf":null}')), '');
  });
});

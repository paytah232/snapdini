// The release-audit findings that can silently come back, pinned so they cannot.
//
// Each of these was invisible in normal use: the relay route was unreachable from the product, the
// missing eventId only mattered to someone who had already opted out, and the 500 needed a body no
// client sends. So none of them would be noticed by using the app — only by asserting on them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import participantsRoutes, { asText } from '../routes/participants';
import { htmlEmail } from '../email';
import { escapeHtml } from '../lib';

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
    // Located by `html: message.html` rather than by its copy. The copy used to be a template
    // literal inside this very sendMail call ("Gallery from …"), which is what this test matched
    // on; it is inline-emails.ts galleryLinkEmail() now, so the words are no longer here. Only the
    // locator changed — the thing being asserted is the same and still matters.
    const blast = callsIn('routes/events.ts').find((c) => /html:\s*message\.html/.test(c));
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

// ── The 1.5.0 audit ──────────────────────────────────────────────────────────
//
// Four findings whose fix is a shape rather than a value: a unique index, an ON CONFLICT clause,
// an ordering of two statements, and one identifier instead of another. None of them can be driven
// from a unit test — three need a live Postgres and the fourth needs a mail transport — so each is
// pinned where it actually lives: the migration, the schema, and the handler's own source.

/** The text of a `name(` call, from its opening paren to the paren that closes it. Balance-matched
 *  rather than regexed, because every one of these calls contains nested parens and template
 *  literals and a lazy `[^)]*` stops at the first one. */
function callsOf(src: string, name: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(String.raw`\b${name}\(`, 'g'))) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}

/** Everything up to the first TOP-LEVEL comma — i.e. the first argument. */
function firstArg(call: string): string {
  let depth = 0;
  for (let i = 1; i < call.length; i++) {
    const c = call[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { if (depth === 0) return call.slice(1, i); depth--; }
    else if (c === ',' && depth === 0) return call.slice(1, i);
  }
  return call.slice(1, -1);
}

/** The body of one express handler, so an assertion about statement ORDER cannot be satisfied by a
 *  matching pair of statements in some other route of the same 2,000-line file. */
function handlerFor(src: string, path: string): string {
  const at = src.indexOf(path);
  assert.ok(at > 0, `no handler for ${path}`);
  const next = src.slice(at + path.length).search(/\nrouter\.(get|post|put|patch|delete)\(/);
  return src.slice(at, next < 0 ? undefined : at + path.length + next);
}

describe('one survey response per event is a rule the database keeps', () => {
  // routes/survey.ts read survey_responses, found nothing and inserted — with only a NON-unique
  // index behind the read. The survey token lives in an emailed link, never expires and is
  // replayable, so concurrent POSTs all passed the read, all inserted, and all fired the
  // unhappy-score operator alert: duplicate rows, and an ntfy storm from one link.
  const migration = read('drizzle/0051_survey_one_per_event.sql');

  test('0051 builds a UNIQUE index on survey_responses(event_id)', () => {
    assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_event ON survey_responses \(event_id\)/,
      'the unique index is the whole fix — without it the route below is still a check-then-insert');
  });

  test('0051 deduplicates BEFORE it builds the index', () => {
    // A unique index cannot be built over existing duplicates. A migration that discovers that on
    // someone else's data fails halfway through a deploy.
    const dedupe = migration.indexOf('DELETE FROM survey_responses');
    const create = migration.indexOf('CREATE UNIQUE INDEX');
    assert.ok(dedupe > 0, '0051 does not deduplicate, so it cannot be applied to a table that has duplicates');
    assert.ok(dedupe < create, 'the dedupe runs after the index build, which is the failure it exists to prevent');
  });

  test('schema.ts agrees that the index is unique', () => {
    // Out of step with the migration, the next `drizzle-kit generate` proposes dropping it.
    assert.match(read('schema.ts'), /uniqueIndex\('idx_survey_event'\)/,
      "schema.ts still declares idx_survey_event as a plain index — generate would drop the constraint");
  });

  test('the INSERT decides who was first, and only that caller notifies', () => {
    const src = code('routes/survey.ts');
    assert.match(src, /\.onConflictDoNothing\(\{ target: surveyResponses\.eventId \}\)/,
      'the insert no longer defers to the unique index');
    assert.match(src, /\.returning\(/, 'without returning() there is no way to tell who won');
    const guard = src.search(/if \(!written\)/);
    // The CALL, not the import at the top of the file, which is of course before everything.
    const notify = src.indexOf('notifyUnhappySurvey(');
    assert.ok(guard > 0, 'nothing checks whether this caller actually stored a row');
    assert.ok(notify > guard,
      'the operator alert fires before the "did I win?" check — the notification storm is back');
  });
});

describe('one gallery link per address is a rule the database keeps', () => {
  // Both senders decide whether to mail someone by reading share_sends first, and 0041 gave that
  // read nothing to stand on. Two presses of Send — or the host's blast racing the automatic guest
  // delivery — put the same link in the same inbox twice.
  const migration = read('drizzle/0052_share_sends_one_per_address.sql');

  test('0052 builds a unique index for BOTH kinds of link', () => {
    // Two partial indexes, not one over (event_id, share_id, email): share_id IS NULL is the
    // standing gallery link, and NULLs are DISTINCT in a Postgres unique index — a single
    // three-column index would leave exactly those rows unconstrained.
    assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS ux_share_sends_gallery[\s\S]*WHERE share_id IS NULL/);
    assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS ux_share_sends_share[\s\S]*WHERE share_id IS NOT NULL/);
  });

  test('0052 keys on lower(btrim(email)), which is what the readers key on', () => {
    // participants.email is stored as the guest typed it, on purpose. An index on the raw column
    // would let Mum@x.com and mum@x.com both past a constraint the reads treat as one person.
    for (const m of migration.match(/CREATE UNIQUE INDEX[\s\S]*?;/g) ?? []) {
      assert.match(m, /lower\(btrim\(email\)\)/, `an index keyed on the raw column:\n${m}`);
    }
  });

  test('0052 deduplicates BEFORE it builds the indexes', () => {
    const dedupe = migration.indexOf('DELETE FROM share_sends');
    const create = migration.indexOf('CREATE UNIQUE INDEX');
    assert.ok(dedupe > 0, '0052 cannot be applied to a table that already has duplicates');
    assert.ok(dedupe < create, 'the dedupe runs after the index build');
  });

  test('schema.ts declares both of them', () => {
    const src = read('schema.ts');
    assert.match(src, /uniqueIndex\('ux_share_sends_gallery'\)/);
    assert.match(src, /uniqueIndex\('ux_share_sends_share'\)/);
  });

  test('the blast CLAIMS an address before it mails it', () => {
    // An index alone does not stop the double-mail: both racers still send, and the loser merely
    // fails to write its row. The claim has to come first, so the ledger — not a read taken
    // moments earlier — is what decides.
    const h = handlerFor(code('routes/events.ts'), "'/:joinCode/email-link'");
    const claim = h.search(/db\.insert\(shareSends\)/);
    const send = h.indexOf('email.sendMail');
    assert.ok(claim > 0, 'the blast no longer writes to share_sends at all');
    assert.ok(claim < send,
      'the send happens before the claim, so two presses of Send both mail and only the row is deduped');
    assert.match(h.slice(claim), /^[\s\S]{0,400}onConflictDoNothing\(\)[\s\S]{0,200}returning\(/,
      'the claim does not defer to the unique index, so a concurrent press gets an exception instead of a skip');
  });

  test('the automatic guest send defers to the index too, or one collision costs the whole batch', () => {
    // recordSends() writes every recipient in ONE multi-row insert, and a unique violation rolls
    // back the statement — not the offending row. Its catch then swallows the error, so the mail
    // goes, nothing 500s, and EVERY guest in that batch loses their ledger row. A missing row reads
    // as "never sent them the link", which is precisely what authorises the second copy the ledger
    // exists to prevent. The migration's own closing note names this function for this reason.
    const inserts = code('guest-delivery.ts').match(/db\.insert\(shareSends\)[\s\S]*?;/g) ?? [];
    assert.equal(inserts.length, 1,
      'guest-delivery.ts no longer writes share_sends in exactly one place — check the new one by hand');
    assert.match(inserts[0], /onConflictDoNothing\(\)/,
      'recordSends() inserts with no ON CONFLICT: one racing address now costs every other guest their row');
  });

  test('the blast does not count a withheld send as one that went out', () => {
    // sendMail RETURNS { suppressed: true } for an address that has opted out, rather than
    // throwing. The blast discarded that return and ran sent++ regardless: the host was shown a
    // delivery that never happened, and the claim row written moments earlier kept its ok:true
    // about a link the guest does not hold. Under 0052 that row is the address's ONLY row, for
    // ever — so the false ok:true goes on to refuse them the real link once the suppression is
    // lifted. guest-delivery.ts's sendToGuest() separated the three outcomes for exactly this
    // reason; this is the send it was never carried across to.
    const h = handlerFor(code('routes/events.ts'), "'/:joinCode/email-link'");
    const result = h.search(/=\s*await email\.sendMail\(/);
    assert.ok(result > 0,
      "the blast throws away sendMail's return value, so a withheld send is indistinguishable from a delivery");
    const check = h.indexOf('.suppressed');
    const counted = h.search(/\bsent\+\+/);
    assert.ok(check > result, 'nothing in the blast reads .suppressed');
    assert.ok(counted > check,
      'sent++ runs before the suppression is read, so a message nobody received is reported to the host as sent');
    // And the claim has to be corrected, by the same call a failed send uses: an ok:true row for a
    // link that was never sent is the false record 0052 then makes permanent.
    assert.match(h.slice(check), /^[\s\S]{0,200}markNotSent\(/,
      'a suppressed send leaves its claim row saying ok:true — the guest is recorded as holding a link nobody sent');
    assert.match(h, /markNotSent = async[\s\S]{0,400}set\(\{ ok: false \}\)/,
      'markNotSent no longer writes ok:false, so neither non-delivery corrects its claim');
  });
});

describe('an endpoint that accepts a big body has a limiter of its own', () => {
  // The CSV import raises the body ceiling from express.json's 100KB default to 2 MB on two paths,
  // and both then PARSE all of it: measured at 576ms of CPU for 2 MB, 1.42s wall for five at once.
  // Under the generic 600/min /api backstop that is ~345 seconds of CPU per minute available to one
  // IP, against a single-process Node server. The gap was invisible because nothing about raising a
  // body limit makes you look at limiters — which is the same shape as the /email-gallery bug
  // pinned above, where a renamed route left its limiter matching nothing and nothing failed.
  //
  // So the rule is stated as an invariant over the file rather than as a check on one path: every
  // mount that raises the body limit must have a rate limiter on the same path.
  // NOT code(), and this is worth knowing about: code() strips block comments BEFORE line
  // comments, so the `/api/*` inside the `//` comment about Cloudflare cache rules opens a block
  // comment that the stripper then closes at the next `*/` two hundred lines later — swallowing
  // every limiter mount in the file. An earlier version of this test passed for exactly that reason
  // and proved nothing. Line comments first, then blocks.
  const idx = read('index.ts').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const bigBodyPaths = [...idx.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*express\.json\(\{[^}]*limit/g)]
    .map((m) => m[1]);
  const limited = [...idx.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w*[Ll]imiter)\b/g)].map((m) => m[1]);

  test('there is at least one such path, so this test is testing something', () => {
    assert.ok(bigBodyPaths.length > 0,
      'no express.json mount raises the body limit any more — if that is deliberate, delete this test');
  });

  for (const p of bigBodyPaths) {
    test(`${p} is rate limited`, () => {
      assert.ok(limited.some((l) => p === l || p.startsWith(l)),
        `${p} accepts a 2MB body and is governed only by the 600/min /api backstop. Mount a limiter `
        + `on it (app.use('${p}', someLimiter)).`);
    });
  }

  test('and the import limiter covers the preview as well as the commit', () => {
    // app.use is a PREFIX match, so one mount on .../guests/import governs .../guests/import and
    // .../guests/import/preview. That is deliberate and it is why the two are not listed twice —
    // but it only holds while the preview stays under that prefix.
    const guests = code('routes/guests.ts');
    for (const path of ['/:joinCode/guests/import', "'/:joinCode/guests/import/preview'"])
      assert.ok(guests.includes(path.replace(/'/g, '')),
        `the import routes moved out from under the limiter's prefix (${path})`);
  });
});

describe('nothing host-written reaches an email heading unescaped', () => {
  // htmlEmail() drops its title straight into an <h2>. routes/events.ts passed the RAW share.label
  // as that title while the body two dozen lines above used the escaped copy — the identical bug
  // was found and commented in guest-delivery.ts and the fix was not carried across.
  test('htmlEmail really does interpolate its title raw', () => {
    // The premise. If this ever stops being true the assertions below are guarding nothing.
    assert.match(htmlEmail('<img src=x onerror=alert(1)>', 'body'), /<h2[^>]*><img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(htmlEmail(escapeHtml('<img src=x onerror=alert(1)>'), 'body'), /<img src=x/);
  });

  test('no htmlEmail title is a raw .label or .name off a host-controlled row', () => {
    // inline-emails.ts joined the list when the gallery-link, co-host and empty-scope titles moved
    // there out of their route handlers. That file is now where a host-written name is escaped for
    // an <h2>, so it is where the mistake would be made.
    for (const f of ['routes/events.ts', 'routes/contact.ts', 'routes/guests.ts', 'guest-delivery.ts',
                     'ops-notify.ts', 'inline-emails.ts']) {
      for (const call of callsOf(code(f), 'htmlEmail')) {
        const title = firstArg(call);
        assert.doesNotMatch(title, /\b(share|ev|event|row|msg)\.(label|name)\b/,
          `${f}: an htmlEmail title interpolates a host-written value straight from its row — ` +
          `pass the escaped copy instead:\n${title.slice(0, 160)}`);
      }
    }
  });
});

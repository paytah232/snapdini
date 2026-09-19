// What a share link may and may not do, and who a link visitor is.
//
// Hearts and comments on a shared gallery are the first thing in the product that lets somebody
// WRITE without joining the event. Three rules hold that in place, and each one is a single line
// away from quietly coming undone:
//
//   1. A link visitor is NOT a participant. Participants are the paid entitlement — they count
//      against guest_cap, hold a roll, get a trick card and appear in the guest list. A gallery
//      link forwarded to forty relatives must never mint forty of those.
//   2. The switches are on the SHARE, not the event. One event can have a family gallery that
//      wants comments and a client gallery that must not. Reading the event's flags instead would
//      open every link the moment the host turned comments on for their guests.
//   3. A comment has one author but two possible KINDS of author. Every read of a thread joins
//      through a nullable column on each side, so both joins have to be LEFT. An INNER join on
//      either silently hides the other kind's messages — from guests, and from the host's own
//      moderation screen, which is the opposite of moderation.
//
// This file fails if any of the three is removed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// __dirname, not import.meta — this tsconfig's module setting makes import.meta a hard typecheck
// error. See email-shell.test.ts, which hit the same wall.
const read = (p: string) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const shares = read('../routes/shares.ts');
const photos = read('../routes/photos.ts');
const events = read('../routes/events.ts');
const schema = read('../schema.ts');
const mig = read('../drizzle/0061_share_reactions.sql');

// Built rather than written out, so a comment in this file can never be what a search matches.
const INNER = '.inner' + 'Join';
const LEFT = '.left' + 'Join';

describe('a link visitor is not a participant', () => {
  test('nothing on the share routes ever creates a participant', () => {
    // The whole point of the visitor table. An insert here would put a forwarded link straight
    // into the guest list and straight into the cap the host paid for.
    assert.ok(!/insert\(participants\)/.test(shares),
      'routes/shares.ts inserts into `participants` — a share-link visitor must never become one');
  });

  test('the visitor token is scoped to ONE share', () => {
    // Without the shareId half, a token minted on the family link would be an identity on the
    // client link too — a different audience the host deliberately kept separate.
    const fn = shares.slice(shares.indexOf('async function visitorFor'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /shareVisitors\.sessionToken/);
    assert.match(body, /shareVisitors\.shareId/,
      'visitorFor() no longer scopes the token to the share it was minted on');
  });
});

describe('the switches belong to the link', () => {
  test('the gate reads the share row, never the event', () => {
    const fn = shares.slice(shares.indexOf('async function reactionGate'));
    const body = fn.slice(0, fn.indexOf('\n  return r;\n}'));
    assert.match(body, /r\.share\.heartsEnabled/);
    assert.match(body, /r\.share\.commentsEnabled/);
    assert.ok(!/r\.event\.heartsEnabled|r\.event\.commentsEnabled/.test(body),
      'reactionGate() is reading the EVENT flags — reactions are per link, not per event');
  });

  test('every kind of link starts the same way: hearts on, comments off', () => {
    // ONE answer to "what does a new link do", rather than a different one depending on which kind
    // of link it is. Hearts on because a heart only ever adds a number to a screen; comments off
    // because a comment puts somebody's words on another person's gallery under a name — the same
    // pair the event itself has used since 0057/0060. A curated share started both-off for a while,
    // which left a /s/ link quieter by default than the gallery link sitting beside it.
    const want: Array<[string, string, string]> = [
      ['export const shares = pgTable', 'heartsEnabled', 'true'],
      ['export const shares = pgTable', 'commentsEnabled', 'false'],
      ['export const events = pgTable', 'galleryHeartsEnabled', 'true'],
      ['export const events = pgTable', 'galleryCommentsEnabled', 'false'],
    ];
    for (const [marker, col, expected] of want) {
      const at = schema.indexOf(marker);
      assert.ok(at > -1, `${marker} is gone`);
      const line = schema.slice(at, at + 6000).split('\n').find((l) => l.includes(`${col}:`));
      assert.ok(line, `${col} is gone`);
      assert.ok(line!.includes(`.default(${expected})`),
        `${col} no longer defaults to ${expected} — got: ${line!.trim()}`);
    }
  });

  test('a new link starts where the EVENT is, not at a fixed guess', () => {
    // A host who has just turned guest comments ON has told us what they are comfortable with, and
    // a link that starts at the opposite is a contradiction they then have to undo. The same in
    // reverse: hearts switched off for guests almost certainly means off for the link too. So the
    // creation paths seed from the event, and the schema defaults are only the backstop for a row
    // written without going through them.
    //
    // `?? `, never `||`: `false` is a real answer here and must not fall through to the default.
    assert.match(events, /galleryHeartsEnabled:\s*galleryHeartsEnabled \?\? \(heartsEnabled !== false\)/,
      'a new event\'s gallery link no longer inherits the guest hearts setting');
    assert.match(events, /galleryCommentsEnabled:\s*galleryCommentsEnabled \?\? \(commentsEnabled === true\)/,
      'a new event\'s gallery link no longer inherits the guest comments setting');
    assert.match(events, /flags\.heartsEnabled === undefined\) flags\.heartsEnabled = !!req\.event!\.heartsEnabled/,
      'a new curated share no longer inherits the event hearts setting');
    assert.match(events, /flags\.commentsEnabled === undefined\) flags\.commentsEnabled = !!req\.event!\.commentsEnabled/,
      'a new curated share no longer inherits the event comments setting');
  });

  test('reusing a link does not rewrite switches the host already set', () => {
    // Creating a share for content that already has one hands back the SAME link. An EXPLICIT
    // choice must land on it; an INHERITED default must not, or pressing Share again silently
    // resets a link the host had tuned — and that link may already be in somebody's inbox.
    const at = events.indexOf('if (existing) {');
    assert.ok(at > -1, 'the share-reuse branch is gone');
    const body = events.slice(at, at + 900);
    assert.match(body, /const asked/, 'reuse is writing `flags` (which carries inherited defaults) rather than only what was asked for');
    assert.ok(!/\bset\(flags\)/.test(body), 'reuse writes the inherited defaults over an existing link');
  });

  test('the host can only be given what they asked for', () => {
    // `undefined` means "the caller did not ask". Coercing it with !! would switch a link's
    // reactions off every time anything else about the share was saved.
    assert.match(events, /typeof heartsEnabled === 'boolean'/);
    assert.match(events, /typeof commentsEnabled === 'boolean'/);
  });
});

describe('a comment has two possible kinds of author', () => {
  const threads = [
    ['routes/shares.ts', shares, "router.get('/:token/comments'"],
    ['routes/photos.ts', photos, "router.get('/:joinCode/comments'"],
    ['routes/events.ts', events, "router.get('/:joinCode/words'"],
  ] as const;

  for (const [name, src, marker] of threads) {
    test(`${name} joins BOTH author tables, and joins them loosely`, () => {
      const at = src.indexOf(marker);
      assert.ok(at > -1, `${name}: ${marker} is gone — did the route move?`);
      const body = src.slice(at, at + 3000);
      // Join lines only — the SELECT list names the same two columns, and counting those would
      // make this pass for the wrong reason.
      const joins = body.split('\n').filter((l) => /Join\(/.test(l)
        && (l.includes('photoComments.participantId') || l.includes('photoComments.visitorId')));
      assert.equal(joins.length, 2,
        `${name} no longer joins both author tables on the comment thread`);
      for (const j of joins) {
        assert.ok(j.includes(LEFT) && !j.includes(INNER),
          `${name} joins an author table tightly:\n  ${j.trim()}\n` +
          'Both author columns are nullable — a tight join silently drops the other kind.');
      }
    });
  }
});

describe('the migration', () => {
  test('the visitor heart index is PARTIAL', () => {
    // Postgres treats NULLs as distinct, so a plain composite over a nullable column deduplicates
    // nothing at all — it would sit there looking like idempotency and providing none.
    const line = mig.split(';').find((st) => st.includes('photo_hearts_photo_visitor_uq'));
    assert.ok(line, 'the visitor heart unique index is gone');
    assert.match(line!, /UNIQUE/i);
    assert.match(line!, /WHERE\s+visitor_id\s+IS\s+NOT\s+NULL/i,
      'the index is no longer partial — over a nullable column it would deduplicate nothing');
  });

  test('exactly one author per row is enforced in the database', () => {
    const checks = mig.split('\n').filter((l) => /\(participant_id IS NULL\) <> \(visitor_id IS NULL\)/.test(l));
    assert.equal(checks.length, 2,
      'both photo_hearts and photo_comments need the one-author CHECK');
  });
});

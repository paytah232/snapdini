// Who is allowed to hold a copy of the gallery answer, and for how long.
//
// `GET /api/photos/:code?gallery=true` is the highest-fan-out response in the product — one host,
// one link, every guest's phone polling it — so it is the one response worth caching at the edge.
// It is also one wrong line away from being the worst thing in the codebase to cache.
//
// THE HAZARD, stated plainly, because the whole file exists for it:
//
//   The gallery branches build their rows with `photoRow(p, null, captions)`. `null` is the VIEWER,
//   and with no viewer the row carries no `isOwn` and the envelope carries no `myParticipantId` —
//   the bytes are identical for every person who asks. That, and nothing else, is what makes a
//   `Cache-Control: public` on it safe.
//
//   The participant branches pass `participant.id` and get a body that is specific to one guest.
//   If somebody ever "tidies" the gallery branch by passing the real participant through it — an
//   entirely innocuous-looking change, and the obvious way to add an `isOwn` tick to the shared
//   gallery — then a shared cache will serve one guest's personalised response to a different
//   guest. There is no error, no log line and no way to notice; it looks like the feature working.
//
// So this file fails if the gallery branch ever becomes viewer-specific. If you are reading it
// because it broke: either put the viewer back to `null`, or remove the public Cache-Control from
// that branch. Do not do one without the other.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  galleryCacheSeconds, galleryCacheControl,
  GALLERY_CACHE_REVEALED_S, GALLERY_CACHE_MAX_S, GALLERY_CACHE_MANUAL_S, GALLERY_CACHE_REVEAL_MARGIN_S,
} from '../../../../shared/reveal';
import { photoRow } from '../routes/photos';

// ── The row, directly ──────────────────────────────────────────────────────────

const CAPTIONS = new Map<string, string>([['a1', 'The cake']]);
const ROW = {
  id: 'p1', filename: 'x.jpg', takenAt: 1, participantName: 'Ada', participantId: 'guest-1',
  challengeId: 'a1', isHighlighted: false,
};

describe('a photo row is shared or personal, never both', () => {
  test('no viewer → no viewer-dependent field anywhere on the WIRE', () => {
    // Asserted on the serialised body, not the object: what a cache holds is bytes, and
    // `isOwn: undefined` is a property in memory but nothing at all after JSON.stringify. The
    // distinction matters — the in-memory key is harmless, a key with a VALUE is the bug.
    const wire = JSON.parse(JSON.stringify(photoRow(ROW, null, CAPTIONS))) as Record<string, unknown>;
    assert.ok(!('isOwn' in wire),
      'photoRow(p, null, …) put isOwn on the wire. The gallery response is cached PUBLICLY on the ' +
      'strength of being byte-identical for every viewer; a viewer-dependent field in it means one ' +
      "guest is served another guest's answer from the edge.");
    // Stated as the whole key set rather than one field, so a NEW personalised field added later
    // fails here too instead of sailing through a check that only knows about isOwn.
    // `hearted` is the one this pattern did NOT catch: it is per-viewer to the letter — whether YOU
    // pressed the heart — and matches none of `own|mine|viewer|my*`. It was added in the same
    // release as this comment. Named explicitly rather than widening the regex, because the next
    // per-viewer field will not match a cleverer pattern either; what protects this is the list
    // below being kept current, and the assertion failing loudly when it is not.
    assert.ok(!('hearted' in wire),
      'photoRow put `hearted` on the wire with no viewer. That is one guest\'s state in a reply ' +
      'cached publicly for 30s — the next guest out of the cache gets it.');
    assert.ok(!Object.keys(wire).some((k) => /own|mine|viewer|hearted|^my[A-Z]/i.test(k)),
      `photoRow(p, null, …) grew a viewer-shaped key on the wire: ${Object.keys(wire).join(', ')}`);
    // And the same two rows, for two different viewers, really are the same bytes.
    // The branch the wire test above never reached: the gallery DOES pass heart info, and the guard
    // is `hearts?.viewer`. Counts are shared truth and belong in a cached reply; who pressed does
    // not. Passing a viewerless HeartInfo here is exactly what the public gallery path does.
    const withHearts = JSON.parse(JSON.stringify(
      photoRow(ROW, null, CAPTIONS, { counts: new Map([[ROW.id, 3]]), mine: new Set([ROW.id]), viewer: null }),
    )) as Record<string, unknown>;
    assert.equal(withHearts.hearts, 3, 'the shared COUNT should ride the cached reply');
    assert.ok(!('hearted' in withHearts),
      'a viewerless HeartInfo still leaked `hearted` — even though `mine` held this photo, which is ' +
      'the case that proves the guard is on `viewer` and not on the set being empty.');

    assert.equal(JSON.stringify(photoRow(ROW, null, CAPTIONS)),
                 JSON.stringify(photoRow({ ...ROW }, null, CAPTIONS)));
  });

  test('a viewer → isOwn, and it actually distinguishes them', () => {
    const mine = photoRow(ROW, 'guest-1', CAPTIONS) as Record<string, unknown>;
    const theirs = photoRow(ROW, 'guest-2', CAPTIONS) as Record<string, unknown>;
    assert.equal(mine.isOwn, true);
    assert.equal(theirs.isOwn, false);
    // ...which is exactly why such a response may never be cached: two viewers, two bodies, one URL.
    assert.notDeepEqual(mine, theirs);
  });
});

// ── The route, structurally ────────────────────────────────────────────────────
//
// Read as source rather than exercised, deliberately: the thing being guarded is which ARGUMENT a
// branch passes, and a running test would need a database, an event, two participants and a reveal
// state to reach four lines whose entire content is one identifier.

function routeSource(): string {
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    const f = path.join(d, 'src', 'server', 'routes', 'photos.ts');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const f = path.join(process.cwd(), 'app', 'src', 'server', 'routes', 'photos.ts');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  throw new Error('could not locate routes/photos.ts from ' + process.cwd());
}

/** The source between two of the route's own section headings. */
function section(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `the marker comment "${from}" is gone from routes/photos.ts — this test navigates by it`);
  const b = src.indexOf(to, a);
  assert.ok(b > a, `the marker comment "${to}" is gone from routes/photos.ts — this test navigates by it`);
  return src.slice(a, b);
}

const GALLERY_START = '// ── Gallery (view-only) mode';
const PARTICIPANT_START = '// ── Participant mode';
const ROUTE_END = 'export default router;';

describe('the public gallery branch is not, and must not become, viewer-specific', () => {
  const src = routeSource();
  const gallery = section(src, GALLERY_START, PARTICIPANT_START);
  const participant = section(src, PARTICIPANT_START, ROUTE_END);

  test('every photoRow() in the gallery branch is built with a null viewer', () => {
    const calls = gallery.match(/photoRow\([^)]*\)/g) ?? [];
    // One, today: the pre-reveal branch answers with a COUNT and no rows at all, so the revealed
    // branch is the only place the gallery builds any. A second one appearing is fine — it just has
    // to obey the same rule, which is why this loops rather than indexes.
    assert.ok(calls.length >= 1, `expected the gallery branch to still build rows; found ${calls.length} photoRow calls`);
    for (const c of calls) {
      assert.match(c, /photoRow\(\s*\w+\s*,\s*null\s*,/,
        `The gallery branch now builds rows as \`${c}\` instead of photoRow(p, null, …).\n\n` +
        'That response is sent with `Cache-Control: public` because it is the same bytes for every ' +
        'viewer. Passing a real participant makes it per-guest, and a shared cache (Cloudflare, a ' +
        "corporate proxy, venue wifi) will then serve one guest's personalised gallery to another " +
        'guest. Either pass `null`, or take the public Cache-Control off that branch — not one ' +
        'without the other.');
    }
  });

  test('no viewer-dependent field appears in the gallery branch at all', () => {
    for (const field of ['isOwn', 'myParticipantId', 'participant.id', 'ownCount', 'othersCount']) {
      assert.ok(!gallery.includes(field),
        `"${field}" has appeared in the gallery (?gallery=true) branch of routes/photos.ts.\n\n` +
        'That branch is edge-cacheable ONLY while its body is identical for every viewer. Anything ' +
        'derived from who is asking makes the cached copy wrong for the next person to ask — ' +
        'silently, and in the direction of showing one guest something personal to another.');
    }
  });

  test('the participant branches DO personalise — the contrast is the point', () => {
    assert.ok(/photoRow\(\s*\w+\s*,\s*participant\.id\s*,/.test(participant),
      'the participant branch no longer passes participant.id to photoRow — if personalisation moved, ' +
      'the cache rule in the gallery branch needs re-deciding, not leaving as it is');
    assert.ok(participant.includes('myParticipantId'),
      'the participant branch no longer sends myParticipantId');
  });

  test('the participant branches are marked un-cacheable, before any of them can return', () => {
    // perViewer() must sit above BOTH the pre-reveal return and the revealed one, and above the
    // ?own=true handling — a header set in only one of them is the leak wearing a fix.
    const guard = participant.indexOf('perViewer(res)');
    assert.ok(guard >= 0,
      'the participant branch of routes/photos.ts no longer sets a private, no-store Cache-Control. ' +
      'Those responses contain isOwn per row and, under ?own=true, one named guest\'s photographs.');
    const firstReturn = participant.search(/return res\.json\(/);
    assert.ok(firstReturn > guard,
      'perViewer(res) is set AFTER a response can already have been returned — some participant ' +
      'responses would go out cacheable. It must be above every return in the branch.');
  });

  test('the organizer branch is marked un-cacheable too', () => {
    const org = section(src, '// ── Organizer mode', GALLERY_START);
    // It passes `null` as well — a host is not one of the guests — but that is NOT what makes it
    // safe. It is gated on a secret and carries rejected photos and moderation status, so it is
    // per-viewer in the only sense that matters to a cache.
    assert.ok(org.includes('perViewer(res)'),
      'the organizer branch returns rejected photos, moderation status and every guest name; it must ' +
      'never be held by an intermediary');
  });
});

// ── The TTL ────────────────────────────────────────────────────────────────────

describe('how long the edge may hold the gallery answer', () => {
  const NOW = 1_700_000_000_000;

  test('revealed gets the long TTL', () => {
    assert.equal(galleryCacheSeconds({ revealed: true, revealAt: NOW - 60_000, revealMode: 'at_end', now: NOW }),
      GALLERY_CACHE_REVEALED_S);
  });

  test('a manual reveal never gets a long TTL — the host may press the button at any instant', () => {
    assert.equal(galleryCacheSeconds({ revealed: false, revealAt: null, revealMode: 'manual', now: NOW }),
      GALLERY_CACHE_MANUAL_S);
    // ...even if one somehow carries a scheduled instant. Manual is manual.
    assert.equal(galleryCacheSeconds({ revealed: false, revealAt: NOW + 6 * 3600_000, revealMode: 'manual', now: NOW }),
      GALLERY_CACHE_MANUAL_S);
  });

  test('a reveal ten seconds away yields 0, not 60', () => {
    assert.equal(galleryCacheSeconds({ revealed: false, revealAt: NOW + 10_000, revealMode: 'at_end', now: NOW }), 0);
  });

  test('a reveal far away gets the cap', () => {
    assert.equal(galleryCacheSeconds({ revealed: false, revealAt: NOW + 6 * 3600_000, revealMode: 'at_end', now: NOW }),
      GALLERY_CACHE_MAX_S);
  });

  test('THE invariant: a cached lock wall can never outlive the reveal it is denying', () => {
    // Every second of the last two hours before a reveal, plus a spread of odd offsets.
    const offsets: number[] = [];
    for (let s = 0; s <= 7200; s++) offsets.push(s * 1000);
    for (const extra of [1, 37, 499, 501, 999, 1499]) offsets.push(extra);
    for (const off of offsets) {
      const revealAt = NOW + off;
      const ttl = galleryCacheSeconds({ revealed: false, revealAt, revealMode: 'at_end', now: NOW });
      assert.ok(ttl >= 0, `negative TTL at +${off}ms`);
      if (ttl > 0) {
        assert.ok(NOW + ttl * 1000 <= revealAt - GALLERY_CACHE_REVEAL_MARGIN_S * 1000 + 999,
          `a TTL of ${ttl}s with the reveal ${off}ms away would let the edge serve "revealed: false" ` +
          `past the moment the gallery opened — a guest sits on a lock wall that has already lifted.`);
      }
    }
  });

  test('a reveal already in the past but not yet revealed is never cached', () => {
    // The skew window: the instant has passed, the server has not been asked yet. Caching "no" here
    // is caching the exact answer that is about to become wrong.
    for (const off of [-1, -1000, -60_000]) {
      assert.equal(galleryCacheSeconds({ revealed: false, revealAt: NOW + off, revealMode: 'at_end', now: NOW }), 0);
    }
  });

  test('0 seconds is spelled no-store, not max-age=0', () => {
    assert.equal(galleryCacheControl(0), 'private, no-store');
    assert.equal(galleryCacheControl(30), 'public, max-age=30');
  });
});

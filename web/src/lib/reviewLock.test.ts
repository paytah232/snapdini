// Does the read-only lock cover the REVIEW screen's writing controls?
//
// Sister file to adminLock.test.ts, which asks the same question of the event manager, and written
// the same way for the same reason: the logic lives in adminGuard.ts and is four lines, tested next
// door. What will actually break here is COVERAGE — somebody adds a control next spring, wires it
// to a handler that deletes something, and nobody notices it is the one thing a site admin can
// still do to a customer's wedding while the red bar says READ-ONLY. None of that shows up in a
// diff, a screenshot, or any test of the features this page has today.
//
// This route is worth its own file rather than a few more cases in the manager's, because the two
// screens are dangerous in opposite ways. The manager is dangerous because it LOOKS like a host's
// own page and half its switches autosave on change. Review has almost no switches: it is
// dangerous because everything on it is destructive and immediate — Reject bins a photograph,
// Remove takes down what somebody wrote, a turn rewrites and renames the stored file, a share
// hands out a working link. So the manager's file is mostly "is it disabled", and this one is
// mostly "is the write refused, and is the control that starts it dead".
//
// Everything below is ACCIDENT PREVENTION, not access control. The server authorises the same
// account for every one of these writes with or without a line of it, and the actor is a trusted
// admin. A gap found here is a UX bug; the boundary is requireAdmin on the server.
//
// Vite's ?raw, never node:fs. The web tsconfig carries no node types, so fs/path typecheck clean
// under vitest and then fail svelte-check — the trap readonlyClient.test.ts names at the top.
import { describe, it, expect } from 'vitest';
import REVIEW from '../routes/admin/[code]/review/+page.svelte?raw';
import MANAGER from '../routes/admin/[code]/+page.svelte?raw';

/** Just the markup: the <script> is full of the word `locked` and would make every assertion about
 *  an attribute pass by accident. */
const markup = (src: string) => src.slice(src.indexOf('</script>'), src.lastIndexOf('\n<style>'));

/** The same, with the comments taken out.
 *
 *  This codebase explains its decisions where they were made, so the sentence "it used to be
 *  behind `{#if locked}`" now sits one line above the thing that no longer is, and "the .ab-host
 *  wrapper is gone" names the wrapper. An assertion that cannot tell a rule from a note ABOUT a
 *  rule is an assertion that forbids writing the note down — which is the wrong trade on a guard
 *  whose whole risk is somebody a year from now not knowing why it is there. */
const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '');

/** Whole opening tags, brace-aware.
 *
 *  Lifted from adminLock.test.ts deliberately rather than shared, because the note it carries is
 *  the point: a plain /<button[^>]*>/ stops at the first `>`, which in this codebase is nearly
 *  always the one inside `on:click={() => …}`. It then returns a third of the tag, and any
 *  attribute written AFTER the handler — which is where `disabled` sits on most of this page — is
 *  invisible to it. That is how a coverage test quietly starts passing for the wrong reason.
 *  Counting `{}` depth and stopping at a `>` outside them reads the real tag. */
function openTags(src: string, names: string[]): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:${names.join('|')})\\b`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let i = m.index + m[0].length;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

/** Is this tag ACTUALLY gated by the flag, rather than merely mentioning it?
 *
 *  `toMatch(/locked/)` was the original assertion and it is far too generous. Every one of these
 *  passes it while doing the opposite of what it claims to test:
 *
 *      <button on:click={approve} disabled={!locked}>     the guard INVERTED
 *      <button on:click={approve} class="unlocked">       a class name
 *      <input placeholder="readOnly" />                   a placeholder
 *
 *  An assertion that passes on an inverted guard is worse than no assertion: it reports the control
 *  as protected precisely when it is protected in reverse. So: the flag has to appear inside a
 *  `disabled=`/`readOnly=` binding, and must not be negated there. */
function gatedBy(tag: string, flag: string): boolean {
  // `busy` counts as a disabling binding because RotateControl exposes it as exactly that —
  // its one lever, which makes all six of its buttons inert (turn left, turn right, Save,
  // Cancel). A component with no `disabled` of its own still has to be gateable.
  const binding = new RegExp(`(?:disabled|readOnly|busy)=\\{([^}]*)\\}`, 'g');
  for (const m of tag.matchAll(binding)) {
    const expr = m[1];
    if (!new RegExp(`\\b${flag}\\b`).test(expr)) continue;
    // `!locked` protects nothing; `x && locked` or a bare `locked` does.
    if (new RegExp(`!\\s*${flag}\\b`).test(expr)) continue;
    return true;
  }
  return false;
}

/** The top of a function, where a guard has to be to be worth anything — a refusal AFTER the work
 *  has started is not a refusal. Bounded rather than parsed to the closing brace, so the assertion
 *  stays about placement. */
function head(src: string, signature: string, chars = 900): string {
  const at = src.indexOf(signature);
  expect(at, `no such function: ${signature}`).toBeGreaterThan(-1);
  return src.slice(at, at + chars);
}

const MARKUP = markup(REVIEW);
const TAGS = openTags(MARKUP, ['button', 'input', 'textarea', 'RotateControl', 'SlideshowPanel',
                               'ShareModal', 'PhotoCard']);

/** Every tag matching `what`, with a floor so a refactor that stops the scanner finding anything
 *  cannot pass silently by matching nothing. */
function tagsFor(what: RegExp, expected = 1): string[] {
  const hits = TAGS.filter((t) => what.test(t));
  expect(hits.length, `found ${hits.length} controls matching ${what}, expected ${expected}`).toBe(expected);
  return hits;
}

// ── The controls that write ────────────────────────────────────────────────
//
// Named ONE BY ONE rather than swept, because on this route the read-only controls outnumber the
// writing ones three to one — a "everything except this allowlist" scan would be a list of forty
// tabs, arrows and filters that nobody would keep honest. Named, a failure says which control.
const WRITING_CONTROLS: [string, RegExp][] = [
  // Header + tab strip
  ['share the gallery (the header chooser)', /on:click=\{\(\) => \(scopeOpen = true\)\}/],
  ['open the moderation queue', /on:click=\{startModerating\}/],
  // The selection bar
  ['approve the selection', /bulkModerate\('approve'\)/],
  ['reject the selection', /bulkModerate\('reject'\)/],
  ['share the selection', /on:click=\{shareSelected\}/],
  // Captions & comments
  ['remove the selected lines', /on:click=\{removeSelected\}/],
  ['edit a caption from the captions list', /if \(p\) openCaption\(p\)/],
  ['remove one line (and its armed "Sure?")', /removeOne\(w\) : \(confirmWord/],
  // The grid
  ['favourite, from a card', /class="fav-corner"/],
  ['restore, from a card', /restore\(p\)/],
  ['approve, from a card', /approve\(p\)/],
  ['reject, from a card (and its armed "Sure?")', /requestReject\(p, e\)/],
  // The single view
  ['favourite, from the single view', /class="star"/],
  ['open the caption editor', /openCaption\(current, e\)/],
  ['restore, from the single view', /restore\(current\)/],
  ['approve, from the single view', /approve\(current\)/],
  ['reject, from the single view (and its armed "Sure?")', /requestReject\(current, e\)/],
  ['share this one photo', /shareOne\(current\)/],
  ['rotate — turn, save and cancel together', /<RotateControl/],
  // The shared components. Each of these owns writes this route cannot reach from out here, so
  // each is HANDED the lock rather than gated one control at a time — what they then do with it is
  // componentLock.test.ts's question. Listed here so that a call site that quietly stops passing it
  // fails on this page, which is the page that knows the answer.
  ['the slideshow builder, and its five writes', /<SlideshowPanel/],
  ['the share popup, which can rename a link and open it up to strangers', /<ShareModal/],
  ['double-tap-to-favourite, which reaches setRating without a button being pressed', /<PhotoCard/],
  // The caption editor
  ['remove a caption, in the editor', /captionDraft = ''; void saveCaption\(\)/],
  ['save a caption, in the editor', /on:click=\{saveCaption\}/],
];

describe('every control on the review screen that writes carries the lock', () => {
  // A floor under the scanner itself. If a refactor breaks openTags, every `.filter` below returns
  // nothing and tagsFor's own count would catch it — but this says so in one line.
  it('the tag scanner is reading the real page', () => {
    expect(TAGS.length).toBeGreaterThan(55);
  });

  for (const [name, what] of WRITING_CONTROLS) {
    it(`${name} — is dead when locked`, () => {
      for (const tag of tagsFor(what)) {
        // `locked`, not `disabled={locked}`: three of these compose it (`busy || locked`,
        // `!selectedCount || busy || locked`), and RotateControl takes it through `busy` because
        // that is the only lever it offers — one prop that kills all six of its buttons, reused
        // rather than growing a `disabled` on a component this change does not own.
        expect(gatedBy(tag, 'locked'), `${name} is not gated by \`locked\` (or the guard is inverted)`).toBe(true);
      }
    });
  }

  it('and nothing NEW slips in beside them', () => {
    // The net, for the control somebody adds next spring. Any button whose handler names a
    // function that writes must carry the lock, whether or not it is in the list above — so the
    // twenty-second one is gated by default rather than by somebody remembering this file.
    const writes = /setRating|onFavouriteClick|approve\(|requestReject|reject\(|restore\(|openCaption|saveCaption|removeOne|removeSelected|removeWord|bulkModerate|openShare|shareSelected|shareOne|scopeOpen = true|startModerating|turnBy|saveTurn/;
    const unlocked = openTags(MARKUP, ['button'])
      .filter((t) => writes.test(t))
      .filter((t) => !t.includes('locked'));
    expect(unlocked, 'buttons wired to a write with no lock').toEqual([]);
  });
});

// ── The controls that deliberately still work ──────────────────────────────
//
// Read-only has to mean read-ONLY, not useless. An operator is on this screen because somebody
// asked what is in their event, and a page that will not let them look is a page they will take
// control of on reflex — which turns the one deliberate press this whole guard is built around
// into a formality. So looking, sorting, filtering, paging and downloading all stay live, and
// every one of them is written down here so that disabling one later is a decision somebody had
// to make on purpose.
const STILL_LIVE: [string, RegExp, number?][] = [
  // Four of them, and the count is part of the assertion: "all four tabs are live" is the claim,
  // and a version of this that matched one would keep passing after three of them were gated.
  ['the filter tabs — pending / all / favourites / rejected', /setTab\(/, 4],
  ['sorting by hearts', /sort = sort === 'hearted'/],
  ['filtering by which guest took it', /toggleWho\(sh\.id\)/],
  ['clearing that filter', /on:click=\{clearWho\}/],
  ['the cards / single toggle', /openSingle\(singleIndex\)/],
  ['paging back through the single view', /on:click=\{prev\}/],
  ['paging forward through the single view', /on:click=\{next\}/],
  ['opening full screen', /class="fs-btn"/],
  ['the download chooser', /dlScopeOpen = true/],
  ['downloading the selection', /on:click=\{downloadSelected\}/],
  ['downloading the photo on screen', /downloadOne\(current\.url/],
  ['picking photos, and clearing the pick', /on:click=\{clearSelection\}/],
  ['re-reading the captions and comments list', /on:click=\{loadWords\}/],
  ['selecting all of those lines', /on:click=\{selectAllWords\}/],
  ['ticking one of them', /toggleWord\(w\)/],
];

describe('and read-only still lets the operator look', () => {
  for (const [name, what, n] of STILL_LIVE) {
    it(`${name} — still works`, () => {
      for (const tag of tagsFor(what, n ?? 1)) {
        expect(gatedBy(tag, 'locked'), `${name} was gated; read-only is meant to allow looking`).toBe(false);
      }
    });
  }
});

// ── The handlers ───────────────────────────────────────────────────────────
describe('every handler that writes refuses before it does anything', () => {
  // The disabled attributes above stop a mouse. These stop everything else: a keyboard press on a
  // control that was live when focus landed, an event dispatched by a child component — PhotoCard's
  // double-tap-to-favourite reaches setRating without any button on this page being pressed — and
  // the next handler somebody writes and forgets to gate.
  const guarded = [
    'async function openShare(',
    'async function setRating(',
    'async function approve(',
    'function openCaption(',
    'async function saveCaption(',
    'function requestReject(',
    'async function reject(',
    'async function restore(',
    'async function removeOne(',
    'async function removeSelected(',
    'function turnBy(',
    'async function saveTurn(',
    'async function bulkModerate(',
    'function startModerating(',
  ];

  for (const sig of guarded) {
    it(`${sig.replace(/^(async )?function /, '').replace(/\($/, '')} refuses when locked`, () => {
      expect(head(REVIEW, sig)).toMatch(/refuseWhenLocked\(\)|LOCKED_REFUSAL/);
    });
  }

  it('the reject confirm refuses at the ARMING, not at the second press', () => {
    // A button that has flipped to "Sure?" has told the operator it is live. A lock that only bites
    // on the confirm has already let him believe he is binning somebody's photograph.
    const body = head(REVIEW, 'function requestReject(');
    expect(body.indexOf('refuseWhenLocked()')).toBeLessThan(body.indexOf('confirmRejectId = photo.id'));
  });

  it('removeWord THROWS rather than declining politely', () => {
    // Its two callers read a clean return as "the server removed it" and strike the line out of the
    // list on the strength of it. A quiet `return` would take a comment off the operator's screen
    // that is still sitting on the customer's event.
    expect(head(REVIEW, 'async function removeWord(')).toMatch(/if \(locked\) throw new Error\(LOCKED_REFUSAL\)/);
  });

  it('the share popup is gated at the write as well as at the door', () => {
    // openShare is still the only thing that can put one on screen and still refuses — asserted as
    // "exactly one place builds it", because a second would be a write path standing outside every
    // guard on this page and would look perfectly ordinary in review.
    expect((REVIEW.match(/shareModal = \{/g) ?? []).length).toBe(1);
    expect(head(REVIEW, 'async function openShare(', 1400)).toMatch(/shareModal = \{/);
    // But the dialog is no longer safe BECAUSE of that. It can rename a link, change its public
    // URL and let strangers holding it heart and comment, and it now refuses all of that itself —
    // so the second opener somebody writes is safe by default rather than by remembering this file.
    expect(MARKUP, 'the share popup relies on its caller again').toMatch(/<ShareModal[^>]*readOnly=\{locked\}/);
  });

  it('the slideshow builder is handed the lock, not withdrawn', () => {
    // It used to be behind `{#if locked}`, and that was forced rather than chosen: generate, delete
    // a version, keep one, upload a track and the branding checkout all live inside the panel and
    // none of them is reachable from out here, so the door was the only lock this page could fit.
    // The cost was that a locked operator also lost the LIST of renders already made — a read, and
    // usually the very thing they were asked about. SlideshowPanel's own `readOnly` is the fix.
    const at = MARKUP.indexOf('<SlideshowPanel');
    expect(at).toBeGreaterThan(-1);
    // Nothing conditional stands between the tab and the panel any more.
    const branch = stripComments(MARKUP.slice(MARKUP.lastIndexOf("{:else if view === 'slideshow'}", at), at));
    expect(branch, 'the slideshow panel is behind a condition again').not.toMatch(/\{#if/);
  });
});

// ── The bar ────────────────────────────────────────────────────────────────
describe('the banner', () => {
  it('is the same component the manager and the console use', () => {
    expect(REVIEW).toMatch(/import AdminBanner from '\$lib\/components\/AdminBanner\.svelte'/);
    // And the red is not copied. One bar, one colour, in AdminBanner — the drift that component was
    // extracted to prevent.
    expect(REVIEW).not.toMatch(/#7a1f2b/);
  });

  it('only shows to a site admin who is not the host', () => {
    // `adminGuarded`, not `viewerIsAdmin`: an admin looking at their own event is a host like any
    // other and gets no bar. Asserted as "the block it opens in" by finding the last `{#if` above
    // it — a plain `.includes('{#if adminGuarded}')` would also pass if the bar sat outside it.
    const before = MARKUP.slice(0, MARKUP.indexOf('<AdminBanner'));
    const opens = before.match(/\{#if [^}]*\}/g) ?? [];
    expect(opens[opens.length - 1]).toBe('{#if adminGuarded}');
  });

  it('says which state the page is in, and offers both ways out', () => {
    const bar = MARKUP.slice(MARKUP.indexOf('<AdminBanner'), MARKUP.indexOf('</AdminBanner>'));
    expect(bar).toMatch(/READ-ONLY/);
    expect(bar).toMatch(/EDITING/);
    expect(bar).toMatch(/on:click=\{takeControl\}/);
    expect(bar).toMatch(/on:click=\{releaseControl\}/);
    expect(bar).toMatch(/href="\/siteadmin"/);
  });

  it('pins above the header rather than on top of it', () => {
    // Both are sticky. Without the measured offset they pin to the same line and the red bar sits
    // on the event name. Inline and only when the bar is there, so a host's page keeps the
    // stylesheet's `top: 0` byte for byte.
    expect(MARKUP).toMatch(/<AdminBanner sticky top="0" flush bind:height=\{adminBarH\}>/);
    expect(MARKUP).toMatch(/<header class="hd" style=\{adminGuarded \? `top:\$\{adminBarH\}px` : ''\}>/);
    // Through AdminBanner's own props now, rather than around them. `sticky` used to pin at
    // var(--nav-h) — the height of a site nav this route does not have — so this page wrapped the
    // component in a sticky <div class="ab-host"> and cancelled the bar's full-bleed margin with a
    // `:global` rule, which is a rule scoped to nothing and reaching every copy of the bar in the
    // app. `top` and `flush` say the same two things in the one place that owns the bar, and the
    // wrapper's own trap goes with it: a `position: sticky` child can only travel inside its
    // parent's box, so the snug <div> you reach for first does not stick at all.
    expect(stripComments(REVIEW), 'the .ab-host workaround is back').not.toMatch(/ab-host/);
  });
});

// ── The thing that ties the two screens together ───────────────────────────
describe('taking control on one screen is taking control on both', () => {
  it('because the lock is keyed by join code and nothing else', () => {
    // This is the whole reason the review screen needed no new plumbing. The manager and this page
    // are the same route parameter, the storage is the same tab's sessionStorage, and adminGuard
    // keys on the code alone — so "Take control" pressed on /admin/<code> is already in force when
    // Review opens, and "Hand it back" on either screen lets go of both.
    //
    // Asserted as "neither side qualifies the key", because a well-meant `${code}_review` would
    // split them in two and the symptom would be a second confirm dialog that nobody would connect
    // back to this line.
    for (const [who, src] of [['review', REVIEW], ['manager', MANAGER]] as const) {
      expect(src, `${who} does not read the shared lock`).toMatch(/readTookControl\(code\)/);
      expect(src, `${who} does not write the shared lock`).toMatch(/writeTookControl\(code, true\)/);
      expect(src, `${who} does not release the shared lock`).toMatch(/writeTookControl\(code, false\)/);
      expect(src, `${who} passes something other than the bare join code`).not.toMatch(/(read|write)TookControl\(`/);
    }
  });

  it('and both hold the page read-only while the ownership check is unanswered', () => {
    // The tri-state, on both screens. Folding 'unknown' into "yours" is what would put a live,
    // writable review screen on a customer's event for the moment before the reply lands — and the
    // review screen's writes are the ones that cannot be undone.
    for (const [who, src] of [['review', REVIEW], ['manager', MANAGER]] as const) {
      expect(src, `${who} does not derive ownership from youManage`).toMatch(/ownershipOf\(\w+\?\.youManage\)/);
      expect(src, `${who} does not derive locked from isLocked`).toMatch(/\$: locked = isLocked\(viewerIsAdmin, ownership, tookControl\)/);
    }
    // And review asks for the public event itself. The manager gets `youManage` free from the
    // event it already fetches for its organizer-code wall; this route has no wall, so a missing
    // fetch here would leave ownership permanently 'unknown' — read-only forever, with a "Take
    // control" press needed on every single visit.
    expect(head(REVIEW, 'void getEvent(code)', 200)).toMatch(/pubEvent = e0/);
  });
});

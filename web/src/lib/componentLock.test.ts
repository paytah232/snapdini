// The read-only guard, at the COMPONENT level.
//
// adminLock.test.ts asks the question of the event manager and reviewLock.test.ts asks it of the
// review screen. Both of those are about a route gating its own controls. This one is about the
// four pieces of shared furniture those routes hand work to, because a route can only gate what it
// can reach — and each of these had a gap the route could not close from outside:
//
//   SlideshowPanel  five writes live INSIDE it and none is reachable from the route, so review had
//                   to withdraw the whole panel behind `{#if locked}` — taking away the list of
//                   renders already made, which is a read.
//   AdminBanner     its `sticky` pinned at var(--nav-h), the height of a site nav. A route without
//                   one had to wrap it in a sticky <div> and reach back in with `:global`.
//   ShareModal      save() rewrites a link's name, its public URL and whether strangers holding it
//                   can heart and comment — with no guard at all. Safe only because the one caller
//                   that could open it was itself guarded, which is safety that lasts until the
//                   second caller.
//   PhotoCard       double-tap-to-favourite dispatched regardless. The route refused the write, so
//                   nothing was lost — but the card had already bloomed a star, so the refusal read
//                   as "it worked, and then it un-worked".
//
// All of it is ACCIDENT PREVENTION, not access control. The server authorises the same account for
// every one of these writes with or without a line of it, and the actor is a trusted admin. A gap
// found here is a UX bug; the boundary is requireAdmin on the server.
//
// Vite's ?raw, never node:fs. The web tsconfig carries no node types, so fs/path typecheck clean
// under vitest and then fail svelte-check — the trap readonlyClient.test.ts names at the top.
import { describe, it, expect } from 'vitest';
import SLIDESHOW from './components/SlideshowPanel.svelte?raw';
import SHARE from './components/ShareModal.svelte?raw';
import CARD from './components/PhotoCard.svelte?raw';
import BANNER from './components/AdminBanner.svelte?raw';
import REVIEW from '../routes/admin/[code]/review/+page.svelte?raw';
import MANAGER from '../routes/admin/[code]/+page.svelte?raw';

/** Just the markup: every one of these files says `readOnly` repeatedly in its <script>, and an
 *  assertion about an attribute would pass on the prop declaration alone. */
const markup = (src: string) => src.slice(src.indexOf('</script>'), src.lastIndexOf('\n<style>'));

/** Whole opening tags, brace-aware.
 *
 *  The same scanner as adminLock/reviewLock, and carried rather than shared for the same reason:
 *  the note is the point. A plain /<button[^>]*>/ stops at the first `>`, which in this codebase is
 *  nearly always the one inside `on:click={() => …}` — so it returns a third of the tag and any
 *  attribute written AFTER the handler is invisible to it. `disabled={readOnly}` is written after
 *  the handler on most of the controls below. Counting `{}` depth and stopping at a `>` outside
 *  them reads the real tag. */
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
 *  has started is not a refusal. Bounded rather than parsed to the closing brace so the assertion
 *  stays about placement. */
function head(src: string, signature: string, chars = 700): string {
  const at = src.indexOf(signature);
  expect(at, `no such function: ${signature}`).toBeGreaterThan(-1);
  return src.slice(at, at + chars);
}

/** Every tag in `tags` matching `what`, with a floor so a refactor that stops the scanner finding
 *  anything cannot pass by matching nothing. */
function pick(tags: string[], what: RegExp, expected = 1): string[] {
  const hits = tags.filter((t) => what.test(t));
  expect(hits.length, `found ${hits.length} controls matching ${what}, expected ${expected}`).toBe(expected);
  return hits;
}

// ── SlideshowPanel ─────────────────────────────────────────────────────────
const SS_MARKUP = markup(SLIDESHOW);
const SS_TAGS = openTags(SS_MARKUP, ['button', 'input', 'select', 'label', 'a', 'video', 'Toggle']);

describe('the slideshow panel refuses its five writes without going blank', () => {
  it('the scanner is reading the real panel', () => {
    expect(SS_TAGS.length).toBeGreaterThan(20);
  });

  it('takes the answer as a prop rather than leaving the caller to withdraw it', () => {
    expect(SLIDESHOW).toMatch(/export let readOnly = false;/);
  });

  it('and says no out loud rather than swallowing the press', () => {
    // A control that does nothing when pressed is indistinguishable from a broken page — the reason
    // GuestList's blockedPress() exists, and the reason this is a toast and not a bare `return`.
    expect(head(SLIDESHOW, 'function refuseWhenReadOnly()')).toMatch(/showToast\(READ_ONLY_WHY, true\)/);
  });

  // Named one by one, so a failure says WHICH write went unguarded rather than that a count moved.
  const SS_WRITES: [string, string, RegExp][] = [
    ['generate — starts a render on the customer\'s event',
     'async function generate(', /on:click=\{generate\}/],
    ['buy the branding removal — a Stripe checkout against the host\'s card',
     'async function buyBranding(', /on:click=\{buyBranding\}/],
    ['upload a backing track',
     'async function onAudioFile(', /on:change=\{onAudioFile\}/],
    ['keep (favourite) a rendered version — it changes what survives the nightly clear-out',
     'async function toggleFav(', /toggleFav\(s\.id\)/],
    ['delete a rendered version',
     'async function removeVersion(', /removeVersion\(s\.id\)/],
  ];

  for (const [name, sig, tag] of SS_WRITES) {
    it(`${name} — the handler refuses first`, () => {
      expect(head(SLIDESHOW, sig), `${name}: no refusal at the top of ${sig}`)
        .toMatch(/refuseWhenReadOnly\(\)/);
    });
    it(`${name} — and the control is dead before it is pressed`, () => {
      for (const t of pick(SS_TAGS, tag)) {
        expect(gatedBy(t, 'readOnly'), `${name} is not gated by \`readOnly\` (or the guard is inverted)`).toBe(true);
      }
    });
  }

  it('the upload label is marked refused too, not just the input inside it', () => {
    // A <label> has no disabled state of its own — `disabled` on the input is what makes the press
    // inert. The class is only so it LOOKS inert, which matters because this control is drawn as a
    // button and would otherwise be the one thing on a read-only panel that still lights up.
    for (const t of pick(SS_TAGS, /class="upload-track"/)) {
      expect(t).toMatch(/class:ctl-locked=\{readOnly\}/);
    }
  });

  it('and it says why, instead of presenting a dead button with nothing beside it', () => {
    // "The slideshow tab does nothing" is the bug report that follows silence — it is what
    // withdrawing the whole panel produced, and a greyed-out Generate on its own produces it too.
    expect(SS_MARKUP).toMatch(/\{#if readOnly\}/);
    expect(SS_MARKUP).toMatch(/Read-only —/);
  });

  // The whole point of the prop: the panel is still worth looking at.
  const SS_STILL_LIVE: [string, RegExp, number?][] = [
    ['choosing all photos', /favouritesOnly = false/],
    ['choosing favourites only', /favouritesOnly = true/],
    ['including video clips', /bind:checked=\{includeVideos\}/, 2],
    ['keeping the clips\' sound', /bind:checked=\{keepVideoAudio\}/],
    ['the running order', /order = 'chronological'/],
    ['seconds per photo', /bind:value=\{secondsPer\}/],
    ['resolution', /bind:value=\{resolution\}/],
    ['quality', /bind:value=\{quality\}/],
    ['adding a backing track', /addTrack\(m\.id\)/],
    ['clearing the music', /on:click=\{clearTracks\}/],
    ['previewing a track', /previewTrack\(m\.id\)/],
    ['the preview volume', /bind:value=\{volume\}/],
    ['looping the music', /bind:checked=\{loopMusic\}/],
    ['downloading a finished render', /slideshowDownloadUrl\(code, s\.id\)/],
    ['downloading the smaller 1080p copy of one', /slideshowDownloadUrl\(code, s\.id, '1080p'\)/],
  ];

  describe('and read-only still lets the operator look', () => {
    for (const [name, what, n] of SS_STILL_LIVE) {
      it(`${name} — still works`, () => {
        for (const t of pick(SS_TAGS, what, n ?? 1)) {
          expect(t, `${name} was gated; none of these reaches the server until Generate is pressed`)
            .not.toMatch(/readOnly/);
        }
      });
    }

    it('and the list of renders already made is still rendered at all', () => {
      // This is the read the route used to lose, and the reason the prop exists. Asserted as "no
      // `readOnly` branch stands between the panel and the list", because hiding it would look
      // perfectly reasonable in a diff.
      const at = SS_MARKUP.indexOf('Recent slideshows');
      expect(at).toBeGreaterThan(-1);
      const opens = (SS_MARKUP.slice(0, at).match(/\{#if [^}]*\}/g) ?? []);
      expect(opens[opens.length - 1]).not.toMatch(/readOnly/);
    });
  });

  it('the review screen hands it the lock instead of hiding it', () => {
    const [tag] = pick(openTags(markup(REVIEW), ['SlideshowPanel']), /<SlideshowPanel/);
    expect(tag).toMatch(/readOnly=\{locked\}/);
  });
});

// ── ShareModal ─────────────────────────────────────────────────────────────
const SHARE_MARKUP = markup(SHARE);
const SHARE_TAGS = openTags(SHARE_MARKUP, ['button', 'input', 'a', 'Toggle']);

describe('the share dialog refuses its write where the write is', () => {
  it('the scanner is reading the real dialog', () => {
    expect(SHARE_TAGS.length).toBeGreaterThan(8);
  });

  it('takes the answer as a prop rather than relying on whoever opened it', () => {
    expect(SHARE).toMatch(/export let readOnly = false;/);
  });

  it('save() refuses before it writes, and says so', () => {
    // One function, four fields: the link's name, its public URL, and whether strangers holding it
    // may heart and comment on somebody's wedding photographs.
    expect(head(SHARE, 'async function save(')).toMatch(/if \(readOnly\) \{ showToast\(READ_ONLY_WHY, true\); return; \}/);
  });

  const SHARE_WRITES: [string, RegExp][] = [
    ['Save changes', /on:click=\{save\}/],
    ['the link\'s name', /bind:value=\{label\}/],
    ['the custom URL', /bind:value=\{slug\}/],
    ['"use the name as the URL"', /slug = slugify\(label\)/],
    ['hearts on this link', /id="sh-hearts"/],
    ['comments on this link', /id="sh-comments"/],
  ];

  for (const [name, what] of SHARE_WRITES) {
    it(`${name} — is dead when read-only`, () => {
      for (const t of pick(SHARE_TAGS, what)) {
        expect(gatedBy(t, 'readOnly'), `${name} is not gated by \`readOnly\` (or the guard is inverted)`).toBe(true);
      }
    });
  }

  it('Undo needs no guard of its own, and that is not an oversight', () => {
    // revert() only puts the local fields back. With every field above dead, `dirty` can never
    // become true, so the button is never rendered in the first place — written down here so that
    // making a field editable again without thinking about this is a decision somebody had to make.
    expect(SHARE).toMatch(/function revert\(\) \{ label = savedLabel;/);
    expect(SHARE_MARKUP).toMatch(/\{#if dirty && !saving\}/);
  });

  const SHARE_STILL_LIVE: [string, RegExp][] = [
    ['copying the link', /on:click=\{copy\}/],
    ['the share sheet', /on:click=\{nativeShare\}/],
    ['opening the gallery', /href=\{url\}/],
    ['closing the dialog', /aria-label="Close"/],
  ];

  describe('and read-only still hands over the link', () => {
    for (const [name, what] of SHARE_STILL_LIVE) {
      it(`${name} — still works`, () => {
        for (const t of pick(SHARE_TAGS, what)) {
          expect(t, `${name} was gated; handing over a link that already exists is a read`)
            .not.toMatch(/readOnly/);
        }
      });
    }
  });

  it('and it says why, rather than letting somebody type into a box that will not take', () => {
    expect(SHARE_MARKUP).toMatch(/\{#if readOnly\}/);
    // Above the fields, not under the Save button: on a phone the button is often below the fold
    // while the field being typed into is not.
    expect(SHARE_MARKUP.indexOf('ro-note')).toBeLessThan(SHARE_MARKUP.indexOf('bind:value={label}'));
  });

  it('both call sites pass it, not just the one that needed it', () => {
    // Review's openShare() already refuses, so there the prop is unreachable today — which is
    // exactly why it is passed. The guard that only exists in whichever caller happens to be
    // guarded is the one that disappears when a third caller turns up.
    for (const [who, src] of [['review', REVIEW], ['manager', MANAGER]] as const) {
      const [tag] = pick(openTags(markup(src), ['ShareModal']), /<ShareModal/);
      expect(tag, `${who} opens the share dialog without handing it the lock`).toMatch(/readOnly=\{locked\}/);
    }
  });
});

// ── PhotoCard ──────────────────────────────────────────────────────────────
describe('the photo card does not animate a mark it is not allowed to make', () => {
  it('takes the answer as a prop', () => {
    expect(CARD).toMatch(/export let readOnly = false;/);
  });

  it('and folds it into the gesture, BEFORE the bloom rather than after the refusal', () => {
    // The distinction is the whole bug. Review does refuse the write at setRating() and toasts, so
    // the photograph was never in danger — but by then the card had drawn a filled star and played
    // the animation, so the sequence read as "it worked, and then it un-worked".
    expect(CARD).toMatch(/\$: dtLive = readOnly \? 'none'/);
  });

  it('so the optimistic star is unreachable, not merely undone', () => {
    // `bloom` is what draws it. Both assignments sit inside onCellDouble's dtLive branches, and
    // dtLive is 'none' when read-only — so there is no path that sets it. Counted, because a third
    // assignment somewhere else would be a bloom standing outside this.
    expect((CARD.match(/bloom = '/g) ?? []).length).toBe(2);
    const fn = head(CARD, 'function onCellDouble(');
    expect(fn).toMatch(/dtLive === 'heart' && !hearted/);
    expect(fn).toMatch(/dtLive === 'favourite' && !favourite/);
  });

  it('and looking is not made slower by it', () => {
    // 'none' also drops the 280ms the single tap otherwise waits to see whether a second one is
    // coming. On a screen where the gesture does nothing, opening a photo gets quicker.
    expect(head(CARD, 'function onCellClick(')).toMatch(/if \(dtLive === 'none'\) \{ dispatch\('open', e\); return; \}/);
  });

  it('the review screen hands it the lock', () => {
    const [tag] = pick(openTags(markup(REVIEW), ['PhotoCard']), /<PhotoCard/);
    expect(tag).toMatch(/readOnly=\{locked\}/);
  });
});

// ── AdminBanner ────────────────────────────────────────────────────────────
describe('the banner can be told where it sticks', () => {
  it('the nav height is the DEFAULT now, not a hard-coded assumption', () => {
    // It was `top: var(--nav-h)` in the stylesheet, which assumes every surface wanting this bar
    // sits under the site nav. The review screen does not have one, so the bar parked 62px down
    // with a strip of page scrolling above it.
    expect(BANNER).toMatch(/export let top = 'var\(--nav-h, 62px\)';/);
    expect(BANNER).toMatch(/top: var\(--ab-top, var\(--nav-h, 62px\)\);/);
    expect(BANNER, 'the nav height is still hard-coded into the sticky rule')
      .not.toMatch(/\n\t\ttop: var\(--nav-h, 62px\);/);
  });

  it('and the offset is only written onto the element when it actually sticks', () => {
    // `undefined` rather than '', so the console's non-sticky bar carries no stray `style=` for
    // somebody to copy.
    expect(markup(BANNER)).toMatch(/style=\{sticky \? `--ab-top:\$\{top\}` : undefined\}/);
  });

  it('and whether it bleeds into a page gutter is a prop, not a :global reach-in', () => {
    // A caller CAN override the margin from outside — one did — but `:global` is scoped to nothing
    // and applies to every copy of this bar in the app, which is the drift AdminBanner was
    // extracted to prevent.
    expect(BANNER).toMatch(/export let flush = false;/);
    expect(BANNER).toMatch(/\.admin-banner\.flush \{/);
    for (const [who, src] of [['review', REVIEW], ['manager', MANAGER]] as const) {
      // The RULE, not the words: review's markup still explains in a comment what it used to do,
      // and a test that cannot tell a rule from a sentence about one is a test that forbids
      // writing down why something changed.
      expect(src, `${who} reaches into the banner with an unscoped rule`).not.toMatch(/:global\(\.admin-banner\)\s*\{/);
    }
  });

  it('the manager takes the default, because it is the screen with a nav above it', () => {
    const [tag] = pick(openTags(markup(MANAGER), ['AdminBanner']), /<AdminBanner/);
    expect(tag).toMatch(/\bsticky\b/);
    expect(tag, 'the manager should not need to say where the bar goes').not.toMatch(/\btop=/);
    expect(tag).not.toMatch(/\bflush\b/);
  });

  it('and the review screen says where, rather than wrapping the component', () => {
    const [tag] = pick(openTags(markup(REVIEW), ['AdminBanner']), /<AdminBanner/);
    expect(tag).toMatch(/\bsticky\b/);
    expect(tag).toMatch(/top="0"/);
    expect(tag).toMatch(/\bflush\b/);
  });

  it('and there is still exactly one red', () => {
    // The reason this is a component at all. Two copies of this bar is two reds to keep in step by
    // hand, and this is the one element in the product whose whole job is to be recognisable.
    expect(BANNER).toMatch(/#7a1f2b/);
    expect(REVIEW).not.toMatch(/#7a1f2b/);
    expect(MANAGER).not.toMatch(/#7a1f2b/);
  });
});

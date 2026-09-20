// Does the read-only lock actually cover the controls that write?
//
// The logic is tested next door in adminGuard.test.ts and it is four lines; the part that will
// actually break is the COVERAGE. The event manager is 3,500 lines and roughly forty writing
// controls, and the failure mode is not that the lock stops working — it is that somebody adds a
// thirty-seventh toggle next spring, wires it to an autosaving handler, and nobody notices it is
// the one control a site admin can still nudge on a customer's wedding. Nothing about that is
// visible in a diff, in a screenshot, or in any test that checks the features this page has today.
//
// So these assertions are about the WIRING, in the same spirit as readonlyClient.test.ts: every
// writing control, found by walking the markup, must carry the lock — and the two that legitimately
// do not are named here, so adding a third is a decision somebody has to write down.
//
// Vite's ?raw, never node:fs. The web tsconfig carries no node types, so fs/path typecheck clean
// under vitest and then fail svelte-check — see the note at the top of readonlyClient.test.ts.
import { describe, it, expect } from 'vitest';
import MANAGER from '../routes/admin/[code]/+page.svelte?raw';
import GUESTLIST from './components/GuestList.svelte?raw';
import SITEADMIN from '../routes/siteadmin/+page.svelte?raw';
import BANNER from './components/AdminBanner.svelte?raw';

/** Just the markup: the <script> is full of the word `locked` and would make every assertion pass
 *  by accident. */
const markup = (src: string) => src.slice(src.indexOf('</script>'), src.lastIndexOf('\n<style>'));

/** Whole opening tags, brace-aware.
 *
 *  A plain /<button[^>]*>/ stops at the first `>` — which in this codebase is almost always the one
 *  in `on:click={() => …}`, so it returns a third of the tag and an attribute that comes after the
 *  handler is invisible to it. That is how a coverage test quietly starts passing for the wrong
 *  reason. Counting `{}` depth and stopping at a `>` outside them reads the real tag. */
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

/** The top of a function, where a guard has to be to be worth anything — a refusal AFTER the work
 *  has started is not a refusal. Bounded rather than parsed to the closing brace so the assertion
 *  stays about placement. */
function head(src: string, signature: string, chars = 700): string {
  const at = src.indexOf(signature);
  expect(at, `no such function: ${signature}`).toBeGreaterThan(-1);
  return src.slice(at, at + chars);
}

const MANAGER_MARKUP = markup(MANAGER);

describe('every control that writes carries the lock', () => {
  it('inputs, selects, textareas, toggles and time fields — all of them but the two that read', () => {
    const controls = openTags(MANAGER_MARKUP, ['input', 'select', 'textarea', 'Toggle', 'TimeField']);
    // A floor, so a refactor that stops the scanner finding anything cannot pass silently.
    expect(controls.length).toBeGreaterThan(30);

    /** The controls that write NOTHING, and why each is allowed through. Anything else that turns up
     *  unlocked is a new writing control that was never gated — which is the whole point of this
     *  file. Add to this list only after deciding the control really is read-only. */
    const readOnlyControls = [
      // The organizer-code wall. Only ever rendered when `authed` is false, which is a page a site
      // admin never reaches — they are through on their session.
      'id="org-code"',
      // Filters the participant list on screen. Writes nothing anywhere.
      'bind:value={partQuery}',
    ];

    const unlocked = controls
      .filter((t) => !t.includes('locked'))
      .filter((t) => !readOnlyControls.some((ok) => t.includes(ok)));
    expect(unlocked, 'writing controls with no lock').toEqual([]);
  });

  it('including the ones that are components rather than elements', () => {
    // Toggle and TimeField take `disabled`; they are the two that carry the settings form. Named
    // explicitly because the scan above would also pass if the page stopped using them at all.
    const toggles = openTags(MANAGER_MARKUP, ['Toggle']);
    expect(toggles.length).toBeGreaterThan(10);
    expect(toggles.every((t) => t.includes('disabled={locked}'))).toBe(true);
  });

  it('the guest list is handed the lock rather than left to guess', () => {
    expect(MANAGER_MARKUP).toMatch(/readOnly=\{locked\}/);
  });

  it('and the upgrade panel is withdrawn, not merely disabled', () => {
    // Its buttons start a Stripe checkout against the owner's card, and its one `blocked` state
    // says "save your settings first" — the wrong words on this page. So it is not rendered.
    expect(MANAGER_MARKUP).toMatch(/\{#if section === 'upgrade' && locked\}/);
  });
});

describe('every handler that writes refuses before it does anything', () => {
  // The disabled attributes above stop a mouse. These stop everything else: a keyboard press on a
  // control that was live when focus landed, a handler reached from a child component's event, and
  // the next control somebody adds and forgets to gate.
  const guarded = [
    'async function doReveal(', 'async function doLock(', 'async function doDelete(',
    'async function doReschedule(', 'async function requestRefund(',
    'async function saveSettingsForm(', 'async function sendGuestsNow(',
    'function toggleAspect(',
    'async function addCohost(', 'async function dropCohost(',
    'async function guestAction<', 'async function onGuestPreview(',
    'async function applyGalleryLink(', 'async function dropShare(', 'async function sendLink(',
    'async function moveCard(', 'async function removeParticipant(',
    'async function onPaletteApply(', 'async function applyPreset(', 'async function persistTheme(',
    'function onHeaderFile(', 'function onHeaderDrop(', 'async function onImageConfirm(',
    'async function clearHeaderImage(', 'function repositionImage(',
    'function openPoster(', 'function restylePoster(', 'async function pickPreset(',
    'function editMissionsFromPoster(', 'function answerPosterAsk(',
  ];

  for (const sig of guarded) {
    it(`${sig.replace(/^(async )?function /, '').replace(/[(<]$/, '')} refuses when locked`, () => {
      const body = head(MANAGER, sig);
      // Either the shared refusal, or the hand-rolled one for the handlers that must ALSO put a
      // control back where it was before saying no (a Toggle has already moved on screen).
      expect(body).toMatch(/refuseWhenLocked\(\)|LOCKED_REFUSAL/);
    });
  }

  it('the two switch handlers revert the switch before they refuse', () => {
    // A Toggle binds its own checkbox, so by the time the handler runs the thing has already
    // flipped on screen. Refusing without reverting leaves a switch showing a state that was never
    // saved — which is worse than the accident it prevents, because the operator now believes it.
    for (const sig of ['async function setGuestFlag(', 'async function onAllowDownloads(']) {
      const body = head(MANAGER, sig, 900);
      expect(body).toMatch(/input\.checked = !checked; showToast\(LOCKED_REFUSAL/);
    }
  });

  it('the poster offer never appears in a locked event at all', () => {
    // It is an UNPROMPTED modal whose primary button opens an editor that auto-saves. Computed
    // rather than read off the reactive `locked` because it runs from inside boot.
    expect(head(MANAGER, 'function maybeOfferPoster(')).toMatch(/isLocked\(viewerIsAdmin/);
  });
});

describe('the guest list cannot write when it is read-only', () => {
  it('shadows its own dispatcher, so no event escapes ungated', () => {
    // Six mutations and one of them is a single press. Gating the dispatcher rather than six call
    // sites is what makes the seventh one safe by default.
    expect(GUESTLIST).toMatch(/const emit = createEventDispatcher<GuestWrites>\(\)/);
    const fn = head(GUESTLIST, 'function dispatch<K extends keyof GuestWrites>');
    expect(fn).toMatch(/if \(readOnly\) \{ blockedPress\(READ_ONLY_WHY\); return; \}/);
    // And nothing goes around it back to the raw dispatcher: `emit(` is called in exactly one
    // place, which is inside the wrapper asserted above. A second call site would be a write that
    // never passes the gate, and it would look perfectly ordinary in review.
    expect((GUESTLIST.match(/\bemit\(/g) ?? []).length).toBe(1);
  });

  it('and marks its own buttons refused rather than only answering the press', () => {
    const buttons = openTags(markup(GUESTLIST), ['button']);
    const writers = buttons.filter((b) => /openAdd|importOpen = !importOpen|sendAll|submitForm|doPreview|commitImport|sendOne|openEdit|dispatch\('remove'/.test(b));
    expect(writers.length).toBeGreaterThan(6);
    expect(writers.every((b) => b.includes('disabled={readOnly}'))).toBe(true);
  });
});

describe('the banner', () => {
  it('is the same component on both surfaces, so the red cannot drift apart', () => {
    // The whole reason it was extracted. Svelte scopes CSS to the file that declares it, so two
    // copies of this bar is two reds to keep in step by hand — the failure SiteAdminLink was pulled
    // out of one release earlier.
    expect(SITEADMIN).toMatch(/import AdminBanner from '\$lib\/components\/AdminBanner\.svelte'/);
    expect(MANAGER).toMatch(/import AdminBanner from '\$lib\/components\/AdminBanner\.svelte'/);
    // And the colour lives in exactly one place.
    expect(BANNER).toMatch(/#7a1f2b/);
    expect(SITEADMIN).not.toMatch(/#7a1f2b/);
  });

  it('sticks on the manager, because that is the screen you forget you are on', () => {
    expect(MANAGER_MARKUP).toMatch(/<AdminBanner sticky bind:height=\{adminBarH\}>/);
    // And the section bar underneath it is offset by the bar's MEASURED height, so the two pin
    // flush instead of one hiding the other.
    expect(MANAGER).toMatch(/--admin-bar-h:\$\{adminBarH\}px/);
    expect(MANAGER).toMatch(/top: calc\(var\(--nav-h, 62px\) \+ var\(--admin-bar-h, 0px\)\)/);
  });

  it('only shows to a site admin who is not the host', () => {
    // `adminGuarded`, not `viewerIsAdmin`: an admin looking at their own event is a host like any
    // other and gets no bar. Asserted as "the block it opens in", by finding the last `{#if` above
    // it — `MANAGER.includes('{#if adminGuarded}')` would also pass if the bar sat outside it.
    const before = MANAGER_MARKUP.slice(0, MANAGER_MARKUP.indexOf('<AdminBanner'));
    const opens = before.match(/\{#if [^}]*\}/g) ?? [];
    expect(opens[opens.length - 1]).toBe('{#if adminGuarded}');
  });

  it('says which state the page is in, and offers the way out', () => {
    const bar = MANAGER_MARKUP.slice(MANAGER_MARKUP.indexOf('<AdminBanner'), MANAGER_MARKUP.indexOf('</AdminBanner>'));
    expect(bar).toMatch(/READ-ONLY/);
    expect(bar).toMatch(/EDITING/);
    expect(bar).toMatch(/on:click=\{takeControl\}/);
    expect(bar).toMatch(/href="\/siteadmin"/);
  });
});

describe('the action log', () => {
  it('is on both surfaces, and filtered to the event on the manager', () => {
    expect(SITEADMIN).toMatch(/<AdminActionLog heading=/);
    expect(MANAGER_MARKUP).toMatch(/<AdminActionLog eventId=\{ev\.id\} showEvent=\{false\}/);
  });

  it('has no revert button, and is not about to grow one', () => {
    // Deliberate: an undo here would be a second, hidden write path into a customer's event, sitting
    // outside every guard on the page it would be writing to.
    expect(MANAGER_MARKUP).not.toMatch(/revert|undo/i);
  });
});

// The test that stops the Outlook bug coming back.
//
// ── What happened ────────────────────────────────────────────────────────────
//
// A host opened a real Snapdini email and reported: "it's awful dark, the link is in dark blue and
// very hard to read." Two more observations pinned the cause exactly:
//
//   Outlook mobile      fine — WebKit/Blink, keeps <style>
//   Gmail mobile app    fine EXCEPT the yellow button was gone
//   Outlook web         dark applied, the call-to-action a default dark-blue link
//
// Two independent clients, one cause: the `.btn` rule lived in a <style> block, and Outlook.com and
// the Gmail app both DELETE <style>. In Gmail that cost the button its appearance; in Outlook web it
// cost that AND left the most important link in the message in the client's default blue on a
// near-black ground, which is the unreadable case that was reported. Eighteen other anchors across
// eight templates had no inline colour either, for the same reason: there was a stylesheet.
//
// ── What this file asserts ───────────────────────────────────────────────────
//
// Four things, and the second is the acceptance criterion:
//
//   A. Every builder's OUTPUT: every <a> carries an inline colour, nothing depends on a class,
//      no `rem` units, no holes in the view model, and the <style> element is in <head>.
//   B. THE DEGRADED CLIENT. The <style> block and every class attribute are stripped — which is
//      precisely what the two failing clients do — and the message must still be fully legible
//      with its call-to-action still reading as a gold button. This reproduces both observed
//      failures, so passing it is the standard.
//   C. A source-level sweep of the tree, in the spirit of suppression-chokepoint.test.ts: no
//      `class="btn"` anywhere, no <style> element outside email-theme.ts, no `rem`, and no
//      hand-written uncoloured anchor outside one documented file.
//   D. The plain-text alternative part: present on every customer-facing message, free of HTML
//      entities and markup, carrying every URL the HTML carries — and actually handed to BOTH
//      transports, because a field added to the Mail type and dropped by one of the two is this
//      project's recurring silent-failure shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

import { authEmail, hardenAnchors, htmlEmail } from '../email';
import { C } from '../email-theme';
import {
  accountWelcomeEmail, activationNudgeEmail, welcomeEmail, checkinEmail, surveyEmail,
  type LifecycleView,
} from '../lifecycle-emails';
import { eventEndEmail, releaseReminderEmail, photosLiveEmail } from '../guest-emails';
import { galleryLinkEmail, cohostInviteEmail, emptyScopeEmail, guestInviteEmail } from '../inline-emails';

// Located by walking up for the app directory, the same way suppression-chokepoint.test.ts does and
// for the same reason its comment gives: this package's tsconfig sets module=commonjs, where
// import.meta is a hard typecheck error.
function findServer(): string {
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'src', 'server', 'email.ts'))) return join(d, 'src', 'server');
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  const app = join(process.cwd(), 'app', 'src', 'server');
  if (existsSync(join(app, 'email.ts'))) return app;
  throw new Error('could not locate src/server from ' + process.cwd());
}
const SERVER = findServer();

// ── The catalogue ────────────────────────────────────────────────────────────
// One of every message a customer can receive, built from the real builders. Deliberately the same
// set app/scripts/email-sampler.ts renders, because a builder this file does not know about is a
// builder nothing checks.

const BASE = 'https://snapdini.com';
const DAY = 86_400_000;
const NOW = Date.now();
// An ampersand on purpose: it is the character that separates "escape it for the markup" from
// "leave it alone for the subject and the text part", and getting that backwards is a bug this
// codebase has shipped twice.
const EVENT = 'Priya & Tom’s Wedding';

const lifecycleView: LifecycleView = {
  ownerName: 'Priya', eventName: EVENT, guestCap: 80, shotsPerGuest: 12, framesAll: true,
  hasVideo: true, videoSeconds: 15, revealMode: 'at_end', retentionDays: 30,
  datesLabel: 'Sat 24 – Sun 25 Oct 2026', manageUrl: `${BASE}/dashboard`,
};
const guestView = {
  guestName: 'Marcus', eventName: EVENT, hostName: 'Priya',
  galleryUrl: `${BASE}/gallery/sample`, timezone: 'Australia/Brisbane',
};

interface Message { id: string; subject: string; html: string; text?: string; preheader?: string }

/** Every customer-facing message, and NOTHING that is only internal ops mail. */
const MESSAGES: Message[] = [
  { id: '01-auth-verify', ...authEmail('verify', `${BASE}/auth/verify?token=sample`) },
  { id: '02-auth-magic', ...authEmail('magic', `${BASE}/auth/magic?token=sample`) },
  { id: '03-account-welcome', ...accountWelcomeEmail({ ownerName: 'Priya', createUrl: `${BASE}/app`, unsubUrl: `${BASE}/email-preferences/tok` }) },
  { id: '04-activation-nudge', ...activationNudgeEmail({ ownerName: 'Priya', createUrl: `${BASE}/app`, unsubUrl: `${BASE}/email-preferences/tok` }) },
  { id: '05-event-welcome', ...welcomeEmail(lifecycleView) },
  { id: '06-event-welcome-starts-soon', ...welcomeEmail({ ...lifecycleView, startsSoon: true, hasVideo: false, videoSeconds: 0, framesAll: false, revealMode: 'instant' }) },
  { id: '07-checkin', ...checkinEmail(lifecycleView) },
  { id: '08-survey-full', ...surveyEmail({
      ...lifecycleView, surveyUrl: `${BASE}/survey/tok`, unsubUrl: `${BASE}/email-preferences/tok`,
      hostReward: { code: 'SAMPLE-THANKS-20', percentOff: 20, expiresAt: NOW + 90 * DAY },
      slideshow: { url: `${BASE}/admin/ABC/review?view=slideshow`, photoCount: 214, photosUntil: NOW + 6 * DAY },
    }) },
  { id: '09-survey-plain', ...surveyEmail({ ...lifecycleView, unsubUrl: `${BASE}/email-preferences/tok` }) },
  { id: '10-guest-event-end-thanks', ...eventEndEmail({ ...guestView, thanks: true, releaseAt: NOW + 2 * DAY, ownPhotoCount: 23 }) },
  { id: '11-guest-event-end-photos-only', ...eventEndEmail({ ...guestView, hostName: '', guestName: '', thanks: false, releaseAt: null, ownPhotoCount: 0 }) },
  { id: '12-guest-release-reminder', ...releaseReminderEmail({ ...guestView, releaseAt: NOW + DAY }) },
  { id: '13-guest-photos-live-all', ...photosLiveEmail({ ...guestView, scope: 'all', photoCount: 214 }) },
  { id: '14-guest-photos-live-favourites', ...photosLiveEmail({ ...guestView, scope: 'favourites', photoCount: 1 }) },
  { id: '15-guest-invite', ...guestInviteEmail({ eventName: EVENT, guestName: 'Marcus', joinCode: 'SAMPLE7', joinUrl: `${BASE}/e/sample`, unsubUrl: `${BASE}/unsubscribe/tok` }) },
  { id: '16-gallery-link', ...galleryLinkEmail({ eventName: EVENT, shareLabel: null, isShare: false, linkUrl: `${BASE}/gallery/sample`, joinUrl: `${BASE}/e/sample`, joinCode: 'SAMPLE7' }) },
  { id: '17-share-link', ...galleryLinkEmail({ eventName: EVENT, shareLabel: 'Ceremony picks', isShare: true, linkUrl: `${BASE}/s/sample` }) },
  { id: '18-cohost-invite', ...cohostInviteEmail({ inviter: 'Priya Raman', eventName: EVENT, acceptUrl: `${BASE}/cohost/tok` }) },
  { id: '19-host-no-favourites', ...emptyScopeEmail({ eventName: EVENT, scope: 'favourites', moderationEnabled: false, waiting: 12, reviewUrl: `${BASE}/admin/ABC/review` }) },
  { id: '20-host-nothing-approved', ...emptyScopeEmail({ eventName: EVENT, scope: 'all', moderationEnabled: true, waiting: 12, reviewUrl: `${BASE}/admin/ABC/review` }) },
  { id: '21-host-no-photos', ...emptyScopeEmail({ eventName: EVENT, scope: 'all', moderationEnabled: false, waiting: 1, reviewUrl: `${BASE}/admin/ABC/review` }) },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const anchorsIn = (html: string): string[] => html.match(/<a\b[^>]*>/gi) || [];
const styleOf = (tag: string): string | null => /style\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? null;

/** Anchored on `;`, whitespace or start-of-value, so `background-color:` is not mistaken for a
 *  colour on the text. That near-miss is how a sweep passes while every link is still the client's
 *  default blue. */
function hasInlineColour(tag: string): boolean {
  const s = styleOf(tag);
  return !!s && /(^|[;\s])color\s*:/i.test(s);
}

/** Every call-to-action cell in a message, with the cell's fill and the anchor inside it.
 *
 *  A CTA here is a one-cell table: `<td bgcolor="#f5c518" …><a …>Label</a></td>` for the filled
 *  variant, or the same with a border and no fill for the ghost variant. Matched as the td tag and
 *  the anchor tag SEPARATELY, because `background-color:` inside the cell's own style otherwise
 *  satisfies a naive search for `color:` — which is how a check like this passes while telling you
 *  nothing. */
function ctaCells(html: string): Array<{ fill: string | null; anchor: string }> {
  const out: Array<{ fill: string | null; anchor: string }> = [];
  const re = /<td\b([^>]*)>\s*(<a\b[^>]*>)/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tdAttrs = m[1], anchor = m[2];
    const fill = /\bbgcolor\s*=\s*"([^"]*)"/i.exec(tdAttrs)?.[1] ?? null;
    const ghost = /border\s*:\s*1px solid/i.test(tdAttrs);
    const inline = /display\s*:\s*inline-block/i.test(styleOf(anchor) ?? '');
    // Only the button shape, not every cell that happens to start with a link.
    if (inline && (fill || ghost)) out.push({ fill, anchor });
  }
  return out;
}

/** What Outlook.com and the Gmail app actually hand to their renderer: no <style>, no classes. */
function asDegradedClient(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\sclass\s*=\s*"[^"]*"/gi, '');
}

const LEAKS = ['undefined', 'NaN', '[object Object]'];

// ── A. Every builder's output ────────────────────────────────────────────────

describe('no email leaves the building with an uncoloured link', () => {
  for (const m of MESSAGES) {
    test(`${m.id}: every anchor states its own colour`, () => {
      const tags = anchorsIn(m.html);
      assert.ok(tags.length > 0, 'no anchors at all — the catalogue entry is probably wrong');
      const bare = tags.filter((t) => !hasInlineColour(t));
      assert.deepEqual(bare, [],
        `${m.id}: ${bare.length} anchor(s) with no inline color: — these render in the client's `
        + 'default dark blue on a near-black ground. Use link() or button() from email-theme.ts.');
    });
  }
});

describe('nothing load-bearing depends on a stylesheet or a class', () => {
  for (const m of MESSAGES) {
    test(`${m.id}: no class="btn", and the <style> element is in <head>`, () => {
      assert.doesNotMatch(m.html, /class\s*=\s*"[^"]*\bbtn\b/i,
        `${m.id}: a call-to-action still depends on class="btn". Outlook.com and the Gmail app `
        + 'delete <style>, so that button becomes a plain link. Use button() from email-theme.ts.');
      const head = m.html.slice(0, m.html.search(/<\/head>/i));
      const styles = m.html.match(/<style\b/gi) || [];
      const inHead = head.match(/<style\b/gi) || [];
      assert.equal(styles.length, inHead.length,
        `${m.id}: a <style> element outside <head>. The old shell put one at the end of <body>.`);
    });

    test(`${m.id}: px, not rem`, () => {
      const rem = m.html.match(/[0-9.]+rem\b/g) || [];
      assert.deepEqual(rem, [], `${m.id}: rem units (${rem.join(', ')}) — Outlook's Word engine does not support them.`);
    });

    test(`${m.id}: the ground is set as an attribute as well as in CSS`, () => {
      // Outlook desktop ignores `background` on <body> and on a <div>. Without a bgcolor attribute
      // on a real table, a dark email renders on white and pale text becomes invisible.
      assert.match(m.html, new RegExp(`<table[^>]*bgcolor="${C.page}"`, 'i'),
        `${m.id}: no full-bleed table carrying bgcolor — Outlook desktop will render this on white.`);
      assert.match(m.html, new RegExp(`<body[^>]*bgcolor="${C.page}"`, 'i'), `${m.id}: <body> has no bgcolor attribute.`);
    });

    test(`${m.id}: the client is told the scheme, so it stops second-guessing it`, () => {
      assert.match(m.html, /<meta name="color-scheme" content="(dark|light)">/);
      assert.match(m.html, /<meta name="supported-color-schemes" content="(dark|light)">/);
      assert.match(m.html, /color-scheme:\s*(dark|light)/);
    });

    test(`${m.id}: no holes in the view model`, () => {
      for (const leak of LEAKS) {
        assert.ok(!m.html.includes(leak), `${m.id}: html contains "${leak}"`);
        assert.ok(!m.subject.includes(leak), `${m.id}: subject contains "${leak}"`);
        if (m.text) assert.ok(!m.text.includes(leak), `${m.id}: text contains "${leak}"`);
      }
    });

    test(`${m.id}: the preheader is declared AND used`, () => {
      assert.ok(m.preheader?.trim(), `${m.id}: no preheader declared`);
      // It was declared by the copy modules and thrown away by the shell for the whole life of the
      // htmlEmail layout. Hidden, but present.
      assert.ok(m.html.includes(m.preheader!.replace(/&/g, '&amp;').slice(0, 40)),
        `${m.id}: the preheader is declared and then discarded`);
    });
  }
});

// ── B. THE ACCEPTANCE CRITERION: the client that deletes the stylesheet ──────

describe('with the stylesheet and every class removed — what Outlook.com and the Gmail app render', () => {
  for (const m of MESSAGES) {
    test(`${m.id}: still legible, and the call-to-action is still a gold button`, () => {
      const degraded = asDegradedClient(m.html);

      assert.doesNotMatch(degraded, /<style/i, 'the stripper did not work');
      assert.doesNotMatch(degraded, /class=/i, 'the stripper did not work');

      // Every link still coloured — this is the reported bug, in the client that caused it.
      const bare = anchorsIn(degraded).filter((t) => !hasInlineColour(t));
      assert.deepEqual(bare, [], `${m.id}: a link loses its colour when the stylesheet goes`);

      // The ground and the ink are both still stated, so nothing is dark-on-dark or light-on-light.
      assert.ok(degraded.includes(`background-color:${C.card}`), `${m.id}: the card lost its background`);
      assert.ok(degraded.includes(`color:${C.ink}`) || degraded.includes(`color:${C.head}`),
        `${m.id}: the body copy lost its colour`);

      // And the CTA is a real table-cell button, not an inline-styled <a>: `background` and
      // `border-radius` on an anchor are ignored by Outlook's Word engine even when inline, so a
      // one-cell table with the fill as an ATTRIBUTE is the only thing that draws a block in every
      // client. This is what Gmail lost when `.btn` went away.
      assert.ok(ctaCells(degraded).length > 0,
        `${m.id}: with no CSS there is no button left — only a bare link. Every CTA must be a `
        + 'one-cell table with the fill (or border) on the cell and the ink inline on the anchor.');

      // Every filled cell is the brand gold with near-black ink on it.
      for (const { fill, anchor } of ctaCells(degraded)) {
        if (fill !== C.gold) continue;
        const ink = /(^|[;\s])color:\s*(#[0-9a-f]{3,8})/i.exec(styleOf(anchor) ?? '')?.[2]?.toLowerCase();
        assert.equal(ink, C.goldInk.toLowerCase(),
          `${m.id}: ${ink} on the brand gold. Pale text on #f5c518 measures about 1.6:1; the only `
          + `ink allowed on it is ${C.goldInk}, which is what the logo chip has always done.`);
      }
    });
  }

  test('at least one message really is a gold-filled button, or the check above proves nothing', () => {
    const gold = MESSAGES.filter((m) => ctaCells(m.html).some((c) => c.fill === C.gold));
    assert.ok(gold.length >= MESSAGES.length - 1,
      `only ${gold.length} of ${MESSAGES.length} messages carry a gold-filled CTA. One legitimately `
      + 'does not (the check-in, whose only action is "reply to us", uses the ghost variant); more '
      + 'than that means button() stopped filling.');
  });
});

// ── C. The source-level sweep ────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}
const SOURCES = walk(SERVER).map((p) => [relative(SERVER, p), readFileSync(p, 'utf8')] as const);
/** Comments talk ABOUT the markup; only the markup itself is the subject of these sweeps. */
const stripComments = (code: string) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('the tree, swept', () => {
  test('nothing writes class="btn" any more — anywhere', () => {
    // There is no allow-list here any more. routes/guests.ts used to be on one, because its
    // inviteHtml() wrote `class="btn"` and one uncoloured anchor and was left for the chokepoint
    // in htmlEmail() to repair. The invite is inline-emails.ts guestInviteEmail() now and uses
    // button()/link(), so the exemption went with it and nothing may take its place.
    const hits = SOURCES
      .filter(([, code]) => /class\s*=\s*["'][^"']*\bbtn\b/.test(stripComments(code)));
    assert.deepEqual(hits.map(([f]) => f), [],
      'class="btn" is back. There is no rule behind it: the <style> block it lived in was deleted '
      + 'because Outlook.com and the Gmail app delete it too. Use button() from email-theme.ts.');
  });

  test('exactly one file emits a <style> element, and it says why', () => {
    const emitters = SOURCES
      .filter(([, code]) => /<style\b[^>]*>/.test(stripComments(code)))
      .map(([f]) => f);
    assert.deepEqual(emitters, ['email-theme.ts'],
      'a <style> element outside the one shell. Clients delete these; anything that matters is inline.');
  });

  test('no rem units in any email markup', () => {
    for (const [f, code] of SOURCES) {
      const rem = stripComments(code).match(/[0-9.]+rem\b/g) || [];
      assert.deepEqual(rem, [], `${f}: rem units (${rem.join(', ')}) — Outlook's Word engine ignores them.`);
    }
  });

  test('a hand-written anchor carries its colour, or its file is on the list and says why', () => {
    // The chokepoint in htmlEmail() repairs an uncoloured anchor in a body passed through it, so an
    // exception here is a documentation problem rather than a live bug — but an exception has to be
    // DELIBERATE, which is what this list makes it.
    // The list is EMPTY, and that is the point: routes/guests.ts was its only entry, and the
    // invite it named is a builder in inline-emails.ts now. Anything that appears here again is a
    // new hand-written anchor, not an inherited one.
    const ALLOWED: Record<string, string> = {};
    const offenders: string[] = [];
    for (const [f, code] of SOURCES) {
      if (ALLOWED[f]) continue;
      for (const tag of stripComments(code).match(/<a\s[^>]*>/g) || []) {
        // `buttonStyle(` is the shared CTA style string, which states a colour of its own.
        if (/color:/.test(tag) || /buttonStyle\(/.test(tag)) continue;
        offenders.push(`${f}: ${tag.slice(0, 100)}`);
      }
    }
    assert.deepEqual(offenders, [],
      'an anchor written by hand with no colour on it. Use link() or button() from email-theme.ts, '
      + 'or add the file to ALLOWED above with the reason.');
  });
});

// ── The chokepoint's own contract ────────────────────────────────────────────
// Nothing in the tree depends on this any more — the guest invite was the last body written by
// hand, and it uses button()/link() now. The repair pass stays, and so do these tests: it is the
// safety net for the body somebody writes next month in a file nobody thought to look at. The
// markup below is the invite's OLD source, kept deliberately as the worked example.

describe('htmlEmail repairs the markup it is handed', () => {
  test('a class="btn" call-to-action becomes a real table-cell button', () => {
    // routes/guests.ts inviteHtml() as it was written before it became a builder.
    const html = htmlEmail('Invited', '<p style="margin:24px 0"><a href="https://snapdini.com/e/x" class="btn">Join the event →</a></p>');
    assert.doesNotMatch(html, /class\s*=\s*"[^"]*\bbtn\b/, 'the class survived, and there is no rule behind it');
    assert.match(html, new RegExp(`<td[^>]*bgcolor="${C.gold}"`), 'no gold cell — the button is still a bare link');
    assert.match(html, new RegExp(`<a href="https://snapdini.com/e/x" style="[^"]*color:${C.goldInk}`), 'the anchor has no ink on it');
    assert.ok(html.includes('Join the event →'), 'the label was lost');
  });

  test('a bare anchor gets a colour', () => {
    const html = htmlEmail('T', '<p>Or go to <a href="https://snapdini.com/e/x">https://snapdini.com/e/x</a> and…</p>');
    assert.match(html, new RegExp(`<a href="https://snapdini.com/e/x" style="color:${C.link}`));
  });

  test('an anchor that already chose a colour keeps it', () => {
    // The invite's fine print picks a quieter grey deliberately. Overwriting a caller's choice
    // would make the chokepoint a thing to work around rather than a safety net.
    const html = htmlEmail('T', '<p><a href="https://x.test/u" style="color:#888">unsubscribe</a></p>');
    assert.ok(html.includes('style="color:#888"'), 'the caller\'s own colour was overwritten');
    assert.ok(!html.includes(`color:#888;color:${C.link}`), 'a second colour was appended');
  });

  test('a style attribute with no colour gets one appended, not replaced', () => {
    const html = htmlEmail('T', '<p><a href="https://x.test/u" style="font-weight:bold">u</a></p>');
    assert.match(html, new RegExp(`style="font-weight:bold;color:${C.link}"`));
  });

  test('a style attribute is a VALUE, not a replacement pattern', () => {
    // The third pass appended `;color:…` by calling String.replace with a replacement STRING, in
    // which `$&`, `` $` ``, `$'` and `$1` are substitution patterns rather than characters. `$'`
    // means "everything after the match", so a style carrying one would splice the rest of the
    // document back inside the tag and end the attribute early. Unreachable from any builder
    // today — nothing puts caller data in a style attribute, and esc() turns `"` into `&quot;` —
    // which is exactly why it needs a test rather than a reader noticing.
    const out = hardenAnchors(`<a href="https://x.test/" style="font-family:$'">hi</a>`);
    assert.ok(out.includes(`font-family:$'`), `the \`$'\` was substituted away:\n${out}`);
    assert.equal(out.match(/<a\b/g)?.length, 1, `the tag was duplicated by the substitution:\n${out}`);
    assert.match(out, new RegExp(`color:${C.link}"`), 'the colour was not appended');
    // `$&` is the whole match — the one that most obviously breaks out of the attribute.
    const amp = hardenAnchors('<a href="https://x.test/" style="font-family:$&">hi</a>');
    assert.ok(amp.includes('font-family:$&'), `\`$&\` was substituted away:\n${amp}`);
  });

  test('a button keeps every attribute it was given', () => {
    // The second pass rebuilt the anchor out of its href alone, so rel and target were silently
    // dropped from any button written in a shape the first pass does not match.
    const out = hardenAnchors('<a class="btn" href="https://x.test/" rel="noopener" target="_blank">go</a>');
    assert.match(out, /rel="noopener"/, 'rel was dropped from a button');
    assert.match(out, /target="_blank"/, 'target was dropped from a button');
    assert.match(out, /href="https:\/\/x\.test\/"/, 'the href was dropped from a button');
    assert.equal(out.match(/style=/g)?.length, 1, 'the anchor ended up with two style attributes');
  });

  test("a button whose href is single-quoted still goes somewhere", () => {
    // attrOf only reads double-quoted values, so the old fallback turned this into href="#".
    const out = hardenAnchors(`<a class="btn" href='https://x.test/e/abc'>go</a>`);
    assert.ok(out.includes("href='https://x.test/e/abc'"), `the href was lost:\n${out}`);
    assert.doesNotMatch(out, /href="#"/, 'a button was pointed at "#"');
  });

  test('and the title is still interpolated raw, because every caller escapes it', () => {
    // Pinned in release-hardening.test.ts too. Restated here because hardenAnchors runs over the
    // BODY and must never be extended to the title: that would double-escape every caller.
    assert.match(htmlEmail('<b>x</b>', 'body'), /<h2[^>]*><b>x<\/b>/);
  });
});

// ── D. The plain-text alternative part ───────────────────────────────────────

describe('every customer-facing email has a plain-text part', () => {
  for (const m of MESSAGES) {
    test(`${m.id}: it exists, and it is text`, () => {
      assert.ok(m.text?.trim(), `${m.id}: HTML-only. That is the fallback for a client that cannot `
        + 'render our HTML, what a screen reader prefers, and a deliverability penalty without it.');
      assert.doesNotMatch(m.text!, /<[a-z/][^>]*>/i, `${m.id}: the text part contains markup`);
    });

    test(`${m.id}: no HTML entities — a text part takes raw strings`, () => {
      const ents = m.text!.match(/&(amp|lt|gt|quot|nbsp|mdash|ndash|rsquo|lsquo|middot|rarr|#\d+);/g) || [];
      assert.deepEqual(ents, [],
        `${m.id}: the text part carries ${ents.join(', ')} — these reach the inbox literally, the `
        + 'same bug as an escaped Subject: header ("Priya &amp; Tom").');
      // The event name in particular. If it came through escaped, the reader sees the entity.
      assert.ok(!m.text!.includes('Priya &amp;'), `${m.id}: the event name was escaped into the text part`);
    });

    test(`${m.id}: every destination in the HTML is reachable from the text`, () => {
      const urls = new Set((m.html.match(/https?:\/\/[^"'\s<>]+/g) || []).map((u) => u.replace(/&amp;/g, '&')));
      const missing = [...urls].filter((u) => !m.text!.includes(u));
      assert.deepEqual(missing, [],
        `${m.id}: ${missing.length} URL(s) in the HTML are not in the text part. A text reader would `
        + 'be shown this message with its links removed.');
    });

    test(`${m.id}: and each URL is on its own line with a label`, () => {
      for (const line of m.text!.split('\n')) {
        const urls = line.match(/https?:\/\/\S+/g) || [];
        assert.ok(urls.length <= 1, `${m.id}: two URLs on one line — "${line.slice(0, 80)}"`);
      }
    });
  }
});

// The transport half. `text` added to the Mail type and silently dropped by one of the two
// transports is the exact shape of failure this project keeps getting bitten by, so both are
// exercised rather than read. Same two-module-instance pattern as suppression-chokepoint.test.ts:
// each copy of email.ts captures its transport choice at import.
describe('both transports actually carry it', () => {
  const emailPath = require.resolve('../email');

  const captured: Array<{ via: string; text: unknown; html: unknown }> = [];

  for (const k of ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN']) delete process.env[k];
  process.env.SMTP_HOST = 'smtp.test';
  process.env.SMTP_USER = 'user';
  process.env.SMTP_PASS = 'pass';
  const smtpStub = () => ({
    sendMail: async (m: { html?: unknown; text?: unknown }) => {
      captured.push({ via: 'smtp', text: m.text, html: m.html });
      return { messageId: '<smtp-1>' };
    },
  });
  // nodemailer 10 is a dual CJS/ESM build with a separate `default` object — patch both or the real
  // transport stays in place and the test dials smtp.test for real.
  const nodemailerMod = require('nodemailer');
  nodemailerMod.createTransport = smtpStub;
  if (nodemailerMod.default) nodemailerMod.default.createTransport = smtpStub;
  delete require.cache[emailPath];
  const smtpEmail = require('../email');

  process.env.MAILGUN_API_KEY = 'key';
  process.env.MAILGUN_DOMAIN = 'mg.test';
  delete require.cache[emailPath];
  const mailgunEmail = require('../email');

  globalThis.fetch = (async (_url: unknown, init: { body?: URLSearchParams }) => {
    captured.push({ via: 'mailgun', text: init?.body?.get('text'), html: init?.body?.get('html') });
    return { ok: true, json: async () => ({ id: '<mg-1@mg.test>' }) };
  }) as unknown as typeof fetch;

  const mail = {
    to: 'guest@example.com', subject: 'Your photos',
    html: '<p>hi</p>', text: 'hi\n\nhttps://snapdini.com/g/x',
    // always:true so this never reaches the suppression list, which would need a database.
    always: true as const,
  };

  test('mailgun sends it as the `text` form field', async () => {
    captured.length = 0;
    await mailgunEmail.sendMail(mail);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].via, 'mailgun');
    assert.equal(captured[0].text, mail.text, 'the Mailgun transport dropped the plain-text part');
    assert.equal(captured[0].html, mail.html);
  });

  test('smtp sends it as nodemailer\'s `text`', async () => {
    captured.length = 0;
    await smtpEmail.sendMail(mail);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].via, 'smtp');
    assert.equal(captured[0].text, mail.text, 'the SMTP transport dropped the plain-text part');
    assert.equal(captured[0].html, mail.html);
  });

  test('and a message with no text part still sends', async () => {
    // Optional with a fallback on purpose: an internal ops mail that has not been given one must
    // not throw. Only the customer-facing builders are required to supply it (above).
    captured.length = 0;
    await mailgunEmail.sendMail({ ...mail, text: undefined });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].text, null, 'an absent text part was sent as an empty one');
  });
});

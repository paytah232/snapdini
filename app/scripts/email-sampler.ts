/**
 * One-off EMAIL SAMPLER — renders one of every email Snapdini sends to a customer.
 *
 *   npx tsx scripts/email-sampler.ts --out /tmp/email-samples     # render to HTML files (default)
 *   npx tsx scripts/email-sampler.ts --send someone@example.com   # actually send them
 *
 * Why it exists: three of these messages (the pre-event check-in, the release reminder, the
 * post-event survey) only ever fire on a schedule, so driving the app by hand cannot produce a
 * complete set for a tester to look at.
 *
 * WHAT IS DELIBERATELY NOT HERE — internal mail a customer never receives:
 *   · ops-notify.ts  — the unhappy-survey alert, the risky-recovery alert and the daily ops digest.
 *                      All addressed to our own ops inbox.
 *   · routes/contact.ts — the contact / bug / refund form, addressed to support@. That is somebody
 *                      mailing US; there is no customer-facing copy in it.
 *
 * SAMPLE DATA IS INVENTED. No token, join code, share slug, guest address or event in here comes
 * from a database. Every address is on example.com (RFC 2606) and every token is obviously fake.
 *
 * DUPLICATION NOTICE — HISTORY now, and it is meant to stay that way. Five of these messages used
 * to be composed inline at their call site and reproduced verbatim below, which is a trap that had
 * already bitten twice: the raw-vs-escaped event-name bug was fixed in one copy and not the other.
 * All five are real builders now and this file imports every one of them, so there is exactly one
 * definition of each message:
 *
 *   auth verify / magic   → email.ts authEmail()
 *   gallery / share link  → inline-emails.ts galleryLinkEmail()
 *   co-host invitation    → inline-emails.ts cohostInviteEmail()
 *   empty-scope notice    → inline-emails.ts emptyScopeEmail()
 *   guest invite          → inline-emails.ts guestInviteEmail()
 *
 * There are no verbatim copies left, and a new one must not be added: if a message cannot be
 * rendered from here, the fix is to make it a builder, not to paste it in.
 */
import fs from 'fs';
import path from 'path';

import { authEmail, sendMail, enabled as emailEnabled, provider as emailProvider } from '../src/server/email';
import {
  accountWelcomeEmail, activationNudgeEmail, welcomeEmail, checkinEmail, surveyEmail,
  type LifecycleView,
} from '../src/server/lifecycle-emails';
import {
  eventEndEmail, releaseReminderEmail, photosLiveEmail, type GuestView,
} from '../src/server/guest-emails';
import { galleryLinkEmail, cohostInviteEmail, emptyScopeEmail, guestInviteEmail } from '../src/server/inline-emails';

// ── Sample data ──────────────────────────────────────────────────────────────
// Realistic enough to read like a real event; fake enough that nothing here is a credential.

const BASE = process.env.SAMPLER_BASE || 'https://snapdini.com';

const EVENT_NAME = 'Priya & Tom’s Wedding';
const HOST_NAME = 'Priya';
const GUEST_NAME = 'Marcus';
const JOIN_CODE = 'SAMPLE7';            // not a real join code — no such event exists
const SLUG = 'priya-and-tom-sample';
const TZ = 'Australia/Brisbane';

// Every one of these is a made-up string of the right SHAPE, so links look real and resolve to
// nothing. Do not replace them with values read out of the database.
const FAKE = {
  unsubToken: '11111111-2222-4333-8444-555555555555',      // uuid-v4 shaped (UNSUB_TOKEN_RE)
  prefsToken: 'deadbeef'.repeat(8),                         // 64 hex (PREFS_TOKEN_RE)
  surveyToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  cohostToken: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978',
  magicLink: `${BASE}/auth/magic?token=sample-magic-0000000000000000`,
  verifyLink: `${BASE}/auth/verify?token=sample-verify-000000000000000`,
  shareSlug: 'ceremony-picks-sample',
};

const PREFS_URL = `${BASE}/email-preferences/${FAKE.prefsToken}`;
const UNSUB_PAGE = `${BASE}/unsubscribe/${FAKE.unsubToken}`;
const GALLERY_URL = `${BASE}/gallery/${SLUG}`;
const JOIN_URL = `${BASE}/e/${SLUG}`;
const MANAGE_URL = `${BASE}/dashboard`;
const REVIEW_URL = `${BASE}/admin/${JOIN_CODE}/review`;

const DAY = 86_400_000;
const NOW = Date.now();

/** The host-side view model, shaped exactly as lifecycle.ts's buildView() produces it. */
const lifecycleView: LifecycleView = {
  ownerName: HOST_NAME,
  eventName: EVENT_NAME,
  guestCap: 80,
  shotsPerGuest: 12,
  framesAll: true,
  hasVideo: true,
  videoSeconds: 15,
  revealMode: 'at_end',
  retentionDays: 30,
  datesLabel: 'Sat 24 – Sun 25 Oct 2026',
  manageUrl: MANAGE_URL,
};

/** The guest-side view model, shaped as guest-delivery.ts produces it. */
const guestView: GuestView = {
  guestName: GUEST_NAME,
  eventName: EVENT_NAME,
  hostName: HOST_NAME,
  galleryUrl: GALLERY_URL,
  timezone: TZ,
};

// Copies 1–5 are all gone now: the guest invite, the gallery/share link, the co-host invitation,
// the empty-scope notice and the two auth mails are real builders, imported above and called
// directly in the catalogue below. That is five fewer places for a fix to be applied to one copy
// and not the other — which is the bug this file kept producing.

// ── The catalogue ────────────────────────────────────────────────────────────

interface Sample {
  /** Output filename stem, and the label printed in the run summary. */
  id: string;
  /** Where the copy lives, so the owner can find it. */
  source: string;
  /** Which branch of that template this sample exercises. */
  variant: string;
  subject: string;
  preheader?: string;
  html: string;
  /** The plain-text alternative part. Every customer-facing builder emits one, with no exceptions
   *  left — see the lint below, which now requires it of every sample. */
  text?: string;
}

function build(): Sample[] {
  const out: Sample[] = [];
  const add = (
    id: string, source: string, variant: string,
    m: { subject: string; preheader?: string; html: string; text?: string },
  ) => out.push({ id, source, variant, ...m });

  // 1–2. Auth
  add('01-auth-verify', 'email.ts authEmail', 'kind=verify', authEmail('verify', FAKE.verifyLink));
  add('02-auth-magic', 'email.ts authEmail', 'kind=magic', authEmail('magic', FAKE.magicLink));

  // 3–4. Account lifecycle
  add('03-account-welcome', 'lifecycle-emails.ts accountWelcomeEmail', 'named host, with unsubscribe link',
    accountWelcomeEmail({ ownerName: HOST_NAME, createUrl: `${BASE}/app`, unsubUrl: PREFS_URL }));
  add('04-activation-nudge', 'lifecycle-emails.ts activationNudgeEmail', 'named host, with unsubscribe link',
    activationNudgeEmail({ ownerName: HOST_NAME, createUrl: `${BASE}/app`, unsubUrl: PREFS_URL }));

  // 5–6. Event welcome — both sides of the startsSoon branch (it changes the opener AND adds the
  // 3-point pre-flight card).
  add('05-event-welcome', 'lifecycle-emails.ts welcomeEmail', 'startsSoon=false, video on, reveal=at_end',
    welcomeEmail(lifecycleView));
  add('06-event-welcome-starts-soon', 'lifecycle-emails.ts welcomeEmail',
    'startsSoon=true, video off, frames=square, reveal=instant',
    welcomeEmail({ ...lifecycleView, startsSoon: true, hasVideo: false, videoSeconds: 0,
      framesAll: false, revealMode: 'instant', guestCap: 10, shotsPerGuest: 8,
      datesLabel: 'Fri 18 Sep 2026' }));

  // 7. Check-in
  add('07-checkin', 'lifecycle-emails.ts checkinEmail', 'standard', checkinEmail(lifecycleView));

  // 8–9. Survey — the two optional blocks (host reward, slideshow offer) are the interesting part.
  add('08-survey-full', 'lifecycle-emails.ts surveyEmail',
    'hostReward + slideshow with a NEAR deadline (≤10 days → "worth doing before they go")',
    surveyEmail({
      ...lifecycleView,
      surveyUrl: `${BASE}/survey/${FAKE.surveyToken}`,
      unsubUrl: PREFS_URL,
      hostReward: { code: 'SAMPLE-THANKS-20', percentOff: 20, expiresAt: NOW + 90 * DAY },
      slideshow: { url: `${REVIEW_URL}?view=slideshow`, photoCount: 214, photosUntil: NOW + 6 * DAY },
    }));
  add('09-survey-plain', 'lifecycle-emails.ts surveyEmail',
    'no reward, no slideshow, no surveyUrl (falls back to manageUrl)',
    surveyEmail({ ...lifecycleView, unsubUrl: PREFS_URL }));

  // 10–11. Guest: end of event. Both halves of thanks/releaseAhead, and ownPhotoCount 0 vs many.
  add('10-guest-event-end-thanks', 'guest-emails.ts eventEndEmail',
    'thanks=true, release scheduled 2 days ahead, 23 own photos',
    eventEndEmail({ ...guestView, thanks: true, releaseAt: NOW + 2 * DAY, ownPhotoCount: 23 }));
  add('11-guest-event-end-photos-only', 'guest-emails.ts eventEndEmail',
    'thanks=false, no release, ownPhotoCount=0, no hostName (event name stands alone)',
    eventEndEmail({ ...guestView, hostName: '', guestName: '', thanks: false, releaseAt: null, ownPhotoCount: 0 }));

  // 12. Guest: the day before the reveal.
  add('12-guest-release-reminder', 'guest-emails.ts releaseReminderEmail', 'release 1 day ahead',
    releaseReminderEmail({ ...guestView, releaseAt: NOW + 1 * DAY }));

  // 13–14. Guest: photos live — both scopes.
  add('13-guest-photos-live-all', 'guest-emails.ts photosLiveEmail', 'scope=all, 214 photos',
    photosLiveEmail({ ...guestView, scope: 'all', photoCount: 214 }));
  add('14-guest-photos-live-favourites', 'guest-emails.ts photosLiveEmail', 'scope=favourites, 1 photo (singular)',
    photosLiveEmail({ ...guestView, scope: 'favourites', photoCount: 1 }));

  // 15. Guest invite.
  add('15-guest-invite', 'inline-emails.ts guestInviteEmail', 'named guest, unsubscribe link',
    guestInviteEmail({ eventName: EVENT_NAME, guestName: GUEST_NAME, joinCode: JOIN_CODE,
      joinUrl: JOIN_URL, unsubUrl: UNSUB_PAGE }));

  // 16–17. Emailed link — whole gallery vs a curated share.
  add('16-gallery-link', 'inline-emails.ts galleryLinkEmail', 'no share → gallery + join code',
    galleryLinkEmail({ eventName: EVENT_NAME, shareLabel: null, isShare: false,
      linkUrl: GALLERY_URL, joinUrl: JOIN_URL, joinCode: JOIN_CODE }));
  add('17-share-link', 'inline-emails.ts galleryLinkEmail', 'labelled share → no join code',
    galleryLinkEmail({ eventName: EVENT_NAME, shareLabel: 'Ceremony picks', isShare: true,
      linkUrl: `${BASE}/s/${FAKE.shareSlug}` }));

  // 18. Co-host invitation.
  add('18-cohost-invite', 'inline-emails.ts cohostInviteEmail', 'pending invite',
    cohostInviteEmail({ inviter: 'Priya Raman', eventName: EVENT_NAME,
      acceptUrl: `${BASE}/cohost/${FAKE.cohostToken}` }));

  // 19–21. Empty-scope notice to the host — all three situations.
  add('19-host-no-favourites', 'inline-emails.ts emptyScopeEmail', 'scope=favourites',
    emptyScopeEmail({ eventName: EVENT_NAME, scope: 'favourites', moderationEnabled: false, waiting: 12, reviewUrl: REVIEW_URL }));
  add('20-host-nothing-approved', 'inline-emails.ts emptyScopeEmail', 'scope=all, moderation on',
    emptyScopeEmail({ eventName: EVENT_NAME, scope: 'all', moderationEnabled: true, waiting: 12, reviewUrl: REVIEW_URL }));
  add('21-host-no-photos', 'inline-emails.ts emptyScopeEmail', 'scope=all, moderation off, 1 guest',
    emptyScopeEmail({ eventName: EVENT_NAME, scope: 'all', moderationEnabled: false, waiting: 1, reviewUrl: REVIEW_URL }));

  return out;
}

// ── Render / send ────────────────────────────────────────────────────────────

/** The things that leak into an email when a view model has a hole in it. */
const LEAKS = ['undefined', 'NaN', '[object Object]'];

function lint(s: Sample): string[] {
  const bad: string[] = [];
  if (!s.subject?.trim()) bad.push('empty subject');
  if (!s.html?.trim()) bad.push('empty html');
  for (const needle of LEAKS) if (s.html.includes(needle)) bad.push(`html contains "${needle}"`);
  for (const needle of LEAKS) if (s.subject.includes(needle)) bad.push(`subject contains "${needle}"`);

  // ── The rendering rules the owner's Outlook report came down to ──
  // An <a> with no inline colour takes the client's default, which is a dark blue that is
  // unreadable on this ground. A class is worth nothing in a client that deletes <style>.
  for (const tag of s.html.match(/<a\b[^>]*>/gi) || []) {
    const style = /style\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (!style || !/(^|[;\s])color\s*:/i.test(style)) bad.push(`anchor with no inline colour: ${tag.slice(0, 90)}`);
  }
  if (/class\s*=\s*"[^"]*\bbtn\b/i.test(s.html)) bad.push('a call-to-action still depends on class="btn"');
  for (const unit of s.html.match(/[0-9.]+rem\b/g) || []) bad.push(`rem unit (${unit}) — Outlook's Word engine does not support it`);

  // ── The plain-text part ──
  // No exceptions any more. There used to be one — the guest invite, which was built inline in a
  // route handler with nowhere to put the text version of its sentences. It is a builder now, so
  // the rule is simply: every customer-facing message has a text part.
  if (!s.text?.trim()) {
    bad.push('no plain-text alternative part');
  } else {
    // Entities in a text part reach the inbox literally: "Priya &amp; Tom". Same bug class as an
    // escaped Subject: header.
    for (const ent of s.text.match(/&(amp|lt|gt|quot|#\d+|nbsp|mdash|rsquo|middot|rarr);/g) || [])
      bad.push(`text part contains the HTML entity ${ent}`);
    if (/<[a-z/][^>]*>/i.test(s.text)) bad.push('text part contains markup');
    // Every destination in the HTML must be reachable from the text part, or the text reader is
    // being shown a message with its links removed.
    const urls = new Set((s.html.match(/https?:\/\/[^"'\s<>]+/g) || []).map((u) => u.replace(/&amp;/g, '&')));
    for (const u of urls) if (!s.text.includes(u)) bad.push(`URL missing from the text part: ${u}`);
  }
  if (s.preheader !== undefined) {
    // The shells HTML-escape the preheader before hiding it in the body, so an event name with an
    // `&` in it will not match raw. Compare against the escaped form, the same way the shell writes it.
    const escaped = s.preheader.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    if (!s.preheader.trim()) bad.push('empty preheader');
    else if (!s.html.includes(escaped.slice(0, 40))) bad.push('preheader not present in html');
  }
  return bad;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const to = arg('--send');
  const outDir = arg('--out') || (to ? null : path.resolve(process.cwd(), 'email-samples'));

  const samples = build();
  let problems = 0;

  console.log(`\nSnapdini email sampler — ${samples.length} messages\n`);

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const index: string[] = [];
    for (const s of samples) {
      const bad = lint(s);
      if (bad.length) { problems++; console.error(`  ✗ ${s.id}: ${bad.join('; ')}`); }
      // The subject and preheader are not part of the message body, so they are written into the
      // file as an HTML comment — visible in "view source", invisible in a browser preview.
      const header = `<!-- subject: ${s.subject}\n     preheader: ${s.preheader ?? '(none declared)'}\n`
        + `     source: ${s.source}\n     variant: ${s.variant} -->\n`;
      const file = path.join(outDir, `${s.id}.html`);
      fs.writeFileSync(file, header + s.html);
      // The plain-text part, beside the HTML. It is half of every message now, so it is half of
      // what a reviewer has to be able to read.
      if (s.text) fs.writeFileSync(path.join(outDir, `${s.id}.txt`),
        `subject: ${s.subject}\npreheader: ${s.preheader ?? '(none declared)'}\n`
        + `${'-'.repeat(72)}\n${s.text}`);
      const size = fs.statSync(file).size;
      index.push(`${String(size).padStart(7)}  ${s.id}.html  — ${s.subject}`);
      console.log(`  ✓ ${s.id.padEnd(32)} ${String(size).padStart(6)} B  ${s.subject}`);
    }
    fs.writeFileSync(path.join(outDir, 'INDEX.txt'),
      samples.map((s, i) => `${index[i]}\n          ${s.source} — ${s.variant}`).join('\n') + '\n');
    console.log(`\nWrote ${samples.length} files to ${outDir} (plus INDEX.txt)`);
  }

  if (to) {
    // Guarded deliberately: --send is a real send to a real inbox, and on devel that is a Mailgun
    // SANDBOX domain which 403s any address that is not an *authorised recipient*. Add the tester
    // there first, or every one of these fails.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error(`--send needs an email address, got "${to}"`);
    // Presence only — the transport name is not a secret, the credentials behind it are, and
    // nothing here reads or prints them.
    if (!emailEnabled) {
      console.error('No mail transport is configured (need MAILGUN_API_KEY+MAILGUN_DOMAIN, or SMTP_HOST/SMTP_USER/SMTP_PASS). Nothing sent.');
      process.exit(1);
    }
    console.log(`\nSENDING ${samples.length} messages to ${to} via ${emailProvider} …\n`);
    let sent = 0, failed = 0;
    for (const s of samples) {
      try {
        // `always: true` — this is a deliberate one-off to a consenting tester, and it keeps the
        // sampler from needing a database for the suppression lookup. The subject is prefixed so a
        // sample can never be mistaken for a real message in the tester's inbox.
        const r = await sendMail({
          to, subject: `[SAMPLE ${s.id}] ${s.subject}`, html: s.html, text: s.text,
          replyTo: 'support@snapdini.com', always: true,
        });
        sent++;
        console.log(`  ✓ ${s.id.padEnd(32)} ${r.provider} ${r.messageId ?? ''}`);
      } catch (e) {
        failed++;
        console.error(`  ✗ ${s.id.padEnd(32)} ${(e as Error).message}`);
      }
      // Gentle on the provider's rate limit; a sandbox domain is not a warm sending IP.
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log(`\nSent ${sent}, failed ${failed}.`);
    if (failed) problems += failed;
  }

  if (problems) { console.error(`\n${problems} problem(s).`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

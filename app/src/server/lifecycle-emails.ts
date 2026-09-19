// Customer lifecycle emails — welcome (on payment), check-in (~5 days before), and the
// post-event feedback survey (3 days after). Warm, support-led, Snapdini-branded. Icons are
// emoji — they render everywhere with zero hosting.
//
// The shell, the palette and every link and button come from email-theme.ts, which is also where
// the reasoning lives for why an email is built the way it is (tables, bgcolor attributes, an
// inline colour on every anchor, no load-bearing <style>). This file had its own copy of all of
// that, as did guest-emails.ts and email.ts — three shells, of which only two were table-based and
// none of the three agreed on the palette.
//
// Each builder returns { subject, preheader, html, text } and is pure: the caller (sweep or test
// script) resolves the view model. Replies are routed to support@ by the caller via sendMail's
// replyTo.
//
// The `text` part is the plain-text alternative. It is written from the same view model as the
// HTML, NOT by stripping tags off it, and it carries RAW strings — an escaped name in a text part
// reaches the inbox as "Priya &amp; Tom". See the note on Mail.text in email.ts.
import {
  C, button, emailShell, esc, footerLine, heading, link, para,
  textEmail, textLink,
} from './email-theme';

/** What every builder in this file returns. `text` is the plain-text alternative part. */
export interface LifecycleMessage {
  subject: string;
  preheader: string;
  html: string;
  /** Plain text, built from the view model and carrying RAW strings (never escaped ones). */
  text: string;
}

export interface LifecycleView {
  ownerName: string;                 // first name, or ''
  eventName: string;
  guestCap: number;
  shotsPerGuest: number;
  framesAll: boolean;
  hasVideo: boolean;
  videoSeconds: number;
  revealMode: 'instant' | 'manual' | 'at_end';
  retentionDays: number;
  datesLabel: string;                // e.g. "Sat 24 – Mon 26 Oct 2026"
  manageUrl: string;
  surveyUrl?: string;
  unsubUrl?: string;
  startsSoon?: boolean;              // event begins within a few days of booking → fold the
                                     // pre-flight into the welcome and skip the standalone check-in
  /** Optional post-event thank-you discount for the host's NEXT event. */
  hostReward?: { code: string; percentOff: number; expiresAt: number };
  /** Where to make a slideshow, and how long the photos it needs will still be there. Set only when
   *  the event still HAS photos — an empty or already-purged event must never be sent to a feature
   *  that cannot work, which would read as spam rather than a tip. */
  slideshow?: { url: string; photoCount: number; photosUntil: number };
}

// The 3-point pre-flight, shared by the check-in and the short-notice welcome.
const PREFLIGHT: Array<[string, string, string, string?]> = [
  ['🖨️', 'Print or display your QR', 'on tables / signage'],
  ['📣', 'Give guests a heads-up', '"scan to snap"'],
  ['✅', 'Check your QR opens the event', 'just confirm it loads — no snap needed'],
];

const revealLabel = (m: LifecycleView['revealMode']) =>
  m === 'manual' ? 'Manual — photos stay hidden until you unveil them'
  : m === 'at_end' ? 'At the end — revealed once the event wraps'
  : 'Instant — photos appear as guests take them';

// The shell is emailShell() in email-theme.ts. Only the footer differs between the host lifecycle
// mail and the guest mail, so only the footer is built here.
//
// `unsubUrl` is a REAL preference-centre link or it is absent. It used to default to a
// mailto:support@ that no inbound automation has ever read: a link labelled Unsubscribe that does
// nothing is worse than no link, because it is the recipient's one attempt at s18 and it fails
// silently. The optional emails (activation nudge, survey) pass prefsUrlFor(); the service messages
// pass nothing and render no link, which is what a designated commercial message is entitled to do.
function shell(preheader: string, inner: string, unsubUrl?: string): string {
  const unsub = unsubUrl ? ` &middot; ${link(unsubUrl, 'Unsubscribe', 'quiet')}` : '';
  return emailShell({ preheader, inner, footer: footerLine(unsub) });
}

/** The text part's own footer tail — the same unsubscribe, as a URL somebody can paste. */
const textUnsub = (unsubUrl?: string): string[] =>
  unsubUrl ? [`Unsubscribe or change what we send you: ${unsubUrl}`] : [];

const h2 = (t: string) => heading(t, 'h1');
const p = (t: string, hi = false) => para(t, hi);
const btn = (label: string, href: string, ghost = false) => button(label, href, ghost);

// summary card: rows of [emoji] label ......... value
function rollCard(rows: Array<[string, string, string, string?]>): string {
  const tr = rows.map(([emoji, k, v, sub], i) => `
    <tr>
      <td style="width:34px;padding:${i ? '11px' : '2px'} 0 11px;vertical-align:top;font-size:18px">${emoji}</td>
      <td style="padding:${i ? '11px' : '2px'} 0 11px;font-size:14px;color:${C.muted};vertical-align:top">${k}</td>
      <td style="padding:${i ? '11px' : '2px'} 0 11px;font-size:14px;color:${C.head};font-weight:700;text-align:right;vertical-align:top">${v}${sub ? `<br><span style="color:${C.subtle};font-weight:400;font-size:12px">${sub}</span>` : ''}</td>
    </tr>${i < rows.length - 1 ? `<tr><td colspan="3" style="border-bottom:1px solid ${C.line};font-size:0;line-height:0">&nbsp;</td></tr>` : ''}`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};border:1px solid ${C.border};border-radius:12px;padding:6px 18px;margin:20px 0">${tr}</table>`;
}

function sign(lead: string): string {
  return `<div style="margin-top:26px;font-size:15px;line-height:1.6;color:${C.ink}">
    <p style="margin:0">${lead}</p>
    <p style="margin:12px 0 0">Warmly,<br><b style="color:${C.head}">The Snapdini team</b><br>
    <a href="mailto:support@snapdini.com" style="color:${C.link};text-decoration:none">support@snapdini.com</a></p>
  </div>`;
}

const hi = (name: string) => name ? `Hi ${esc(name)},` : 'Hi there,';
/** The same greeting for the text part. RAW — an escaped name in a text part reaches the inbox as
 *  "Hi Priya &amp; Tom,". */
const hiText = (name: string) => name ? `Hi ${name},` : 'Hi there,';
/** The sign-off the HTML `sign()` renders, as text. */
const signText = (lead: string) => `${lead}\n\nWarmly,\nThe Snapdini team\nsupport@snapdini.com`;
/** The pre-flight card as three text lines. */
const preflightText = () => PREFLIGHT.map(([, k, v]) => `- ${k} (${v})`).join('\n');

// ── 1. WELCOME (on payment) ──────────────────────────────────────────────────
// No emoji in any subject line, host or guest. It nudges Gmail toward the Promotions tab, and the
// brand mark is already in the email body — the 🎩 chip at the top of every message — so the
// subject was paying a deliverability cost to repeat something the reader sees on opening.
export function welcomeEmail(v: LifecycleView): LifecycleMessage {
  const subject = `Your roll is loaded${v.ownerName ? `, ${v.ownerName}` : ''}`;
  const preheader = `${v.eventName} is all set for ${v.datesLabel}. Here's what's on your roll.`;

  const rows: Array<[string, string, string, string?]> = [
    ['🎞️', 'Event', esc(v.eventName), esc(v.datesLabel)],
    ['👥', 'Guests', `Up to ${v.guestCap}`],
    ['📸', 'Shots per guest', String(v.shotsPerGuest)],
    ['🖼️', 'Frame sizes', v.framesAll ? 'All unlocked' : 'Square (1:1)'],
    ['🎬', 'Video', v.hasVideo ? `On — up to ${v.videoSeconds}s clips` : 'Off'],
    ['✨', 'The reveal', revealLabel(v.revealMode)],
  ];

  // There was a priced upsell here — "Add video clips from A$2", "Keep the photos longer from A$3" —
  // and it has been removed rather than rewritten.
  //
  // This message is sent to a host the moment they pay, so it is a commercial electronic message
  // either way. What decided which KIND was those two offers. Without them the mail is no more than
  // factual information about the thing they just bought, plus our name, logo and contact details,
  // which Spam Act 2003 (Cth) Sch 1 cl 3(1)(a)–(2) expressly permits: a DESIGNATED commercial
  // electronic message, exempt from s16 consent and s18 unsubscribe. With them it was an ordinary
  // commercial message needing a functional unsubscribe facility — and the only one it offered was
  // a mailto nothing in this codebase reads, which is not a facility at all.
  //
  // The fix is not to wire a real unsubscribe to this message: that would let a host who has just
  // paid switch off the confirmation for the event they are in the middle of setting up. The fix is
  // for the message to stay factual. Sell the upgrades on the event page, where they belong.

  // Short-notice bookings: fold the pre-flight into the welcome (no separate check-in will follow),
  // and lead with urgency instead of a leisurely "waiting for the day".
  const preflight = v.startsSoon
    ? [
        p(`Your event is coming up <b>very soon</b>, so here's a 20-second pre-flight to make sure you're ready:`, true),
        rollCard(PREFLIGHT),
      ].join('')
    : '';

  const opener = v.startsSoon
    ? p(`Thanks for setting up <b style="color:${C.head}">${esc(v.eventName)}</b> — you're all set for ${esc(v.datesLabel)}.`, true)
    : p(`Thanks for setting up <b style="color:${C.head}">${esc(v.eventName)}</b> — everything's ready and waiting for ${esc(v.datesLabel)}.`, true);

  const inner = [
    h2(`Your roll is loaded${v.ownerName ? `, ${esc(v.ownerName)}` : ''} 🎞️`),
    opener,
    p('Here\'s what\'s on your roll:'),
    rollCard(rows),
    p('Ready when you are: open your event to grab the <b>QR code and join link</b> to share with guests.'),
    btn('Open your event', v.manageUrl),
    preflight,
    sign('Any questions at all, just hit reply — a real person reads every message.'),
  ].join('');

  // The same message, from the same view model. RAW names — the roll rows above are escaped
  // because they are going into markup; these are not.
  const text = textEmail([
    `Your roll is loaded${v.ownerName ? `, ${v.ownerName}` : ''}`,
    v.startsSoon
      ? `Thanks for setting up ${v.eventName} — you're all set for ${v.datesLabel}.`
      : `Thanks for setting up ${v.eventName} — everything's ready and waiting for ${v.datesLabel}.`,
    'Here\'s what\'s on your roll:',
    [`- Event: ${v.eventName} (${v.datesLabel})`,
     `- Guests: up to ${v.guestCap}`,
     `- Shots per guest: ${v.shotsPerGuest}`,
     `- Frame sizes: ${v.framesAll ? 'all unlocked' : 'square (1:1)'}`,
     `- Video: ${v.hasVideo ? `on — up to ${v.videoSeconds}s clips` : 'off'}`,
     `- The reveal: ${revealLabel(v.revealMode)}`].join('\n'),
    'Ready when you are: open your event to grab the QR code and join link to share with guests.',
    textLink('Open your event', v.manageUrl),
    v.startsSoon && 'Your event is coming up very soon, so here\'s a 20-second pre-flight to make sure you\'re ready:',
    v.startsSoon && preflightText(),
    signText('Any questions at all, just hit reply — a real person reads every message.'),
  ], textUnsub(v.unsubUrl));

  return { subject, preheader, html: shell(preheader, inner, v.unsubUrl), text };
}


// ── 2. CHECK-IN (~5 days before) ─────────────────────────────────────────────
export function checkinEmail(v: LifecycleView): LifecycleMessage {
  const subject = `Nearly there — anything you need?`;
  const preheader = `${v.eventName} is almost here. A quick check-in before the day.`;

  const inner = [
    h2('Nearly there — anything you need?'),
    p(hi(v.ownerName), true),
    p(`<b style="color:${C.head}">${esc(v.eventName)}</b> is coming up on ${esc(v.datesLabel)}. We wanted to check in before the day and make sure you're all set.`),
    p('A quick pre-flight, if it helps:'),
    rollCard(PREFLIGHT),
    p('Most of all — if you\'re <b>unsure about anything</b>, want a feature explained, or something doesn\'t look right, just reply. We\'d genuinely rather hear from you now than have you wonder on the day.'),
    btn('Ask us anything', `mailto:support@snapdini.com?subject=${encodeURIComponent('About ' + v.eventName)}`, true),
    sign('Wishing you a wonderful event.'),
  ].join('');

  const text = textEmail([
    'Nearly there — anything you need?',
    hiText(v.ownerName),
    `${v.eventName} is coming up on ${v.datesLabel}. We wanted to check in before the day and make sure you're all set.`,
    'A quick pre-flight, if it helps:',
    preflightText(),
    'Most of all — if you\'re unsure about anything, want a feature explained, or something doesn\'t look right, just reply. We\'d genuinely rather hear from you now than have you wonder on the day.',
    textLink('Ask us anything', 'mailto:support@snapdini.com'),
    signText('Wishing you a wonderful event.'),
  ], textUnsub(v.unsubUrl));

  return { subject, preheader, html: shell(preheader, inner, v.unsubUrl), text };
}

// ── 0a. ACCOUNT WELCOME (on sign-up) ─────────────────────────────────────────
export function accountWelcomeEmail(v: { ownerName: string; createUrl: string; unsubUrl?: string }): LifecycleMessage {
  const subject = `Welcome to Snapdini`;
  const preheader = `Your disposable camera for events — set up your first event in a couple of minutes.`;
  const inner = [
    h2(`Welcome to Snapdini${v.ownerName ? `, ${esc(v.ownerName)}` : ''} 🎩`),
    p(`Thanks for joining! Snapdini is the <b>disposable camera for your events</b> — your guests scan a QR code, snap away on their phones, and every photo lands in one shared gallery. No app to install.`, true),
    p(`Whenever you're ready, setting up an event takes a couple of minutes — name it, pick the date, and share the code.`),
    btn('Create your first event', v.createUrl),
    sign('Questions before you start? Just reply — a real person reads every message.'),
  ].join('');
  const text = textEmail([
    `Welcome to Snapdini${v.ownerName ? `, ${v.ownerName}` : ''}`,
    'Thanks for joining! Snapdini is the disposable camera for your events — your guests scan a QR code, snap away on their phones, and every photo lands in one shared gallery. No app to install.',
    'Whenever you\'re ready, setting up an event takes a couple of minutes — name it, pick the date, and share the code.',
    textLink('Create your first event', v.createUrl),
    signText('Questions before you start? Just reply — a real person reads every message.'),
  ], textUnsub(v.unsubUrl));
  return { subject, preheader, html: shell(preheader, inner, v.unsubUrl), text };
}

// ── 0b. ACTIVATION NUDGE (~1 week later, only if no event yet) ────────────────
export function activationNudgeEmail(v: { ownerName: string; createUrl: string; unsubUrl?: string }): LifecycleMessage {
  const subject = `Ready to set up your first event?`;
  const preheader = `Whenever the moment's right — your first Snapdini event is a couple of minutes away.`;
  const inner = [
    h2('Your first event is a couple of minutes away'),
    p(hi(v.ownerName), true),
    p(`Just checking in — you signed up for Snapdini but haven't created an event yet. Whenever you've got one coming up — a wedding, a birthday, a work do — it's a great way to capture the candid moments your guests actually take.`),
    p(`Free for events up to 10 guests, with everything included. It only takes a couple of minutes to set up.`),
    btn('Create your event', v.createUrl),
    sign(`Not sure if it's right for your event? Reply and tell us about it — happy to help.`),
  ].join('');
  const text = textEmail([
    'Your first event is a couple of minutes away',
    hiText(v.ownerName),
    'Just checking in — you signed up for Snapdini but haven\'t created an event yet. Whenever you\'ve got one coming up — a wedding, a birthday, a work do — it\'s a great way to capture the candid moments your guests actually take.',
    'Free for events up to 10 guests, with everything included. It only takes a couple of minutes to set up.',
    textLink('Create your event', v.createUrl),
    signText('Not sure if it\'s right for your event? Reply and tell us about it — happy to help.'),
  ], textUnsub(v.unsubUrl));
  return { subject, preheader, html: shell(preheader, inner, v.unsubUrl), text };
}

// Retention is the host's choice, not a constant: about half of real events keep their photos a
// week and about half keep them a month. Reading the survey with 27 days left, "so make it before
// then" is invented urgency and the host learns to discount what we tell them — so the nudge is
// only added when the deadline is actually near. The date itself is always stated, because it is
// useful either way.
function slideshowDeadline(photosUntil: number, now = Date.now()): string {
  const on = new Date(photosUntil).toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
  const daysLeft = Math.ceil((photosUntil - now) / 86_400_000);
  if (daysLeft <= 10) return `The photos are here until ${on} — worth doing before they go.`;
  return `Your photos are here until ${on}, so there's no rush.`;
}

// ── 3. POST-EVENT SURVEY (3 days after) ──────────────────────────────────────
export function surveyEmail(v: LifecycleView): LifecycleMessage {
  // Thank-you discount for their NEXT event. Rendered only when one was minted (paid, unrefunded).
  const rewardBlock = v.hostReward
    ? `<div style="padding:18px 0 0">
         <div style="border:1px dashed #6b5c2e;border-radius:12px;padding:16px;background:#14110b;text-align:center">
           <div style="font-size:13px;color:#b8ab8d;margin-bottom:6px">A thank-you for hosting</div>
           <div style="font-size:22px;font-weight:700;letter-spacing:2px;color:#f0b429">${esc(v.hostReward.code)}</div>
           <div style="font-size:13px;color:#e8e0cf;margin-top:6px">
             ${v.hostReward.percentOff}% off your next event — use it by
             ${new Date(v.hostReward.expiresAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}
           </div>
         </div>
       </div>`
    : '';
  // A slideshow is the thing most hosts don't know we do, and this is the moment it makes sense:
  // the photos are in, they're looking back at the day, and the files are on a clock. Deliberately
  // placed AFTER the survey ask and the reward — it is a discovery, not a third thing to do — and
  // it leads with the deadline, because that is the part that is actually useful to them.
  const slideshowBlock = v.slideshow
    ? `<div style="padding:22px 0 0">
         <div style="border-top:1px solid ${C.line};padding-top:20px">
           <div style="font-size:13px;color:${C.subtle};text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">One more thing</div>
           <p style="margin:0 0 6px;font-size:15px;line-height:1.6;color:${C.ink}">
             Did you know Snapdini can turn the photos from ${esc(v.eventName)} into a
             <b style="color:${C.head}">slideshow</b>? All ${v.slideshow.photoCount} of them, set to music,
             as one video you can keep and send on.
           </p>
           <p style="margin:0;font-size:13px;line-height:1.6;color:${C.subtle}">
             ${slideshowDeadline(v.slideshow.photosUntil)}
           </p>
           ${btn('Make the slideshow', v.slideshow.url, true)}
         </div>
       </div>`
    : '';
  const subject = `How did ${v.eventName} go? (2 mins)`;
  const preheader = `Two minutes to tell us how Snapdini did — it shapes what we build next.`;
  const base = v.surveyUrl || v.manageUrl;
  const face = (emoji: string, label: string, score: number) =>
    // `color:` on the anchor, like every other anchor in this codebase now. These five were the
    // worst of the eighteen that had none: five side-by-side default-blue boxes, and the emoji
    // inside each one is its own child span, so the only thing the client's link colour had to
    // paint was the little uppercase label under it. It read as five broken buttons.
    `<td style="padding:0 3px" width="20%" bgcolor="${C.page}"><a href="${esc(base)}${base.includes('?') ? '&' : '?'}score=${score}" style="display:block;text-align:center;text-decoration:none;color:${C.ink};border:1px solid ${C.border};border-radius:10px;padding:12px 2px;background-color:${C.page}">
       <span style="font-size:24px;line-height:24px;display:block">${emoji}</span>
       <span style="font-size:10px;letter-spacing:0.5px;text-transform:uppercase;color:${C.subtle};display:block;margin-top:6px">${label}</span></a></td>`;

  const inner = [
    h2(`How did ${esc(v.eventName)} go?`),
    p(hi(v.ownerName), true),
    p('We hope the day was everything you wanted. Would you take <b>two minutes</b> to tell us how Snapdini did? It genuinely shapes what we build next.'),
    p('Start with your overall impression — tap a face:'),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 6px"><tr>
      ${face('😞', 'Poor', 1)}${face('😕', 'Meh', 2)}${face('😐', 'OK', 3)}${face('🙂', 'Good', 4)}${face('😍', 'Loved it', 5)}
    </tr></table>`,
    `<p style="font-size:13px;color:${C.subtle};margin:6px 0 0">Then a handful of quick questions — comments optional, skip any you like.</p>`,
    btn('Take the 2-minute survey', base),
    rewardBlock,
    slideshowBlock,
    sign('Thank you — truly.'),
  ].join('');

  // The five faces are five DIFFERENT destinations — each opens the survey with that score already
  // chosen — so the text part carries all five rather than collapsing them to the survey link. A
  // text reader gets the same one-tap rating the HTML reader gets. Labelled and one per line,
  // because five bare near-identical URLs is not a choice anybody can make.
  const scoreLine = (label: string, score: number) =>
    `  ${`${label}:`.padEnd(11)}${base}${base.includes('?') ? '&' : '?'}score=${score}`;
  const text = textEmail([
    `How did ${v.eventName} go?`,
    hiText(v.ownerName),
    'We hope the day was everything you wanted. Would you take two minutes to tell us how Snapdini did? It genuinely shapes what we build next.',
    ['Start with your overall impression — open the one that fits:',
     scoreLine('Poor', 1), scoreLine('Meh', 2), scoreLine('OK', 3),
     scoreLine('Good', 4), scoreLine('Loved it', 5)].join('\n'),
    'Then a handful of quick questions — comments optional, skip any you like.',
    textLink('Take the 2-minute survey', base),
    v.hostReward && `A thank-you for hosting: use code ${v.hostReward.code} for ${v.hostReward.percentOff}% off your next event, by `
      + `${new Date(v.hostReward.expiresAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}.`,
    v.slideshow && `One more thing — Snapdini can turn the photos from ${v.eventName} into a slideshow: all `
      + `${v.slideshow.photoCount} of them, set to music, as one video you can keep and send on. `
      + slideshowDeadline(v.slideshow.photosUntil),
    v.slideshow && textLink('Make the slideshow', v.slideshow.url),
    signText('Thank you — truly.'),
  ], textUnsub(v.unsubUrl));

  return { subject, preheader, html: shell(preheader, inner, v.unsubUrl), text };
}

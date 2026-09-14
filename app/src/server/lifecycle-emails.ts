// Customer lifecycle emails — welcome (on payment), check-in (~5 days before), and the
// post-event feedback survey (3 days after). Warm, support-led, Snapdini-branded. All HTML is
// inline-styled and table-based for broad email-client compatibility (Gmail/Outlook strip <style>
// blocks and external CSS). Icons are emoji — they render everywhere with zero hosting.
//
// Each builder returns { subject, html, preheader } and is pure: the caller (sweep or test script)
// resolves the view model. Replies are routed to support@ by the caller via sendMail's replyTo.

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

const C = {
  bg: '#0f0e0b', card: '#14110b', border: '#2b2519', line: '#221d13',
  accent: '#f0b429', ink: '#efe9dc', head: '#fdfaf2', muted: '#b0a894', subtle: '#8a816d',
};

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const revealLabel = (m: LifecycleView['revealMode']) =>
  m === 'manual' ? 'Manual — photos stay hidden until you unveil them'
  : m === 'at_end' ? 'At the end — revealed once the event wraps'
  : 'Instant — photos appear as guests take them';

// Outer shell: dark ground, centred 600px, brand chip, hidden preheader, footer.
// `unsubUrl` is a REAL preference-centre link or it is absent. It used to default to a
// mailto:support@ that no inbound automation has ever read: a link labelled Unsubscribe that does
// nothing is worse than no link, because it is the recipient's one attempt at s18 and it fails
// silently. The optional emails (activation nudge, survey) pass prefsUrlFor(); the service messages
// pass nothing and render no link, which is what a designated commercial message is entitled to do.
function shell(preheader: string, inner: string, unsubUrl?: string): string {
  const unsub = unsubUrl
    ? ` · <a href="${esc(unsubUrl)}" style="color:${C.subtle};text-decoration:underline">Unsubscribe</a>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body bgcolor="${C.bg}" style="margin:0;padding:0;background:${C.bg};color:${C.ink};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<span style="display:none!important;opacity:0;color:${C.bg};height:0;width:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.bg}" style="background:${C.bg}"><tr><td align="center" bgcolor="${C.bg}" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
  <tr><td style="padding:0 4px 22px">
    <span style="display:inline-block;background:${C.accent};color:#17140e;padding:8px 14px;border-radius:9px;font-weight:800;font-size:16px;letter-spacing:-0.2px">🎩 Snapdini</span>
  </td></tr>
  <tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:32px 30px">
    ${inner}
  </td></tr>
  <tr><td style="padding:20px 6px 0;color:${C.subtle};font-size:12px;line-height:1.6">
    Snapdini · <a href="mailto:support@snapdini.com" style="color:${C.subtle};text-decoration:underline">support@snapdini.com</a>${unsub}
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

const h2 = (t: string) => `<h1 style="margin:0 0 6px;color:${C.head};font-size:23px;line-height:1.2;font-weight:800;letter-spacing:-0.3px">${t}</h1>`;
const p  = (t: string, hi = false) => `<p style="margin:14px 0;font-size:15px;line-height:1.6;color:${hi ? C.head : C.ink}">${t}</p>`;
const btn = (label: string, href: string, ghost = false) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0"><tr><td style="border-radius:9px;${ghost ? `border:1px solid #4a4230` : `background:${C.accent}`}">
   <a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:800;text-decoration:none;color:${ghost ? C.accent : '#17140e'}">${label}</a>
   </td></tr></table>`;

// summary card: rows of [emoji] label ......... value
function rollCard(rows: Array<[string, string, string, string?]>): string {
  const tr = rows.map(([emoji, k, v, sub], i) => `
    <tr>
      <td style="width:34px;padding:${i ? '11px' : '2px'} 0 11px;vertical-align:top;font-size:18px">${emoji}</td>
      <td style="padding:${i ? '11px' : '2px'} 0 11px;font-size:14px;color:${C.muted};vertical-align:top">${k}</td>
      <td style="padding:${i ? '11px' : '2px'} 0 11px;font-size:14px;color:${C.head};font-weight:700;text-align:right;vertical-align:top">${v}${sub ? `<br><span style="color:${C.subtle};font-weight:400;font-size:12px">${sub}</span>` : ''}</td>
    </tr>${i < rows.length - 1 ? `<tr><td colspan="3" style="border-bottom:1px solid ${C.line};font-size:0;line-height:0">&nbsp;</td></tr>` : ''}`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};border:1px solid ${C.border};border-radius:12px;padding:6px 18px;margin:20px 0">${tr}</table>`;
}

function sign(lead: string): string {
  return `<div style="margin-top:26px;font-size:15px;line-height:1.6;color:${C.ink}">
    <p style="margin:0">${lead}</p>
    <p style="margin:12px 0 0">Warmly,<br><b style="color:${C.head}">The Snapdini team</b><br>
    <a href="mailto:support@snapdini.com" style="color:${C.accent};text-decoration:none">support@snapdini.com</a></p>
  </div>`;
}

const hi = (name: string) => name ? `Hi ${esc(name)},` : 'Hi there,';

// ── 1. WELCOME (on payment) ──────────────────────────────────────────────────
export function welcomeEmail(v: LifecycleView): { subject: string; preheader: string; html: string } {
  const subject = `Your roll is loaded${v.ownerName ? `, ${v.ownerName}` : ''} 🎞️`;
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

  return { subject, preheader, html: shell(preheader, inner, v.unsubUrl) };
}


// ── 2. CHECK-IN (~5 days before) ─────────────────────────────────────────────
export function checkinEmail(v: LifecycleView): { subject: string; preheader: string; html: string } {
  const subject = `Nearly there — anything you need? 🎩`;
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

  return { subject, preheader, html: shell(preheader, inner, v.unsubUrl) };
}

// ── 0a. ACCOUNT WELCOME (on sign-up) ─────────────────────────────────────────
export function accountWelcomeEmail(v: { ownerName: string; createUrl: string; unsubUrl?: string }): { subject: string; preheader: string; html: string } {
  const subject = `Welcome to Snapdini 🎩`;
  const preheader = `Your disposable camera for events — set up your first event in a couple of minutes.`;
  const inner = [
    h2(`Welcome to Snapdini${v.ownerName ? `, ${esc(v.ownerName)}` : ''} 🎩`),
    p(`Thanks for joining! Snapdini is the <b>disposable camera for your events</b> — your guests scan a QR code, snap away on their phones, and every photo lands in one shared gallery. No app to install.`, true),
    p(`Whenever you're ready, setting up an event takes a couple of minutes — name it, pick the date, and share the code.`),
    btn('Create your first event', v.createUrl),
    sign('Questions before you start? Just reply — a real person reads every message.'),
  ].join('');
  return { subject, preheader, html: shell(preheader, inner, v.unsubUrl) };
}

// ── 0b. ACTIVATION NUDGE (~1 week later, only if no event yet) ────────────────
export function activationNudgeEmail(v: { ownerName: string; createUrl: string; unsubUrl?: string }): { subject: string; preheader: string; html: string } {
  const subject = `Ready to set up your first event? 🎩`;
  const preheader = `Whenever the moment's right — your first Snapdini event is a couple of minutes away.`;
  const inner = [
    h2('Your first event is a couple of minutes away'),
    p(hi(v.ownerName), true),
    p(`Just checking in — you signed up for Snapdini but haven't created an event yet. Whenever you've got one coming up — a wedding, a birthday, a work do — it's a great way to capture the candid moments your guests actually take.`),
    p(`Free for events up to 10 guests, with everything included. It only takes a couple of minutes to set up.`),
    btn('Create your event', v.createUrl),
    sign(`Not sure if it's right for your event? Reply and tell us about it — happy to help.`),
  ].join('');
  return { subject, preheader, html: shell(preheader, inner, v.unsubUrl) };
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
export function surveyEmail(v: LifecycleView): { subject: string; preheader: string; html: string } {
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
  const subject = `How did ${v.eventName} go? (2 mins) 🎩`;
  const preheader = `Two minutes to tell us how Snapdini did — it shapes what we build next.`;
  const base = v.surveyUrl || v.manageUrl;
  const face = (emoji: string, label: string, score: number) =>
    `<td style="padding:0 3px" width="20%"><a href="${esc(base)}${base.includes('?') ? '&' : '?'}score=${score}" style="display:block;text-align:center;text-decoration:none;border:1px solid #3a3324;border-radius:10px;padding:12px 2px;background:${C.bg}">
       <span style="font-size:24px;line-height:1;display:block">${emoji}</span>
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

  return { subject, preheader, html: shell(preheader, inner, v.unsubUrl) };
}

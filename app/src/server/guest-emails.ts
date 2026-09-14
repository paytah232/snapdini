// The three messages a GUEST can receive. Nothing else in this codebase emails a guest, and what
// makes that possible is the rule these builders are written to.
//
// ── Why every word here is factual, and what breaks if one is not ────────────
//
// Under the Spam Act 2003 (Cth) Sch 1 cl 3(1)(a), a commercial electronic message consisting of
// "no more than factual information" — plus the sender's name, logo and contact details, which cl
// 3(2) expressly permits alongside it — is a DESIGNATED commercial electronic message. A designated
// message is exempt from s16 (consent) and s18 (a functional unsubscribe facility).
//
// That exemption is what lets us write to someone who joined a stranger's birthday party with
// nothing but a name and an address. It is not a per-message judgement call: ONE promotional
// sentence — "start your own event", a discount, a feature we would like them to try — turns the
// message into an ordinary commercial one, and then every guest at every event was sent it without
// consent and without an unsubscribe link. So:
//
//   · state the event, the host, the link, the date. Nothing else.
//   · no call to action that is not "see the photos you are already in".
//   · no pricing, no signup, no product tour, no referral code, no "powered by" pitch.
//   · our name, our logo and our contact address are allowed, and are all the branding there is.
//
// If you are adding a fourth message, that list is the specification. If you are adding a line to
// an existing one, it has to survive the same reading.
//
// Every builder is pure: the caller (guest-delivery.ts) resolves the view model, so the copy rules
// can be pinned by tests that never touch a database or a mail transport.

const C = {
  bg: '#0f0e0b', card: '#14110b', border: '#2b2519', line: '#221d13',
  accent: '#f0b429', ink: '#efe9dc', head: '#fdfaf2', muted: '#b0a894', subtle: '#8a816d',
};

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** What the three messages always carry. */
export interface GuestView {
  /** The guest's first name, or '' — never an address prefix, which reads as a leak. */
  guestName: string;
  eventName: string;
  /** Who invited them. '' when we do not know, in which case the event name stands alone rather
   *  than a guessed or empty "hosted by". */
  hostName: string;
  /** The gallery. A guest can see their OWN shots here whatever the event's reveal state, so this
   *  link is never a dead end (routes/photos.ts). */
  galleryUrl: string;
  /** The event's own timezone, for rendering a release moment on the clock the guest was standing
   *  under. Falls back to Brisbane, the same default the host lifecycle emails use. */
  timezone?: string | null;
  /** Our contact address. Permitted branding under cl 3(2), and the only reply path a guest has. */
  contactEmail?: string;
}

const SUPPORT = 'support@snapdini.com';

/** "Sat 24 Oct 2026, 7:15 pm" in the event's own zone. */
export function momentLabel(ms: number, timeZone?: string | null): string {
  const z = timeZone || 'Australia/Brisbane';
  try {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: z, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(ms)).replace(/ /g, ' ');
  } catch {
    // An unknown zone must not take the whole email down — the instant is still true in UTC.
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(ms)).replace(/ /g, ' ') + ' UTC';
  }
}

// Outer shell. Deliberately thinner than the host lifecycle shell: a brand chip, the body, and a
// footer that says who we are, which event this is about and how to reach us. No unsubscribe link,
// because a designated commercial message has no s18 obligation and offering one that does not lead
// to a preference centre would be worse than not offering it — and no marketing footer, because
// that is the line this whole file is built around.
function shell(preheader: string, inner: string, v: GuestView): string {
  const contact = v.contactEmail || SUPPORT;
  const because = v.hostName
    ? `You are receiving this because you joined ${esc(v.eventName)}, hosted by ${esc(v.hostName)}, and asked for the photos.`
    : `You are receiving this because you joined ${esc(v.eventName)} and asked for the photos.`;
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
    ${because}<br>
    Snapdini · <a href="mailto:${esc(contact)}" style="color:${C.subtle};text-decoration:underline">${esc(contact)}</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

const h2 = (t: string) => `<h1 style="margin:0 0 6px;color:${C.head};font-size:23px;line-height:1.2;font-weight:800;letter-spacing:-0.3px">${t}</h1>`;
const p = (t: string, hi = false) => `<p style="margin:14px 0;font-size:15px;line-height:1.6;color:${hi ? C.head : C.ink}">${t}</p>`;
const btn = (label: string, href: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr><td style="border-radius:9px;background:${C.accent}">
   <a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:800;text-decoration:none;color:#17140e">${label}</a>
   </td></tr></table>`;

const hi = (name: string) => (name ? `Hi ${esc(name)},` : 'Hi there,');

const hostedBy = (v: GuestView) =>
  v.hostName ? `${esc(v.eventName)}, hosted by ${esc(v.hostName)}` : esc(v.eventName);

// ── 1. The event-end message ─────────────────────────────────────────────────

export interface EventEndView extends GuestView {
  /** The host's "thanks for coming" toggle. It does NOT decide whether this message exists — the
   *  guest asking for their photos decided that. It decides whether the message is also a
   *  thank-you carrying the release date, or only their photos. */
  thanks: boolean;
  /** When the whole gallery opens. Rendered ONLY when it is known AND still ahead; a release that
   *  has already happened, or one only the host can trigger, is left unsaid rather than described
   *  vaguely. */
  releaseAt?: number | null;
  /** How many of their own shots they can already see. 0 is a real answer — they get the gallery
   *  without a count rather than being told "you took 0 photos". */
  ownPhotoCount: number;
}

/**
 * ONE message at the end of an event, whatever the combination.
 *
 * There is exactly one builder and exactly one send, so a guest who opted in AND whose host turned
 * thank-yous on cannot receive two emails: not because a guard catches the second, but because the
 * second does not exist. The four cases collapse to two:
 *
 *   thanks on  + opted in → thanks, the release date if there is one, and their photos
 *   thanks off + opted in → their photos
 *   (not opted in         → nothing is built and nothing is sent — see guest-delivery.ts)
 */
export function eventEndEmail(v: EventEndView): { subject: string; preheader: string; html: string } {
  const releaseAhead = typeof v.releaseAt === 'number' && v.releaseAt > Date.now() ? v.releaseAt : null;
  const shots = v.ownPhotoCount === 1 ? '1 photo' : `${v.ownPhotoCount} photos`;

  const subject = v.thanks
    ? `Thanks for coming to ${v.eventName}`
    : `Your photos from ${v.eventName}`;
  const preheader = v.thanks && releaseAhead
    ? `Your own photos are ready now. All the photos from ${v.eventName} open on ${momentLabel(releaseAhead, v.timezone)}.`
    : `Your photos from ${v.eventName}.`;

  const inner = [
    h2(v.thanks ? `Thanks for coming to ${esc(v.eventName)}` : `Your photos from ${esc(v.eventName)}`),
    p(hi(v.guestName), true),
    v.thanks
      ? p(`${hostedBy(v)} has finished. You asked us to send you the photos, so here they are.`)
      : p(`You asked us to send you your photos from ${hostedBy(v)}.`),
    v.ownPhotoCount > 0
      ? p(`You took <b>${shots}</b>. You can see them now.`)
      : p(`Your photos are on this page.`),
    btn('View your photos', v.galleryUrl),
    // Only when there is a release moment, only when it has not passed, and only when the host
    // asked for the thank-you framing this line belongs to.
    v.thanks && releaseAhead
      ? p(`Everyone's photos from the event become visible on <b>${esc(momentLabel(releaseAhead, v.timezone))}</b>.`)
      : '',
  ].join('');

  return { subject, preheader, html: shell(preheader, inner, v) };
}

// ── 2. The day before ────────────────────────────────────────────────────────

export interface ReleaseReminderView extends GuestView {
  /** Known and in the future — guest-delivery.ts never builds this message otherwise. */
  releaseAt: number;
}

export function releaseReminderEmail(v: ReleaseReminderView): { subject: string; preheader: string; html: string } {
  const when = momentLabel(v.releaseAt, v.timezone);
  const subject = `Photos from ${v.eventName} open tomorrow`;
  const preheader = `The photos from ${v.eventName} become visible on ${when}.`;
  const inner = [
    h2(`Photos from ${esc(v.eventName)} open tomorrow`),
    p(hi(v.guestName), true),
    p(`The photos from ${hostedBy(v)} become visible on <b>${esc(when)}</b>.`),
    p(`Your own photos are on the same page now.`),
    btn('View your photos', v.galleryUrl),
  ].join('');
  return { subject, preheader, html: shell(preheader, inner, v) };
}

// ── 3. The photos are live ───────────────────────────────────────────────────

export interface PhotosLiveView extends GuestView {
  /** Which set the link opens onto. Named plainly, because "favourites" is a smaller gallery than
   *  the guest may be expecting and being surprised by that reads as photos gone missing. */
  scope: 'all' | 'favourites';
  /** How many photos the link actually shows. Never 0 — a link onto an empty page is not sent at
   *  all (guest-delivery.ts refuses and tells the host instead). */
  photoCount: number;
}

export function photosLiveEmail(v: PhotosLiveView): { subject: string; preheader: string; html: string } {
  const n = v.photoCount === 1 ? '1 photo' : `${v.photoCount} photos`;
  const subject = `Photos from ${v.eventName} are ready`;
  const preheader = `${n} from ${v.eventName}.`;
  const inner = [
    h2(`Photos from ${esc(v.eventName)} are ready`),
    p(hi(v.guestName), true),
    v.scope === 'favourites'
      ? p(`${hostedBy(v)} has picked out <b>${n}</b> to share.`)
      : p(`All <b>${n}</b> from ${hostedBy(v)} are now visible.`),
    btn(v.scope === 'favourites' ? 'View the photos' : 'View the gallery', v.galleryUrl),
  ].join('');
  return { subject, preheader, html: shell(preheader, inner, v) };
}

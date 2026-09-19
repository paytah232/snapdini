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

// The shell, the palette and every link and button come from email-theme.ts — see that file's
// header for WHY an email is built the way it is (tables, bgcolor attributes, an inline colour on
// every anchor, nothing load-bearing in a <style> block). This file used to carry its own copy of
// all of it.
import { C, button, emailShell, esc, footerLine, heading, link, para, textEmail, textLink } from './email-theme';

/** What every builder in this file returns.
 *
 *  `text` is the plain-text alternative part: written from the same view model as the HTML, never
 *  by stripping its tags, and carrying RAW strings — an escaped name in a text part reaches the
 *  inbox as "Priya &amp; Tom". */
export interface GuestMessage {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

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
  return emailShell({
    preheader,
    inner,
    footer: `${becauseLine(v, esc)}<br>Snapdini &middot; ${link(`mailto:${contact}`, esc(contact), 'quiet')}`,
  });
}

/** Why this person is being written to. The one line in a guest email that is not about the event,
 *  and the reason a designated commercial message can be sent to a stranger at all. `e` lets the
 *  text part reuse the sentence with no escaping. */
const becauseLine = (v: GuestView, e: (s: unknown) => string) => v.hostName
  ? `You are receiving this because you joined ${e(v.eventName)}, hosted by ${e(v.hostName)}, and asked for the photos.`
  : `You are receiving this because you joined ${e(v.eventName)} and asked for the photos.`;

const raw = (s: unknown) => String(s);

/** The text part of a guest message: the body, then the same two footer lines the HTML carries. */
const guestText = (v: GuestView, blocks: Array<string | false | null | undefined>) =>
  textEmail(blocks, [becauseLine(v, raw)]);

const h2 = (t: string) => heading(t, 'h1');
const p = (t: string, hi = false) => para(t, hi);
const btn = (label: string, href: string) => button(label, href);

const hi = (name: string) => (name ? `Hi ${esc(name)},` : 'Hi there,');
/** The same, RAW, for the text part. */
const hiText = (name: string) => (name ? `Hi ${name},` : 'Hi there,');

const hostedBy = (v: GuestView) =>
  v.hostName ? `${esc(v.eventName)}, hosted by ${esc(v.hostName)}` : esc(v.eventName);
const hostedByText = (v: GuestView) =>
  v.hostName ? `${v.eventName}, hosted by ${v.hostName}` : v.eventName;

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
export function eventEndEmail(v: EventEndView): GuestMessage {
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

  const text = guestText(v, [
    v.thanks ? `Thanks for coming to ${v.eventName}` : `Your photos from ${v.eventName}`,
    hiText(v.guestName),
    v.thanks
      ? `${hostedByText(v)} has finished. You asked us to send you the photos, so here they are.`
      : `You asked us to send you your photos from ${hostedByText(v)}.`,
    v.ownPhotoCount > 0 ? `You took ${shots}. You can see them now.` : 'Your photos are on this page.',
    textLink('View your photos', v.galleryUrl),
    v.thanks && releaseAhead
      ? `Everyone's photos from the event become visible on ${momentLabel(releaseAhead, v.timezone)}.`
      : '',
  ]);

  return { subject, preheader, html: shell(preheader, inner, v), text };
}

// ── 2. The day before ────────────────────────────────────────────────────────

export interface ReleaseReminderView extends GuestView {
  /** Known and in the future — guest-delivery.ts never builds this message otherwise. */
  releaseAt: number;
}

export function releaseReminderEmail(v: ReleaseReminderView): GuestMessage {
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
  const text = guestText(v, [
    `Photos from ${v.eventName} open tomorrow`,
    hiText(v.guestName),
    `The photos from ${hostedByText(v)} become visible on ${when}.`,
    'Your own photos are on the same page now.',
    textLink('View your photos', v.galleryUrl),
  ]);
  return { subject, preheader, html: shell(preheader, inner, v), text };
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

export function photosLiveEmail(v: PhotosLiveView): GuestMessage {
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
  const text = guestText(v, [
    `Photos from ${v.eventName} are ready`,
    hiText(v.guestName),
    v.scope === 'favourites'
      ? `${hostedByText(v)} has picked out ${n} to share.`
      : `All ${n} from ${hostedByText(v)} are now visible.`,
    textLink(v.scope === 'favourites' ? 'View the photos' : 'View the gallery', v.galleryUrl),
  ]);
  return { subject, preheader, html: shell(preheader, inner, v), text };
}

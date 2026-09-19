// The four customer-facing messages that used to be composed inline at their call sites.
//
// ── Why they moved ───────────────────────────────────────────────────────────
//
// The gallery/share link (routes/events.ts), the co-host invitation (routes/events.ts), the
// empty-scope notice (guest-delivery.ts) and the guest invite (routes/guests.ts) were each a
// template literal in the middle of a route handler — and each was ALSO reproduced, verbatim, in app/scripts/email-sampler.ts, because the
// sampler has to render one of every email and could not call a template that did not exist.
//
// Two copies of the same markup is a trap that has already been walked into on this project: the
// raw-vs-escaped event-name bug was found and fixed in one copy and not the other, twice. And it
// became a blocking problem the moment these messages needed a plain-text part as well, because
// there is nowhere in a route handler for the text version of a sentence to live without being
// written out twice.
//
// So each one is a builder now, returning everything a send needs: `{ subject, preheader, html,
// text }`. The route decides WHO to mail and records what happened; the copy lives here. The
// sampler imports these, so there is exactly one definition of each message.
//
// ── The escaping rule, which is the thing that keeps going wrong ─────────────
//
// Every builder here takes RAW strings and does its own escaping, because the same value is needed
// in three different encodings and only one of them is HTML:
//
//   subject:  RAW.     A Subject: header is not HTML; the transport encodes it. An escaped name
//                      arrives in the inbox as "Priya &amp; Tom".
//   html:     ESCAPED. htmlEmail interpolates its title straight into an <h2>, and the body is
//                      markup.
//   text:     RAW.     Same reason as the subject, and the same bug if it is got wrong.
//
// A caller that passes in a pre-escaped name breaks two of the three. Pass the row's value.
import { htmlEmail } from './email';
import { button, esc, link, para, fine, textEmail, textLink } from './email-theme';

/** What every builder here returns. */
export interface BuiltEmail {
  /** Inbox line. Raw text — never escaped. */
  subject: string;
  /** The preview line beside the subject. Raw text; the shell escapes and hides it. */
  preheader: string;
  html: string;
  /** The plain-text alternative part. Raw text, links as full URLs on their own line. */
  text: string;
}

// ── 1. The emailed gallery / share link ──────────────────────────────────────

export interface GalleryLinkView {
  /** The event's name, RAW, straight off the row. */
  eventName: string;
  /** The host's own label for a curated share, RAW, or null for the whole gallery. */
  shareLabel: string | null;
  /** Whether this is a curated share at all. A share with no label is still a share. */
  isShare: boolean;
  /** Where the photos are. */
  linkUrl: string;
  /** The join page and code — included ONLY for the whole gallery. A curated share is a selection
   *  someone chose to send, and handing out the join code invites the recipient into the event
   *  itself, which is the opposite of the point of a narrowed link. */
  joinUrl?: string;
  joinCode?: string;
}

export function galleryLinkEmail(v: GalleryLinkView): BuiltEmail {
  const label = v.isShare ? (v.shareLabel || 'Photos') : null;
  // No emoji, for the same reason the invite dropped it: a Promotions-tab nudge on the one
  // message a guest most needs to actually find. See docs/DEVELOPMENT.md.
  const subject = label ? `${label} from ${v.eventName}` : `Gallery from ${v.eventName}`;
  const title = label ? `${esc(label)} from ${esc(v.eventName)}` : `Gallery from ${esc(v.eventName)}`;
  const preheader = label
    ? `${label} from ${v.eventName} are ready to view.`
    : `The gallery from ${v.eventName} is ready to view.`;

  const body = v.isShare
    ? [
        para(`${v.shareLabel ? `<strong>${esc(v.shareLabel)}</strong> from ` : 'Photos from '}${esc(v.eventName)} are ready to view.`),
        button('View photos &rarr;', v.linkUrl),
      ].join('')
    : [
        para('The event gallery is ready to view.'),
        button('View Gallery &rarr;', v.linkUrl),
        v.joinUrl && v.joinCode
          ? para(`Or share the event and join code <strong>${esc(v.joinCode)}</strong> at:<br>${link(v.joinUrl, esc(v.joinUrl))}`)
          : '',
      ].join('');

  const text = v.isShare
    ? textEmail([
        `${v.shareLabel ? `${v.shareLabel} from ` : 'Photos from '}${v.eventName} are ready to view.`,
        textLink('View photos', v.linkUrl),
      ])
    : textEmail([
        `The gallery from ${v.eventName} is ready to view.`,
        textLink('View the gallery', v.linkUrl),
        v.joinUrl && v.joinCode
          ? `Or share the event and the join code ${v.joinCode}:\n${v.joinUrl}`
          : '',
      ]);

  return { subject, preheader, html: htmlEmail(title, body, { preheader }), text };
}

// ── 2. The co-host invitation ────────────────────────────────────────────────

export interface CohostInviteView {
  /** Who is inviting them — a display name, an address, or "A Snapdini host". RAW. */
  inviter: string;
  /** The event's name, RAW. */
  eventName: string;
  acceptUrl: string;
}

export function cohostInviteEmail(v: CohostInviteView): BuiltEmail {
  const subject = `You've been invited to co-host "${v.eventName}" on Snapdini`;
  const preheader = `${v.inviter} would like you to help manage ${v.eventName}.`;
  const body = [
    para(`<strong>${esc(v.inviter)}</strong> invited you to co-host <strong>${esc(v.eventName)}</strong> on Snapdini &mdash; you&rsquo;ll be able to manage the event just like they can.`),
    button('Accept invitation &rarr;', v.acceptUrl),
    fine('If you don&rsquo;t have a Snapdini account yet, you&rsquo;ll be able to create one in a moment. If you didn&rsquo;t expect this, you can ignore this email.'),
  ].join('');
  const text = textEmail([
    `${v.inviter} invited you to co-host ${v.eventName} on Snapdini — you'll be able to manage the event just like they can.`,
    textLink('Accept the invitation', v.acceptUrl),
    'If you don’t have a Snapdini account yet, you’ll be able to create one in a moment. If you didn’t expect this, you can ignore this email.',
  ]);
  return { subject, preheader, html: htmlEmail('Co-host invitation', body, { preheader }), text };
}

// ── 3. The empty-scope notice ────────────────────────────────────────────────
//
// A host who set "send the favourites at reveal" and then starred nothing has not made a mistake we
// should paper over by sending everything, and they have not made one we should answer with silence
// either. Their guests get nothing and they get told why, with the page to fix it on.

export interface EmptyScopeView {
  /** The event's name, RAW. */
  eventName: string;
  scope: 'favourites' | 'all';
  moderationEnabled: boolean;
  /** How many guests are waiting on a link. */
  waiting: number;
  reviewUrl: string;
}

export function emptyScopeEmail(v: EmptyScopeView): BuiltEmail {
  const who = v.waiting === 1 ? '1 guest' : `${v.waiting} guests`;
  const safe = esc(v.eventName);
  // Three different situations wearing one message. "No visible photos" is the same words for a
  // host whose guests took nothing (nothing to do) and for one who has a full moderation queue
  // (everything to do), and the second is the common case for anyone who turned moderation on.
  const line = (name: string) => v.scope === 'favourites'
    ? `No favourites picked yet for ${name}`
    : v.moderationEnabled
      ? `Nothing approved yet for ${name}`
      : `No photos to send for ${name}`;
  const sendBtn = '<strong>Send the gallery link to guests now</strong> on your event page';
  const sendBtnText = '"Send the gallery link to guests now" on your event page';

  const body = v.scope === 'favourites'
    ? [
        para(`We were about to send your guests the favourites link for <strong>${safe}</strong>, but nothing is marked as a favourite yet &mdash; so we have sent nothing rather than an empty page.`),
        para(`${who} asked for their photos. Favourite the ones you want them to see, then press ${sendBtn}.`),
      ].join('')
    : v.moderationEnabled
      ? [
          para(`You have <strong>Moderate photos</strong> switched on for <strong>${safe}</strong>, and nothing is approved yet &mdash; so we have not sent your guests a link to an empty gallery.`),
          para(`${who} asked for their photos. Approve what you want them to see in Review &amp; Curate, then press ${sendBtn}. Nothing goes out on its own from here, so the timing is yours.`),
        ].join('')
      : [
          para(`We were about to send your guests the gallery link for <strong>${safe}</strong>, but there are no photos to show &mdash; so we have sent nothing rather than an empty page.`),
          para(`${who} asked for their photos. Press ${sendBtn} once there is something to see.`),
        ].join('');

  const textBody = v.scope === 'favourites'
    ? [
        `We were about to send your guests the favourites link for ${v.eventName}, but nothing is marked as a favourite yet — so we have sent nothing rather than an empty page.`,
        `${who} asked for their photos. Favourite the ones you want them to see, then press ${sendBtnText}.`,
      ]
    : v.moderationEnabled
      ? [
          `You have "Moderate photos" switched on for ${v.eventName}, and nothing is approved yet — so we have not sent your guests a link to an empty gallery.`,
          `${who} asked for their photos. Approve what you want them to see in Review & Curate, then press ${sendBtnText}. Nothing goes out on its own from here, so the timing is yours.`,
        ]
      : [
          `We were about to send your guests the gallery link for ${v.eventName}, but there are no photos to show — so we have sent nothing rather than an empty page.`,
          `${who} asked for their photos. Press ${sendBtnText} once there is something to see.`,
        ];

  const subject = line(v.eventName);   // inbox: raw
  const preheader = `${who} are waiting on a link, and there is nothing to send them yet.`;
  return {
    subject,
    preheader,
    html: htmlEmail(line(safe), `${body}${button('Open the event &rarr;', v.reviewUrl)}`, { preheader }),
    text: textEmail([...textBody, textLink('Open the event', v.reviewUrl)]),
  };
}

// ── 4. The guest invite ──────────────────────────────────────────────────────
//
// The last message that was still composed inline at its call site — inviteHtml() inside
// routes/guests.ts — and therefore the last one app/scripts/email-sampler.ts had to reproduce
// verbatim in order to render it. That copy is exactly the trap described at the top of this file,
// and it had already cost the same fix twice in one day.
//
// Two things it could not have while it lived in a route handler, and has now:
//   · a text/plain part. It was the ONE customer-facing template without one (named as the sole
//     exception in the sampler's NO_TEXT_PART set) because a route handler is nowhere to put the
//     text version of four sentences.
//   · button()/link() at source. Its call-to-action was written `class="btn"` and its "Or go to"
//     anchor carried no colour, both left for the chokepoint in email.ts htmlEmail() to repair.
//     The repair still runs — it is a safety net, not a plan — but nothing here needs it now.
//
// The subject deliberately has NO emoji: it is a Promotions-tab nudge in Gmail on the one message
// whose whole job is to reach an inbox, and the brand mark is already in the body chip.

export interface GuestInviteView {
  /** The event's name, RAW, straight off the row. */
  eventName: string;
  /** The guest's own name, RAW, or null — a guest list row need not have one. */
  guestName: string | null;
  /** The code typed on the join page, RAW. */
  joinCode: string;
  /** The join page for this event (slug URL if it has one, /join/CODE if not). */
  joinUrl: string;
  /** This guest's own unsubscribe page. One token per invite — see routes/guests.ts. */
  unsubUrl: string;
}

export function guestInviteEmail(v: GuestInviteView): BuiltEmail {
  const safeEvent = esc(v.eventName);
  const subject = `You're invited to ${v.eventName}`;
  const preheader = `Take photos on your phone at ${v.eventName} — there is nothing to install.`;

  const body = [
    v.guestName ? para(`Hi ${esc(v.guestName)},`) : '',
    para(`You're invited to be a photographer at <strong>${safeEvent}</strong>.`),
    para('Snapdini is a disposable camera for the event &mdash; take your shots on your phone, and '
      + "everyone's photos land in one shared album afterwards. There is nothing to install."),
    button('Join the event &rarr;', v.joinUrl),
    para(`Or go to ${link(v.joinUrl, esc(v.joinUrl))} and enter the code <strong>${esc(v.joinCode)}</strong>.`),
    fine(`You are getting this because the host of ${safeEvent} added you to their guest list. If it `
      + `was not meant for you, you can ignore it &mdash; or ${link(v.unsubUrl, 'unsubscribe', 'quiet')}, `
      + 'and choose whether that means this event or every Snapdini email.'),
  ].join('');

  // Built from the same view model, never by stripping the markup above. Note the "Or go to that
  // address" wording: the HTML says "go to <the link>", and a text reader has just been given that
  // address on its own line by the block before it, so repeating the URL would be noise.
  const text = textEmail([
    v.guestName ? `Hi ${v.guestName},` : '',
    `You're invited to be a photographer at ${v.eventName}.`,
    'Snapdini is a disposable camera for the event — take your shots on your phone, and '
      + "everyone's photos land in one shared album afterwards. There is nothing to install.",
    textLink('Join the event', v.joinUrl),
    `Or go to that address and enter the code ${v.joinCode}.`,
    `You are getting this because the host of ${v.eventName} added you to their guest list. If it was `
      + 'not meant for you, you can ignore it — or unsubscribe, and choose whether that means this '
      + 'event or every Snapdini email.',
    textLink('Unsubscribe', v.unsubUrl),
  ]);

  return { subject, preheader, html: htmlEmail(`You're invited to ${safeEvent}`, body, { preheader }), text };
}

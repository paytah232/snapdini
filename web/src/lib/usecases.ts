// Use-case marketing/landing pages. Each is an indexable page targeting a distinct high-intent
// search (e.g. "wedding disposable camera app"). Content is deliberately UNIQUE per page — shared
// boilerplate would be thin/duplicate content and hurt ranking. Rendered by UseCasePage.svelte;
// listed in sitemap.xml. Add a new entry here + a thin route folder + a sitemap line.

export type Faq = { q: string; a: string };
export type Feature = { ic: string; t: string; d: string };

export type UseCase = {
  slug: string;
  /** <title> — keep ≤ ~60 chars before the brand suffix. */
  title: string;
  /** meta description — ~150–160 chars. */
  desc: string;
  eyebrow: string;
  /** H1; may contain a single <em> for the accent word. */
  h1: string;
  lede: string;
  features: Feature[];
  faqs: Faq[];
  ctaTitle: string;
  ctaText: string;
};

const REVEAL: Feature = {
  ic: '🪄', t: 'The end-of-event reveal',
  d: 'Photos stay hidden all event, then the whole gallery reappears at once the moment it ends — the classic disposable-camera surprise.',
};
const NOAPP: Feature = {
  ic: '🔗', t: 'No app, just a QR',
  d: 'Guests scan a code or tap a link and the camera opens in their browser. Nothing to download, works on any phone.',
};
const SHARED: Feature = {
  ic: '🖼️', t: 'One shared gallery',
  d: 'Every guest’s shots collect in a single gallery you can browse, favourite and download together — including a full zip.',
};

export const usecases: Record<string, UseCase> = {
  'wedding-disposable-camera': {
    slug: 'wedding-disposable-camera',
    title: 'Wedding Disposable Camera App — QR Photo Sharing',
    desc: 'Snapdini is a digital disposable camera for weddings. Guests scan a QR code on the table to snap a limited roll — no app — and every photo lands in one shared gallery revealed after your big day. Free for up to 10 guests.',
    eyebrow: 'For weddings',
    h1: 'The disposable camera for your <em>wedding</em>.',
    lede: 'Put a QR code on every table. Guests scan, shoot their roll, and capture the candid moments you’ll never see from the photographer — all collected in one gallery you unwrap together after the day.',
    features: [
      { ic: '💍', t: 'Candid, guest’s-eye moments', d: 'The dance-floor laughs and table toasts your photographer can’t be everywhere for — captured by the people who were right there.' },
      NOAPP,
      REVEAL,
      SHARED,
    ],
    faqs: [
      { q: 'How does a wedding disposable camera app work?', a: 'You create an event, print the QR poster for your tables, and guests scan it to open a camera with a set number of shots. Every photo collects in one shared gallery you can reveal at the end of the night and download together.' },
      { q: 'Do wedding guests need to install anything?', a: 'No. They scan the QR code or tap a link and the camera opens right in their phone’s browser — no app store, no sign-up. Ideal for guests of every age.' },
      { q: 'Is it free for a wedding?', a: 'It’s free for up to 10 guests with every feature. Most weddings use a one-off paid pass for more guests — starting at A$5 — with optional add-ons for extra shots, photo frame sizes and short video clips.' },
      { q: 'Can we hide the photos until after the wedding?', a: 'Yes — choose the end-of-event reveal and the whole gallery stays hidden, then reappears at once when your event ends. Or show photos live as they’re taken. Your choice.' },
      { q: 'Can we download all the wedding photos afterwards?', a: 'Yes. Every shot lands in one gallery you can browse, favourite and download — including a single zip of the entire wedding.' },
      { q: 'How many shots does each guest get?', a: 'You decide when you set up the event — a limited roll keeps it fun and intentional, just like a real disposable camera. You can top up shots any time.' },
    ],
    ctaTitle: 'Set up your wedding camera in a minute.',
    ctaText: 'Create your event free, print the table QR, and have it ready before the first guest arrives.',
  },

  'birthday-party-camera': {
    slug: 'birthday-party-camera',
    title: 'Birthday Party Camera App — Shared QR Photos',
    desc: 'A digital disposable camera for birthday parties. Guests scan a QR to snap a limited roll — no app — and every photo lands in one shared gallery to reveal and download together. Free for up to 10 guests.',
    eyebrow: 'For birthdays & parties',
    h1: 'A disposable camera for the whole <em>party</em>.',
    lede: 'Hand the party a QR code and let everyone shoot. The candid, silly, off-guard shots all land in one gallery — then reappear together when the night’s over.',
    features: [
      { ic: '🎉', t: 'Everyone’s a photographer', d: 'No more begging people to AirDrop you their photos. Every guest’s shots land in one place automatically.' },
      NOAPP,
      REVEAL,
      SHARED,
    ],
    faqs: [
      { q: 'How does the party camera work?', a: 'Create an event, share the QR code or link, and guests open a camera with a limited roll of shots. Everything collects in one shared gallery you can reveal at the end and download together.' },
      { q: 'Do party guests need an app?', a: 'No. They scan the QR or tap the link and the camera opens in their browser — nothing to install, works on any phone.' },
      { q: 'Is there a free option for a birthday party?', a: 'Yes — free for up to 10 guests with all features. Bigger parties are a one-off pass from A$5, with optional add-ons for extra shots and short video clips.' },
      { q: 'Can guests take video clips too?', a: 'Yes, short video clips can be enabled as an add-on alongside photos — great for blowing out candles and party moments.' },
      { q: 'When do the party photos appear?', a: 'You choose: reveal everything at once when the party ends, or show photos live as they’re taken.' },
      { q: 'Can everyone download the photos after?', a: 'Yes — one shared gallery for the whole party, with a full zip download.' },
    ],
    ctaTitle: 'Get the party shooting.',
    ctaText: 'Create your event free and share one QR code with everyone — the gallery builds itself.',
  },

  'corporate-event-photo-sharing': {
    slug: 'corporate-event-photo-sharing',
    title: 'Corporate Event Photo Sharing — QR Camera',
    desc: 'A QR-code camera for corporate events, conferences and team parties. Attendees scan to snap photos — no app, no logins — into one shared, downloadable gallery. Free to trial; one-off pass for larger events.',
    eyebrow: 'For corporate & teams',
    h1: 'Crowd-sourced photos for your <em>company event</em>.',
    lede: 'Conferences, launches, off-sites and team parties — put a QR on the screen or lanyard and let attendees capture it from every angle. One shared gallery, ready to download for the recap.',
    features: [
      { ic: '🏢', t: 'Every angle of the event', d: 'Keynotes, booths, breakout rooms and the after-party — captured by attendees, not just one photographer.' },
      { ic: '🔗', t: 'No app, no logins', d: 'Attendees scan a QR and shoot in-browser. No accounts, no IT tickets, no friction — exactly what an event needs.' },
      SHARED,
      { ic: '🎬', t: 'Instant recap material', d: 'Download the full gallery as a zip or build a slideshow for the wrap-up email and socials.' },
    ],
    faqs: [
      { q: 'How does corporate event photo sharing work with Snapdini?', a: 'You create an event and display a QR code (on slides, signage or lanyards). Attendees scan to open a browser camera, and all photos collect in one shared gallery you can download for recaps and marketing.' },
      { q: 'Do attendees need to install an app or create an account?', a: 'No — they scan a QR or open a link and shoot in the browser. No app, no login, no IT involvement.' },
      { q: 'Can we remove Snapdini branding for a company event?', a: 'Yes. Frame branding can be removed as a paid add-on, and the poster/QR and theme can be styled to match your event.' },
      { q: 'Can we control who sees the photos?', a: 'Yes — enable moderation to approve shots before they appear, choose when the gallery is revealed, and control downloads.' },
      { q: 'Can we get all the photos for marketing afterwards?', a: 'Yes — download the whole event as a zip, or generate a slideshow video for the recap.' },
      { q: 'Is it suitable for large conferences?', a: 'Yes — pick a guest tier to match attendance, and top up shots or capacity any time during the event.' },
    ],
    ctaTitle: 'Capture your next company event.',
    ctaText: 'Create an event, drop the QR on your signage, and collect every attendee’s photos in one gallery.',
  },

  'baby-shower-photo-app': {
    slug: 'baby-shower-photo-app',
    title: 'Baby Shower Photo App — Shared QR Camera',
    desc: 'A digital disposable camera for baby showers. Guests scan a QR to snap a limited roll — no app — into one shared gallery to reveal and keep. Free for up to 10 guests.',
    eyebrow: 'For baby showers',
    h1: 'A shared camera for the <em>baby shower</em>.',
    lede: 'Let every guest capture the games, the gifts and the happy tears. One QR code, one gallery — a keepsake of the day to reveal together and treasure.',
    features: [
      { ic: '🍼', t: 'A keepsake of the day', d: 'The candid moments between the planned photos — all gathered into one gallery to keep and share with family.' },
      NOAPP,
      REVEAL,
      SHARED,
    ],
    faqs: [
      { q: 'How does the baby shower camera work?', a: 'Create an event, share the QR code or link, and guests open a camera with a limited roll. Every photo collects in one shared gallery you can reveal at the end and download to keep.' },
      { q: 'Do guests need to download an app?', a: 'No — they scan the QR or tap the link and the camera opens in their browser. Easy for guests of any age.' },
      { q: 'Is it free for a baby shower?', a: 'Yes — free for up to 10 guests with all features. Larger gatherings are a one-off pass from A$5.' },
      { q: 'Can we share the gallery with family who couldn’t come?', a: 'Yes — create a share link to the gallery so distant family can see (and download) the photos too.' },
      { q: 'When do the photos appear?', a: 'You choose — reveal them all at once when the shower ends, or show them live as they’re taken.' },
      { q: 'Can we download all the photos afterwards?', a: 'Yes — one shared gallery with a full zip download to keep forever.' },
    ],
    ctaTitle: 'Set up your baby-shower camera.',
    ctaText: 'Create your event free, share one QR code, and gather every guest’s photos into one keepsake gallery.',
  },
};

export const useCaseSlugs = Object.keys(usecases);

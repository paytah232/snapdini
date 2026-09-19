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
  /** The challenges.ts pack key for this event type. Each page shows ITS OWN pack's tricks, so
   *  the examples are real and differ from page to page instead of repeating one list. */
  packKey: string;
  /** Heading and copy for the photo-tricks section, written per page for the same reason
   *  everything else here is. */
  missionsTitle: string;
  missionsText: string;
  ctaTitle: string;
  ctaText: string;
  /** A key into SAMPLE_SETS (lib/samples.ts) — real photos from an event of THIS kind.
   *
   *  Optional, and deliberately: a page with no photos of its own is better than a page showing
   *  somebody else's wedding while claiming to be about a birthday. Pages without a set simply
   *  render no strip. */
  photos?: string;
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
  d: 'Every guest’s shots collect in a single gallery you can browse, favourite and download — one photo, or the whole event in one go.',
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
      { q: 'Can we download all the wedding photos afterwards?', a: 'Yes. Every shot lands in one gallery you can browse, favourite and download — a single photo, or the entire wedding in one go.' },
      { q: 'How many shots does each guest get?', a: 'You decide when you set up the event — a limited roll keeps it fun and intentional, just like a real disposable camera. You can top up shots any time.' },
    ],
    packKey: 'wedding',
    missionsTitle: 'A shot list for every table.',
    missionsText: 'Choose the moments you’d hate to come home without and they print on the table cards. Guests tick each one off in the camera as they shoot it, which is how you end up with the cake before it was cut and your great-aunt on the dance floor — frames nobody working the room could be standing next to. Each guest has one roll and sees nothing until the reveal, so spending a shot on the list is a decision they actually make.',
    ctaTitle: 'Set up your wedding camera in a minute.',
    ctaText: 'Create your event free, print the table QR, and have it ready before the first guest arrives.',
    photos: 'wedding',
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
      { q: 'Can everyone download the photos after?', a: 'Yes — one shared gallery for the whole party, and you can take the lot in one go.' },
    ],
    packKey: 'birthday',
    missionsTitle: 'Give the party something to hunt for.',
    missionsText: 'A list on the table turns the guests into photographers with a job. The candles still lit, the worst party hat, the face when the present comes out of the bag — they tick each one off in the camera as they get it. Nobody can shoot the same thing twenty times and keep the best one, so what comes back is the first honest attempt.',
    ctaTitle: 'Get the party shooting.',
    ctaText: 'Create your event free and share one QR code with everyone — the gallery builds itself.',
    photos: 'birthday',
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
      { ic: '🎬', t: 'Instant recap material', d: 'Take the full gallery in one go, or build a slideshow for the wrap-up email and socials.' },
    ],
    faqs: [
      { q: 'How does corporate event photo sharing work with Snapdini?', a: 'You create an event and display a QR code (on slides, signage or lanyards). Attendees scan to open a browser camera, and all photos collect in one shared gallery you can download for recaps and marketing.' },
      { q: 'Do attendees need to install an app or create an account?', a: 'No — they scan a QR or open a link and shoot in the browser. No app, no login, no IT involvement.' },
      { q: 'Can we remove Snapdini branding for a company event?', a: 'Yes. Frame branding can be removed as a paid add-on, and the poster/QR and theme can be styled to match your event.' },
      { q: 'Can we control who sees the photos?', a: 'Yes — enable moderation to approve shots before they appear, choose when the gallery is revealed, and control downloads.' },
      { q: 'Can we get all the photos for marketing afterwards?', a: 'Yes — download the whole event in one go, or generate a slideshow video for the recap.' },
      { q: 'Is it suitable for large conferences?', a: 'Yes — pick a guest tier to match attendance, and top up shots or capacity any time during the event.' },
    ],
    packKey: 'corporate',
    missionsTitle: 'The bits nobody thinks to photograph.',
    missionsText: 'Attendees will shoot the keynote without being asked. Put a list on the tables and you also get the coffee queue, the busiest whiteboard, and two people from teams that never speak. Each one ticks off in the app as it is taken, so afterwards you can see which prompts the room actually went for — worth knowing before you plan the next one.',
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
      { q: 'Can we download all the photos afterwards?', a: 'Yes — one shared gallery, and you can download the whole thing to keep forever.' },
    ],
    packKey: 'baby-shower',
    missionsTitle: 'A gentle list for the tables.',
    missionsText: 'Nobody wants a scavenger hunt at a baby shower, and this works differently. A short list gives the guest who knows one person in the room a reason to talk to someone else, and it makes sure the dessert table got photographed before the games started. Guests tick each one off in the camera, and the whole lot stays hidden until you reveal it together.',
    ctaTitle: 'Set up your baby-shower camera.',
    ctaText: 'Create your event free, share one QR code, and gather every guest’s photos into one keepsake gallery.',
  },

  'bachelorette-hens-party-camera': {
    slug: 'bachelorette-hens-party-camera',
    title: 'Bachelorette & Hen Party Camera App',
    desc: 'A shared QR camera for bachelorette and hen parties. Everyone scans to snap a limited roll — no app — and the (sometimes incriminating) photos land in one gallery revealed at the end. Free for up to 10 guests.',
    eyebrow: 'For hen & bachelorette parties',
    h1: 'The shared camera for the <em>hen do</em>.',
    lede: 'Whatever happens on the night, it lands in one gallery. Everyone scans the same QR, shoots their roll, and the whole story reappears together when it’s over — nothing lost in a dozen camera rolls.',
    features: [
      { ic: '🥂', t: 'Every angle of the night', d: 'The bits the bride misses while she’s busy being celebrated — captured by the whole group.' },
      NOAPP,
      REVEAL,
      SHARED,
    ],
    faqs: [
      { q: 'How does a hen / bachelorette party camera work?', a: 'Create an event, share the QR code or link, and everyone opens a camera with a limited roll. All the photos collect in one shared gallery you reveal at the end and download together.' },
      { q: 'Do guests need an app?', a: 'No — scan the QR or tap the link and the camera opens in the browser. Works on any phone, no install.' },
      { q: 'Is it free?', a: 'Free for up to 10 guests with all features. Bigger groups are a one-off pass from A$5, with optional add-ons for extra shots and short videos.' },
      { q: 'Can we keep the photos private until the end?', a: 'Yes — choose the end-of-night reveal so nothing shows until the party’s over, then it all reappears at once.' },
      { q: 'Can we get all the photos afterwards?', a: 'Yes — one shared gallery, and the whole lot downloads in one go for the bride to keep.' },
    ],
    packKey: 'hens',
    missionsTitle: 'One list, however the day splits up.',
    missionsText: 'Hen dos run long and the group comes apart and back together. A list keeps everyone shooting the same day: matching outfits before they wilt, the sash on someone it was never meant for, the one quiet moment somewhere in the middle. Each one ticks off in the camera as it happens, and nothing is visible until the end, so nobody gets to edit the story while it is still going on.',
    ctaTitle: 'Get the whole night in one gallery.',
    ctaText: 'Create your event free and share one QR — every photo from every phone, in one place.',
  },

  'engagement-party-camera': {
    slug: 'engagement-party-camera',
    title: 'Engagement Party Camera — Shared QR Photos',
    desc: 'A digital disposable camera for engagement parties. Guests scan a QR to snap a limited roll — no app — into one shared gallery revealed at the end. Free for up to 10 guests; a head start before the wedding.',
    eyebrow: 'For engagement parties',
    h1: 'A shared camera for the <em>engagement</em>.',
    lede: 'Celebrate the “yes” with photos from everyone who came. One QR code, one gallery — the candid moments to keep, and a perfect warm-up for the wedding camera later.',
    features: [
      { ic: '💞', t: 'The first of many', d: 'Capture the engagement the same way you’ll capture the wedding — by everyone there, in one gallery.' },
      NOAPP,
      REVEAL,
      SHARED,
    ],
    faqs: [
      { q: 'How does the engagement party camera work?', a: 'Create an event, share the QR or link, and guests open a camera with a limited roll. Every photo lands in one shared gallery you reveal at the end and download together.' },
      { q: 'Do guests need to install an app?', a: 'No — they scan a QR or tap a link and shoot in the browser. Nothing to download.' },
      { q: 'Is it free?', a: 'Free for up to 10 guests with all features; larger parties are a one-off pass from A$5.' },
      { q: 'Can we use it again for the wedding?', a: 'Yes — set up a fresh event for the wedding when the time comes. Same simple QR, new gallery.' },
      { q: 'Can everyone download the photos?', a: 'Yes — one shared gallery, and everything downloads in one go.' },
    ],
    packKey: 'engagement',
    missionsTitle: 'A dry run for the wedding list.',
    missionsText: 'An engagement party is usually the first time both sides are in one room, which is exactly why the list is worth printing. Ask for the ring close up, both families in one frame, the longest-married couple in the room. Guests tick them off as they shoot, on a fixed roll with no previews, so what comes back is what was in front of them.',
    ctaTitle: 'Capture the celebration.',
    ctaText: 'Create your event free, share one QR, and collect every guest’s photos from the night.',
  },

  'graduation-party-photo-app': {
    slug: 'graduation-party-photo-app',
    title: 'Graduation Party Photo App — Shared QR Camera',
    desc: 'A shared QR camera for graduation parties. Friends and family scan to snap a limited roll — no app — into one gallery to reveal and keep. Free for up to 10 guests.',
    eyebrow: 'For graduations',
    h1: 'A shared camera for the <em>graduation</em>.',
    lede: 'Cap toss, family photos and the after-party — captured by everyone there and gathered into one gallery to celebrate the milestone and keep forever.',
    features: [
      { ic: '🎓', t: 'The whole milestone', d: 'From the ceremony to the party, captured by friends and family — not just whoever held the camera.' },
      NOAPP,
      REVEAL,
      SHARED,
    ],
    faqs: [
      { q: 'How does the graduation photo app work?', a: 'Create an event, share the QR or link, and guests open a camera with a limited roll. All photos collect in one shared gallery you reveal at the end and download together.' },
      { q: 'Do guests need an app?', a: 'No — scan the QR or tap the link to shoot in the browser. No install, any phone.' },
      { q: 'Is it free?', a: 'Free for up to 10 guests with all features; larger gatherings are a one-off pass from A$5.' },
      { q: 'Can family who couldn’t attend see the photos?', a: 'Yes — create a share link to the gallery so distant family can view and download.' },
      { q: 'Can we download everything afterwards?', a: 'Yes — one shared gallery, and you can download the whole thing to keep.' },
    ],
    packKey: 'graduation',
    missionsTitle: 'Decide what gets photographed.',
    missionsText: 'Half the day is a ceremony and the other half is a party, and the phone shots usually do neither of them properly. A printed list settles it in advance: the cap mid-air, the teacher who mattered, whoever paid for all this. Guests tick each one off in the camera as they go, and the whole gallery arrives at once when it is over.',
    ctaTitle: 'Capture the big day.',
    ctaText: 'Create your event free, share one QR, and gather every photo from the graduation into one gallery.',
  },

  'holiday-christmas-party-camera': {
    slug: 'holiday-christmas-party-camera',
    title: 'Holiday & Christmas Party Camera App',
    desc: 'A shared QR camera for holiday and Christmas parties — office or family. Everyone scans to snap a limited roll, no app, into one gallery to reveal and download. Free for up to 10 guests.',
    eyebrow: 'For holiday & Christmas parties',
    h1: 'A shared camera for the <em>Christmas party</em>.',
    lede: 'Office do or family gathering — let everyone capture it. One QR on the table or the invite, one gallery of the whole night, revealed and ready to download when it’s over.',
    features: [
      { ic: '🎄', t: 'The whole party, one gallery', d: 'Secret Santa, the dance floor and the group photo — captured by everyone, collected in one place.' },
      { ic: '🔗', t: 'No app, no logins', d: 'Guests scan a QR and shoot in-browser — perfect for a mixed crowd or a work event with no IT fuss.' },
      REVEAL,
      SHARED,
    ],
    faqs: [
      { q: 'How does the holiday party camera work?', a: 'Create an event, share the QR or link, and everyone opens a camera with a limited roll. All photos collect in one shared gallery you reveal at the end and download together.' },
      { q: 'Do guests need an app?', a: 'No — they scan a QR or tap a link and shoot in the browser. No install, any phone.' },
      { q: 'Is it good for an office Christmas party?', a: 'Yes — no logins or accounts for attendees, optional moderation, and you can remove Snapdini branding and theme it for the company.' },
      { q: 'Is there a free option?', a: 'Free for up to 10 guests with all features; larger parties are a one-off pass from A$5.' },
      { q: 'Can we download all the photos?', a: 'Yes — one shared gallery, and everything downloads in one go.' },
    ],
    packKey: 'christmas',
    missionsTitle: 'Something for the tables besides crackers.',
    missionsText: 'A work Christmas party needs a reason for people to get up and mix, and a shot list is a cheap one. The worst jumper, a cracker mid-pull, someone from a team you never work with — each one ticks off in the app as it is taken. One roll each and no previews, so the photos are all first takes and they look like it.',
    ctaTitle: 'Capture the holiday party.',
    ctaText: 'Create your event free, share one QR, and collect everyone’s photos from the night in one gallery.',
  },

  // The one page here that is not about a party. Everything else on the site assumes a room, a date
  // and a host handing out a QR; a trip is a week, a group chat and four people who each came home
  // with two hundred photos nobody else has seen. Same product, different problem — and it is the
  // reason the NZ and Japan photos exist on the site at all.
  'group-travel-photo-app': {
    slug: 'group-travel-photo-app',
    title: 'Group Travel Photo App — Shared Trip Photo Album',
    desc: 'A group travel photo app that collects everyone\u2019s holiday photos in one shared album. Each traveller gets a limited roll, no app to install, and the whole trip is revealed together at the end. Free for groups up to 10.',
    eyebrow: 'For trips & holidays',
    h1: 'One shared album for the <em>whole trip</em>.',
    lede: 'Everyone shoots. Nobody shares. Six months later the photos are still sitting on four different phones. Snapdini is a group travel photo app that gives the whole trip one camera and one shared album \u2014 and hands it back at the end, in one place.',
    features: [
      { ic: '\ud83e\uddf3', t: 'Nobody has to chase anyone', d: 'No \u201ccan you send me that one?\u201d six weeks later. Every traveller\u2019s shots land in the same gallery as they go, and the whole lot downloads in one go.' },
      NOAPP,
      { ic: '\ud83d\udcf8', t: 'A roll a day, not a thousand frames',
        d: 'A limited roll makes people look before they shoot. What comes back is the trip as it happened \u2014 not four hundred near-identical shots of the same view nobody will ever sort through.' },
      SHARED,
    ],
    faqs: [
      { q: 'How does a group travel photo app work?', a: 'You create an event for the trip and share one link or QR with everyone travelling. Each person opens a camera in their browser, shoots their roll, and every photo collects in one shared gallery you can all browse and download.' },
      { q: 'Is there a group travel photo app everyone has to download?', a: 'No \u2014 that is the point. It opens in the browser on any phone \u2014 handy when half the group is on iPhone, half on Android, and somebody is roaming on a bad connection.' },
      { q: 'Can we see the photos during the trip, or only at the end?', a: 'Either. Set the gallery to reveal as you go, so the group sees today\u2019s photos tonight \u2014 or hold it all back and unwrap the whole trip on the last night.' },
      { q: 'How long can a trip event run for?', a: 'As long as you need. The free tier covers a short trip and up to 10 travellers; longer trips and bigger groups are a one-off pass, with options to keep the gallery up for months afterwards.' },
      { q: 'What about photos taken where there is no signal?', a: 'Shots are taken in the browser and upload when the phone next has a connection, so a day up a mountain or on a train still ends up in the gallery.' },
      { q: 'Can everyone download the photos afterwards?', a: 'Yes \u2014 one gallery for the trip, and anyone in the group can take a single photo or the whole set in one go.' },
    ],
    packKey: 'travel',
    missionsTitle: 'Give the trip a shot list.',
    missionsText: 'A list turns the group into photographers with a job, and it catches the things nobody thinks to photograph until they are home: the breakfast you ate every single morning, the view from the train, whoever is always last out of the room. Each one ticks off in the camera as it is taken, so the album comes back with the ordinary days in it, not just the postcard stops.',
    ctaTitle: 'Collect the whole trip in one place.',
    ctaText: 'Create an event free, share one link with the group, and stop chasing people for their photos.',
    photos: 'travel',
  },
};

export const useCaseSlugs = Object.keys(usecases);

/** Short labels for the footer's "Popular uses" row. Derived from `usecases` so a new use-case
 *  page appears in the footer automatically — the eyebrow ("For weddings") is trimmed to just the
 *  subject ("Weddings"), which reads better as a link than a full page title. */
export const usecaseLinks: { slug: string; label: string }[] = Object.values(usecases).map((u) => ({
  slug: u.slug,
  label: (() => {
    const t = u.eyebrow.replace(/^For\s+/i, '').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  })(),
}));

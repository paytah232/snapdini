// Pricing display data for the /pricing marketing page. MIRRORS the server billing config
// (app billing tiers, currency AUD) — keep in sync if the server tiers change. Display-only;
// the real charge is always computed server-side at checkout.

/** `badge` is the ribbon on the card. `highlight` is the visual emphasis — the two are separate
 *  because the tier worth emphasising is not always the one carrying a claim. */
export type GuestTier = {
  guests: string; price: string; highlight?: boolean; badge?: string; note: string;
  /** Overrides the default sign-up button — used by the tier that is a conversation, not a purchase. */
  cta?: { label: string; href: string };
};
export type AddOn = { ic: string; name: string; detail: string };
export type Faq = { q: string; a: string };

// "Most popular" was on the free tier, which was both untrue and self-defeating — it pointed
// people at the option that earns nothing. 60 guests is what actually sells (3 of the first 4 paid
// events), and 400 is genuinely the cheapest per head (~A$0.15/guest against A$0.25 at 60), so it
// earns "Best value" honestly rather than as a label we picked. The per-guest figure stays out of
// the card copy: it invites the reader to do the sum on every other tier, and 60 — the one they
// are most likely to buy — is the worst of them.
export const guestTiers: GuestTier[] = [
  { guests: 'Up to 10 guests', price: 'Free', badge: 'Free forever', note: 'Every feature included — no card needed' },
  { guests: 'Up to 25 guests', price: 'A$5', note: 'One-off, per event' },
  { guests: 'Up to 60 guests', price: 'A$15', highlight: true, badge: 'Most popular', note: 'One-off, per event' },
  { guests: 'Up to 150 guests', price: 'A$29', note: 'One-off, per event' },
  { guests: 'Up to 400 guests', price: 'A$59', badge: 'Best value', note: 'One-off, per event' },
];

export const addOns: AddOn[] = [
  { ic: '🎞️', name: 'More shots per guest', detail: '12 free → 24 (+A$3), 36 (+A$5) or 48 (+A$8).' },
  { ic: '⏱️', name: 'Longer event window', detail: 'Up to 48h free → 72h (+A$2), 1 week (+A$5), 1 month (+A$10) or 3 months (+A$25).' },
  { ic: '📦', name: 'Photos kept a month', detail: 'Paid events include a full month (31 days). Extend to 3 months (+A$8), 6 months (+A$12) or a full year (+A$20). Free events keep photos 7 days.' },
  { ic: '🎬', name: 'Video clips', detail: 'Let guests capture short video clips alongside photos (from +A$2).' },
  // This used to read "Clean photo frames and slideshow without the Snapdini mark", which made it
  // sound like the photos themselves are watermarked. They are not — every photo and video is
  // delivered clean on every tier, free included. The only Snapdini branding anywhere is the intro
  // and outro card on a generated slideshow, and this add-on removes those two cards.
  { ic: '🎞️', name: 'Slideshow without our intro & outro', detail: 'Your photos are never watermarked — on any plan. The only Snapdini branding is the short intro and outro card on a generated slideshow; this removes them (+A$5).' },
  { ic: '🖼️', name: 'Extra photo shapes', detail: 'Square is standard. Add portrait and landscape shapes for guests to shoot in (+A$5, free on events up to 10 guests).' },
];

export const pricingFaqs: Faq[] = [
  { q: 'How much does Snapdini cost?', a: 'It’s free for events of up to 10 guests with every feature included. Larger events are a one-off pass — A$5 for up to 25 guests, scaling to A$59 for up to 400 — with optional add-ons for extra shots, longer events, longer photo retention and video. Paid events keep photos for a full month (31 days) as standard.' },
  { q: 'Is it really free?', a: 'Yes — up to 10 guests is free forever with all features, no credit card required. You only pay if you need a bigger event or an add-on.' },
  { q: 'Is it a subscription?', a: 'No. Each paid event is a one-off charge — you pay per event, not monthly.' },
  { q: 'Can I upgrade after I’ve started?', a: 'Yes — you can top up guests, shots or length at any time, before or during the event, and only pay the difference.' },
  { q: 'Do you offer a discount?', a: 'Events with up to 10 guests are free forever, with every feature — most people never need to pay at all. After a paid event we email the host a single-use thank-you code towards their next one. We also honour any promo code we have sent you at checkout.' },
  { q: 'Can I get a refund?', a: 'Yes — if you change your mind you can cancel a paid event for a full refund any time before it starts, from the event’s manage page or by emailing support@snapdini.com. Once an event has started, refunds are for faults on our side, reviewed case-by-case.' },
  { q: 'Can I self-host Snapdini for free?', a: 'Yes — Snapdini is open source (AGPL-3.0). You can self-host the full app for free from the public Docker images; billing is optional and only switches on if you add your own Stripe keys.' },
];

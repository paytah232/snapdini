// Pricing display data for the /pricing marketing page. MIRRORS the server billing config
// (app billing tiers, currency AUD) — keep in sync if the server tiers change. Display-only;
// the real charge is always computed server-side at checkout.

export type GuestTier = { guests: string; price: string; highlight?: boolean; note: string };
export type AddOn = { ic: string; name: string; detail: string };
export type Faq = { q: string; a: string };

export const guestTiers: GuestTier[] = [
  { guests: 'Up to 10 guests', price: 'Free', highlight: true, note: 'Every feature included — no card needed' },
  { guests: 'Up to 25 guests', price: 'A$5', note: 'One-off, per event' },
  { guests: 'Up to 60 guests', price: 'A$15', note: 'One-off, per event' },
  { guests: 'Up to 150 guests', price: 'A$29', note: 'One-off, per event' },
  { guests: 'Up to 400 guests', price: 'A$59', note: 'One-off, per event' },
];

export const addOns: AddOn[] = [
  { ic: '🎞️', name: 'More shots per guest', detail: '12 free → 24 (+A$3), 36 (+A$5) or 48 (+A$8).' },
  { ic: '⏱️', name: 'Longer event window', detail: 'Up to 48h free → 72h (+A$2), 1 week (+A$5) or 1 year (+A$10).' },
  { ic: '📦', name: 'Photos kept a month', detail: 'Paid events include 30 days. Extend to 3 months (+A$8) or a full year (+A$15). Free events keep photos 7 days.' },
  { ic: '🎬', name: 'Video clips', detail: 'Let guests capture short video clips alongside photos (from +A$2).' },
  { ic: '🖼️', name: 'Remove Snapdini branding', detail: 'Clean photo frames and slideshow without the Snapdini mark (paid add-on).' },
];

export const pricingFaqs: Faq[] = [
  { q: 'How much does Snapdini cost?', a: 'It’s free for events of up to 10 guests with every feature included. Larger events are a one-off pass — A$5 for up to 25 guests, scaling to A$59 for up to 400 — with optional add-ons for extra shots, longer events, longer photo retention and video. Paid events keep photos for 30 days as standard.' },
  { q: 'Is it really free?', a: 'Yes — up to 10 guests is free forever with all features, no credit card required. You only pay if you need a bigger event or an add-on.' },
  { q: 'Is it a subscription?', a: 'No. Each paid event is a one-off charge — you pay per event, not monthly.' },
  { q: 'Can I upgrade after I’ve started?', a: 'Yes — you can top up guests, shots or length at any time, before or during the event, and only pay the difference.' },
  { q: 'Do you offer a discount?', a: 'Use the launch code LAUNCH20 at checkout for 20% off a paid event (limited time).' },
  { q: 'Can I get a refund?', a: 'Yes — if you change your mind you can cancel a paid event for a full refund any time before it starts, from the event’s manage page or by emailing support@snapdini.com. Once an event has started, refunds are for faults on our side, reviewed case-by-case.' },
  { q: 'Can I self-host Snapdini for free?', a: 'Yes — Snapdini is open source (AGPL-3.0). You can self-host the full app for free from the public Docker images; billing is optional and only switches on if you add your own Stripe keys.' },
];

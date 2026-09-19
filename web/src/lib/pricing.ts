// Pricing display copy for the /pricing marketing page. Display-only; the real charge is always
// computed server-side at checkout.
//
// THE TWO VOLATILE LINES ARE DERIVED, the rest is prose. This file used to mirror the server by
// hand, with a comment asking whoever changed billing.ts to remember — and it did not survive
// contact: "36 (+A$5) or 48 (+A$8)" sat on the live pricing page for a whole release after those
// rungs became $6 and $9, and the ladder had grown past 48 entirely. A page that quotes a price we
// do not charge is worse than one that quotes none.
//
// So the shots and video lines are now built from the billing config the page already fetches (see
// addOnsFor), and the STATIC fallback below carries no figures for them at all — it cannot be wrong
// about a number it does not state. The remaining prose lines quote ladders that have not moved in
// the product's life; if one of them starts moving, it belongs in addOnsFor too.
import type { BillingConfig } from './types';

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
  // No figures: this is what renders before the config arrives, and an unpriced sentence is the one
  // thing that can never be out of date. addOnsFor() puts the real numbers in.
  { ic: '🎞️', name: 'More shots per guest', detail: 'Everyone gets 12 included. Add more per guest, priced by the dozen.' },
  // KEEP IN STEP WITH app/src/server/billing.ts → DURATION_TIERS. This file is prose, not data: it
  // is written out by hand because marketing copy reads differently from a tier table, which means
  // a price changed in billing.ts does NOT change it here. The 2-week tier was added and this line
  // was the one place in the product that still said otherwise.
  { ic: '⏱️', name: 'Longer event window', detail: 'Up to 48h free → 72h (+A$2), 1 week (+A$5), 2 weeks (+A$7), 1 month (+A$10) or 3 months (+A$25).' },
  { ic: '📦', name: 'Photos kept a month', detail: 'Paid events include a full month (31 days). Extend to 3 months (+A$8), 6 months (+A$12) or a full year (+A$20). Free events keep photos 7 days.' },
  { ic: '🎬', name: 'Video clips', detail: 'Let guests capture short video clips alongside photos.' },
  // This used to read "Clean photo frames and slideshow without the Snapdini mark", which made it
  // sound like the photos themselves are watermarked. They are not — every photo and video is
  // delivered clean on every tier, free included. The only Snapdini branding anywhere is the intro
  // and outro card on a generated slideshow, and this add-on removes those two cards.
  { ic: '🎞️', name: 'Slideshow without our intro & outro', detail: 'Your photos are never watermarked — on any plan. The only Snapdini branding is the short intro and outro card on a generated slideshow; this removes them (+A$5).' },
  { ic: '🖼️', name: 'Extra photo shapes', detail: 'Square is standard. Add portrait and landscape shapes for guests to shoot in (+A$5, free on events up to 10 guests).' },
];

const money = (cents: number) => `A$${(cents / 100).toFixed(0)}`;

/** The add-on list with today's real numbers in it, for a page that has the billing config.
 *
 *  Falls back to the unpriced prose above whenever a ladder is missing — on the server render, on a
 *  self-hosted instance with billing switched off, or if the config fetch fails. Quoting nothing is
 *  always better than quoting a stale figure. */
export function addOnsFor(billing: BillingConfig | null | undefined): AddOn[] {
  const shots = billing?.shotsTiers ?? [];
  const video = billing?.videoAddons ?? [];
  const free = billing?.shotsFree ?? 12;
  return addOns.map((a) => {
    if (a.name === 'More shots per guest' && shots.length > 1) {
      const next = shots.find((t) => t.maxShots > free);
      const top = shots[shots.length - 1];
      if (!next) return a;
      return { ...a, detail:
        `Everyone gets ${free} included, and you can go to ${top.maxShots} each. `
        + `The next dozen is +${money(next.amountCents)}; the full roll is +${money(top.amountCents)}.` };
    }
    if (a.name === 'Video clips' && video.length) {
      const lo = video[0], hi = video[video.length - 1];
      return { ...a, detail:
        `Let guests record short clips alongside photos — ${lo.seconds}s to ${hi.seconds}s, `
        + `from +${money(lo.amountCents)}. Video is the one add-on that scales with your guest count, `
        + `because every guest can record one.` };
    }
    return a;
  });
}

export const pricingFaqs: Faq[] = [
  { q: 'How much does Snapdini cost?', a: 'It’s free for events of up to 10 guests with every feature included. Larger events are a one-off pass — A$5 for up to 25 guests, scaling to A$59 for up to 400 — with optional add-ons for extra shots, longer events, longer photo retention and video. Paid events keep photos for a full month (31 days) as standard.' },
  { q: 'Is it really free?', a: 'Yes — up to 10 guests is free forever with all features, no credit card required. You only pay if you need a bigger event or an add-on.' },
  { q: 'Is it a subscription?', a: 'No. Each paid event is a one-off charge — you pay per event, not monthly.' },
  { q: 'Can I upgrade after I’ve started?', a: 'Yes — you can top up guests, shots or length at any time, before or during the event, and only pay the difference.' },
  { q: 'Do you offer a discount?', a: 'Events with up to 10 guests are free forever, with every feature — most people never need to pay at all. After a paid event we email the host a single-use thank-you code towards their next one. We also honour any promo code we have sent you at checkout.' },
  { q: 'Can I get a refund?', a: 'Yes — if you change your mind you can cancel a paid event for a full refund any time before it starts, from the event’s manage page or by emailing support@snapdini.com. Once an event has started, refunds are for faults on our side, reviewed case-by-case.' },
  { q: 'Can I self-host Snapdini for free?', a: 'Yes — Snapdini is open source (AGPL-3.0). You can self-host the full app for free from the public Docker images; billing is optional and only switches on if you add your own Stripe keys.' },
];

// What each paid feature costs ON THIS EVENT.
//
// Out here rather than inside the create form because the answer is not a number, and the form was
// the only place that knew it. The same add-on is charged on one event, gifted on another and
// already included on a third, and those three have to stay distinguishable all the way to the
// pixel: collapsing them to "$0" tells a host with a small event that video is simply free — so
// when they later plan a 60-guest party and it is suddenly $5, we look like we changed the deal.
//
// Every figure comes from the server's BillingConfig. Nothing here invents a price; the fallbacks
// below exist only so a form rendered before /api/config answers is not a form full of NaN.
import type { BillingConfig } from './types';

// Mirrors app/src/server/billing.ts. Only ever reached when the config fetch failed — a wizard that
// renders "undefined shots" offline is worse than one that renders the shipping defaults.
const FALLBACK_FREE_ALL_GUESTS = 10;
const FALLBACK_SHOTS_FREE = 12;
const FALLBACK_RETENTION_FREE_DAYS = 7;
const FALLBACK_RETENTION_PAID_DAYS = 31;

/** What a feature costs the host in front of us.
 *
 *  `included` and `gift` both cost nothing today and mean completely different things. `included`
 *  is part of every event forever; `gift` is a real add-on with a real price that this host is not
 *  being charged because their event is small. Showing a gift as plain "free" throws away the only
 *  moment we ever get to say "this is worth $5 and you are not paying it", and showing it as "$5"
 *  charges them for something they are getting. */
export type FeaturePrice =
  | { kind: 'included' }
  | { kind: 'gift'; wouldBeCents: number }
  | { kind: 'paid'; cents: number };

/** Are the per-feature add-ons (video, extra shots, frame shapes) waived at this guest count?
 *
 *  Retention is NOT one of them — see `retentionIncludedDays`. */
export function featuresFreeAt(billing: BillingConfig | null, guests: number): boolean {
  return guests <= (billing?.freeAllGuests ?? FALLBACK_FREE_ALL_GUESTS);
}

/** The event pass itself: the smallest tier that still holds the guest count.
 *
 *  A count past the largest tier falls back to that tier's price rather than to zero — the server
 *  answers `tier: 'custom'` there and the form says "contact us", and a quiet $0 in the meantime
 *  would read as "your 1000-guest event is free". */
export function guestBaseCents(billing: BillingConfig | null, guests: number): number {
  if (featuresFreeAt(billing, guests)) return 0;
  const tiers = billing?.paidTiers ?? [];
  const t = tiers.find((x) => guests <= x.maxGuests);
  return t ? t.amountCents : (tiers[tiers.length - 1]?.amountCents ?? 0);
}

/** List price of a shot count, before any guest-count waiver. */
export function shotsAddonCents(billing: BillingConfig | null, shots: number): number {
  const t = (billing?.shotsTiers ?? []).find((x) => shots <= x.maxShots);
  return t ? t.amountCents : 0;
}

/** List price of a clip length. Matched on the exact length because the video tiers are a menu of
 *  lengths, not a ladder of caps — 45s is not "the 60s tier", it is not on sale. */
export function videoAddonCents(billing: BillingConfig | null, seconds: number): number {
  const a = (billing?.videoAddons ?? []).find((v) => v.seconds === seconds);
  return a ? a.amountCents : 0;
}

/** List price of an event length. */
export function durationAddonCents(billing: BillingConfig | null, hours: number): number {
  const t = (billing?.durationTiers ?? []).find((x) => hours <= x.maxHours);
  return t ? t.amountCents : 0;
}

/** A list price read through this event's guest count. */
function priceAt(cents: number, freeAtSize: boolean): FeaturePrice {
  if (cents <= 0) return { kind: 'included' };
  return freeAtSize ? { kind: 'gift', wouldBeCents: cents } : { kind: 'paid', cents };
}

export function shotsPrice(billing: BillingConfig | null, shots: number, guests: number): FeaturePrice {
  if (shots <= (billing?.shotsFree ?? FALLBACK_SHOTS_FREE)) return { kind: 'included' };
  return priceAt(shotsAddonCents(billing, shots), featuresFreeAt(billing, guests));
}

/** No video is not a cheaper video — it is the absence of the feature, and it costs nothing on any
 *  event, so it must not be dressed as a gift on small ones. */
export function videoPrice(billing: BillingConfig | null, seconds: number, guests: number): FeaturePrice {
  if (seconds <= 0) return { kind: 'included' };
  return priceAt(videoAddonCents(billing, seconds), featuresFreeAt(billing, guests));
}

export function framePackPrice(billing: BillingConfig | null, guests: number): FeaturePrice {
  return priceAt(billing?.framePackCents ?? 0, featuresFreeAt(billing, guests));
}

/** Days of retention the event already has before anything is bought.
 *
 *  Retention runs the OPPOSITE way to every other add-on: a free event pays past a week, a paid one
 *  has a month included. So the guest count still decides the answer, just not by the usual rule,
 *  and a host who reads "everything is free under 10 guests" and assumes that covers keeping the
 *  photos for a year is being misled. */
export function retentionIncludedDays(billing: BillingConfig | null, guests: number): number {
  if (!billing) return FALLBACK_RETENTION_FREE_DAYS;
  return featuresFreeAt(billing, guests)
    ? (billing.retentionFreeDays ?? FALLBACK_RETENTION_FREE_DAYS)
    : (billing.retentionPaidDays ?? FALLBACK_RETENTION_PAID_DAYS);
}

/** Plain words for a retention length. The tier table speaks in days because the purge job does;
 *  nobody planning a wedding thinks in 182s. */
export function retentionLabel(days: number): string {
  if (days <= 7) return '1 week';
  if (days <= 31) return '1 month';
  if (days <= 92) return '3 months';
  if (days <= 182) return '6 months';
  return '1 year';
}

/** `included` marks a tier that has a real price but is already covered by this event's allowance —
 *  distinct from a tier that is simply free, which is why it is not just `amountCents === 0`. */
export type RetentionChoice = { days: number; amountCents: number; label: string; included: boolean };

/** The retention lengths worth offering, cheapest first.
 *
 *  Tiers shorter than what the event already gets are dropped rather than shown greyed out: a paid
 *  event offered "1 week" will eventually have someone pick it, and they would be asking us to keep
 *  their photos for less time than they have already paid for. */
export function retentionChoices(billing: BillingConfig | null, guests: number): RetentionChoice[] {
  const includedDays = retentionIncludedDays(billing, guests);
  return (billing?.retentionTiers ?? [])
    .filter((t) => t.maxDays >= includedDays)
    .map((t) => {
      const covered = t.maxDays <= includedDays;
      return {
        days: t.maxDays,
        amountCents: covered ? 0 : t.amountCents,
        label: retentionLabel(t.maxDays),
        included: covered && t.amountCents > 0,
      };
    });
}

/** Retention is never a `gift`: the guest-count waiver does not reach it, and a struck-through price
 *  beside a length the host is genuinely about to be charged for would be a lie. */
export function retentionPrice(choice: RetentionChoice): FeaturePrice {
  return choice.amountCents > 0 ? { kind: 'paid', cents: choice.amountCents } : { kind: 'included' };
}

/** The little price beside a choice, as text plus the class that styles it.
 *
 *  `was` is the page's existing struck-through-green convention for "you would pay this, and you are
 *  not". The money formatter is passed in rather than imported so this module never has an opinion
 *  about currency — that belongs with the server config, not with a layout helper. */
export type PriceTag = { text: string; cls: 'incl' | 'was' | 'add' };

export function priceTag(
  price: FeaturePrice,
  money: (cents: number) => string,
  includedText = 'free',
): PriceTag {
  if (price.kind === 'gift') return { text: `+${money(price.wouldBeCents)}`, cls: 'was' };
  if (price.kind === 'paid') return { text: `+${money(price.cents)}`, cls: 'add' };
  return { text: includedText, cls: 'incl' };
}

/** The same price spoken aloud.
 *
 *  A struck-through "+$5" is clear enough to look at and says nothing at all to a screen reader,
 *  which reads it as the plain price — i.e. tells a host they are being charged for their gift. */
export function priceAria(
  price: FeaturePrice,
  money: (cents: number) => string,
  includedText = 'free',
): string {
  if (price.kind === 'gift') return `normally ${money(price.wouldBeCents)} — free on your event`;
  if (price.kind === 'paid') return `plus ${money(price.cents)}`;
  return includedText;
}

/**
 * What the retention control should read after the guest count moves.
 *
 * The form used to carry a one-way ratchet: `if (retentionDays < included) retentionDays = included`.
 * It solved the upgrade — a paid tier includes a month, and without it the host was left asking for
 * the week they had just paid to beat — and created the opposite fault going the other way. Free →
 * paid → free left 31 days standing, and 31 days on the free tier is a CHARGEABLE add-on, so the
 * host was quoted for an upgrade nobody asked for. The tier had picked it; the tier never put it
 * back.
 *
 * So the answer depends on who chose the number:
 *
 *  · nobody did (`touched` false) — the value is just the tier's allowance wearing a number, and it
 *    follows the allowance in BOTH directions. Going back to free goes back to free.
 *  · the host did — their choice stands, and is only ever raised to meet an allowance that has
 *    overtaken it. Somebody who deliberately bought a year does not lose it by editing their guest
 *    count, and never silently drops BELOW what their tier already includes.
 */
export function retentionFor(current: number, included: number, touched: boolean): number {
  if (!touched) return included;
  return current < included ? included : current;
}

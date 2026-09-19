import Stripe from 'stripe';

// ── Env-gated billing ─────────────────────────────────────────────────────────
// Billing is OFF unless a Stripe secret key is configured. This is the self-host
// default: no charges, no "Pro" UI, unlimited use (organizers can still set their own
// per-event caps). When STRIPE_SECRET_KEY is present (hosted), billing switches on.
// Keep ALL billing logic in this module / the billing route so the paid side is cleanly
// separable, even though it ships in the same codebase.
export const billingEnabled = !!process.env.STRIPE_SECRET_KEY;

export const stripe: Stripe | null = billingEnabled
  ? new Stripe(process.env.STRIPE_SECRET_KEY as string)
  : null;

// Default AUD, matching the tier amounts below: PAID_TIERS et al are hardcoded AUD figures
// (500 = A$5 … 5900 = A$59). Defaulting to USD charged those same numbers as dollars, i.e. a ~55%
// unintended price rise for any self-hoster who never set this. The comment already claimed AUD;
// the code did not. Set BILLING_CURRENCY explicitly for any other currency AND re-check the tiers.
export const CURRENCY = (process.env.BILLING_CURRENCY || 'aud').toLowerCase();

// ── Pricing model (per-event one-off pass) ────────────────────────────────────
// ≤10 guests → free, every feature included · paid from 11, base scales by guest count + opt-in
// add-ons. (No in-between "limited" tier — it was too small a band to be worth the extra rules.)
export const FREE_ALL_GUESTS = 10;        // ≤ this → free, every feature (incl. video, frames, shots)

// Paid base passes (one-off, in BILLING_CURRENCY cents — default AUD). Smallest tier whose
// cap ≥ requested guests applies. Set to undercut competitors, whose prices are USD — so in
// AUD we're further below after FX (A$5 ≈ US$3.30 vs Lense US$4.99; A$59 ≈ US$39 vs Scene
// US$99.99 / Hipstamatic US$200). Self-hosted ZFS storage ⇒ marginal cost ≈ Stripe's ~3%.
// `videoMul` scales the VIDEO add-on with the size of the event, and only the video add-on.
//
// Everything else here is a flat fee, which is right for everything else: a frame pack is a setting,
// an event's length is the same length whoever is at it, and guests demonstrably do not fill their
// rolls (production: the most anyone has ever shot is 18 of 24), so photos self-limit. Video does
// not. A 90-second clip is roughly fifty megabytes, every guest can record one, and it is held for
// the whole retention window — so the cost of that add-on is guests × seconds, and we were charging
// for seconds alone. The same $24 bought 25 clips on a small event and 400 on a big one: 16× the
// storage for the same money, which worked out at $23.76 a gigabyte at the bottom and $4.25 at the
// top. The heaviest events were getting the deepest discount on the heaviest thing they do.
//
// Deliberately GENTLE — 1× / 1.25× / 1.75× / 2.25× against a 16× spread in what is stored. The
// point is to stop the biggest events being subsidised, not to price them out: at every rung this
// still lands well under the nearest competitor (13–38% cheaper with video on), and being cheaper
// is the position. Rounded to whole dollars in videoCentsFor, because a host reads the rung.
export const PAID_TIERS = [
  { maxGuests: 25,  amountCents: 500,  videoMul: 1 },      // A$5
  { maxGuests: 60,  amountCents: 1500, videoMul: 1.25 },   // A$15
  { maxGuests: 150, amountCents: 2900, videoMul: 1.75 },   // A$29
  { maxGuests: 400, amountCents: 5900, videoMul: 2.25 },   // A$59
] as const;

/** What a clip length costs on an event of this size, to the dollar. */
export function videoCentsFor(seconds: number, guests: number): number {
  const addon = VIDEO_ADDONS.find((v) => v.seconds === seconds);
  if (!addon) return 0;
  const tier = PAID_TIERS.find((t) => guests <= t.maxGuests) ?? PAID_TIERS[PAID_TIERS.length - 1];
  return Math.round((addon.amountCents * tier.videoMul) / 100) * 100;
}

/**
 * The largest guest count the ladder can actually price.
 *
 * Above it, quote() returns tier 'custom' — which is a REFERRAL, not a purchase. That branch has
 * baseCents 0 and no add-on charges, so `requiresPayment` comes back false, and a caller that reads
 * "requires no payment" as "is paid for" hands out an event bigger than the A$59 tier, with video
 * and every frame shape, for nothing. Both the create and upgrade routes therefore refuse a
 * 'custom' quote outright rather than entitling it. The pricing UI never offers a number this high;
 * only a hand-made API call reaches it.
 *
 * Guests are not the only ladder with a top: see MAX_QUOTABLE_HOURS and MAX_QUOTABLE_DAYS, which
 * are refused the same way and for the same reason. Every tierFor() helper below falls back to its
 * LAST rung, so anything off the top of any of them was priced at that rung and entitled at the
 * number asked for.
 */
export const MAX_QUOTABLE_GUESTS = PAID_TIERS[PAID_TIERS.length - 1].maxGuests;

/** What both routes say when a configuration is off the top of the ladder. */
export const CUSTOM_PLAN_ERROR =
  `Events over ${MAX_QUOTABLE_GUESTS} guests need a custom plan — please contact us at support@snapdini.com.`;

// ── Add-ons (paid events only; all included free on the ≤10 tier) ──
// Shots-per-person: ≤12 free; more is a tiered add-on (smallest tier whose cap ≥ requested).
export const SHOTS_FREE = 12;
// The one ladder that is deliberately PROGRESSIVE: the marginal price of a dozen shots never falls,
// and rises past 48.
//
// Guests are a volume discount because a bigger event costs us almost nothing extra — the same event
// row, the same gallery. A shot is not like that: every one is a file we store, transcode a
// thumbnail for and serve for the whole retention window, so the cost is genuinely per-shot and the
// heaviest rolls should not be the cheapest per photo.
//
// It also used to sag in the middle. Marginal cost per 12-shot block ran $3, $2, $3 — 36 shots were
// cheaper per photo than either neighbour, for no reason anyone could state. Now it is a flat $3 a
// dozen to 48, then steps up, which is one sentence to explain.
// Priced by the DOZEN, and the dozens get dearer as the roll gets longer.
//
// The first three are flat at $3 because that range is the ordinary event — a dinner, a ceremony,
// a party — and nobody should feel they are being charged a premium for a normal number of photos.
// Past that the marginal dozen climbs ($4, $5, $6, $7, $8, $9), which is the honest shape: a
// 120-shot roll is not ten times a 12-shot roll in what it costs us to hold, but it IS the tail
// where storage, retention and the slideshow all grow, and a flat rate there prices the common case
// to subsidise the rare one.
//
// Production evidence, for whoever reads this next: as of the 1.5.0 work no guest had ever filled a
// roll at any limit (best was 18 of 24), and 48 had been chosen once. These upper rungs exist so a
// host who wants them is not stopped, not because anyone is expected to need them.
export const SHOTS_TIERS = [
  { maxShots: 12, amountCents: 0 },      // included
  { maxShots: 24, amountCents: 300 },    // +$3   ($3 / dozen)
  { maxShots: 36, amountCents: 600 },    // +$6   ($3 / dozen)
  { maxShots: 48, amountCents: 900 },    // +$9   ($3 / dozen)
  { maxShots: 60, amountCents: 1300 },   // +$13  ($4 / dozen)
  { maxShots: 72, amountCents: 1800 },   // +$18  ($5 / dozen)
  { maxShots: 84, amountCents: 2400 },   // +$24  ($6 / dozen)
  { maxShots: 96, amountCents: 3100 },   // +$31  ($7 / dozen)
  { maxShots: 108, amountCents: 3900 },  // +$39  ($8 / dozen)
  { maxShots: 120, amountCents: 4800 },  // +$48  ($9 / dozen)
] as const;
/** The most shots-per-guest the ladder can sell.
 *
 *  Unlike guests/duration/retention this is CLAMPED TO, not refused: 48 is a real rung with a real
 *  price, and shotsTierFor() already charges it for any larger request, so the only thing wrong
 *  was the allowance handed back. quote() therefore returns this cap and never the number asked
 *  for — `maxPhotos: 1000000` used to come straight back out of quote() and get written to the
 *  event by the upgrade route, i.e. an unlimited roll for the top rung's $8. */
export const MAX_QUOTABLE_SHOTS = SHOTS_TIERS[SHOTS_TIERS.length - 1].maxShots;

// Frame-sizes pack: unlock any non-1:1 aspect ratios (organizer opts in to which). One flat fee.
export const FRAME_PACK_CENTS = 500;    // $5

// Slideshow "remove the Snapdini intro/outro frames" add-on. A small one-off ($1 for now). Always
// paid — even for ≤10-guest free events — UNLESS the event has already spent over $50, then free.
// Removing the Snapdini intro/outro frames is ALWAYS a paid add-on on hosted plans, regardless of
// event size or how much has been spent. Self-host (billing off) gets it free like everything else.
// $5. At $1 this was barely worth processing: Stripe AU on an international card is ~3.5% + $0.30,
// which on a dollar is ~33% of the sale. At $5 the fee is under 10%, and it sits level with the
// frame pack rather than reading as an afterthought.
export const BRANDING_REMOVAL_CENTS = 500;            // $5
export function brandingRemovable(ev: { brandingRemovalPaid?: boolean | null }): boolean {
  if (!billingEnabled) return true;            // self-host: everything is free (no payment rail)
  return !!ev.brandingRemovalPaid;             // hosted: only once the add-on has been bought
}

// Video add-on (one-off, cents).
// Priced by the SECOND, and the later seconds are dearer — the same shape as SHOTS_TIERS, and for a
// stronger reason.
//
// The old ladder ran the other way and nobody had noticed: $2 / $5 / $8 / $12 works out at 20¢,
// 16.7¢, 13.3¢, 13.3¢ a second, so the longest clips were the CHEAPEST per second we sold. That is
// backwards for the most expensive thing in the product to carry. A photo is one file; a clip is
// the original, a playback proxy we transcode, a share of every slideshow encode, and all of it
// held for the whole retention window. Ninety seconds per guest across a 400-guest event is the
// single biggest thing this product can be asked to store, and it was being discounted for volume.
//
// Now: 20¢ a second up to half a minute — the range most events actually use, priced flatly so a
// short clip is never a premium — then climbing hard. 60s is where a clip stops being a moment and
// starts being footage, and it is the rung where the storage curve turns, so it takes the first
// real step up (26.7¢/s) rather than a gentle one. The prices land on round numbers on purpose
// ($2 / $6 / $14 / $24, so the steps are +$4, +$8, +$10), because a host reads the rung, not the
// rate.
//
// Events already paid for are NOT re-billed by this. quote() prices what an event already holds at
// today's prices and the upgrade route bills the difference against `Math.max(covered, amountPaid)`
// — the floor exists precisely so a price change is never retroactive. See the `coveredCents` note
// in routes/billing.ts.
export const VIDEO_ADDONS = [
  { seconds: 10, amountCents: 200 },   // $2   (20¢/s)
  { seconds: 30, amountCents: 600 },   // $6   (+$4 over 20s — 20¢/s)
  { seconds: 60, amountCents: 1400 },  // $14  (+$8 over 30s — 26.7¢/s)
  { seconds: 90, amountCents: 2400 },  // $24  (+$10 over 30s — 33.3¢/s)
] as const;

// Duration add-on (one-off, cents). Up to 2 days included; longer events scale.
export const DURATION_FREE_HOURS = 48;
export const DURATION_TIERS = [
  { maxHours: 48,   amountCents: 0 },     // up to 2 days — included
  { maxHours: 72,   amountCents: 200 },   // 3 days — +$2
  { maxHours: 168,  amountCents: 500 },   // up to 1 week — +$5
  // NOTE: this tier is a PRICE CUT for the 169–336h band, which previously fell into the 720h tier
  // and was charged $10 — a fortnight cost the same as a full month, which is why nobody would pick
  // it even if the option had existed. $7 sits between the week and the month; change the number
  // freely, it is a product decision and nothing else reads it.
  { maxHours: 336,  amountCents: 700 },   // 2 weeks — +$7
  { maxHours: 720,  amountCents: 1000 },  // 1 month — +$10
  { maxHours: 2160, amountCents: 2500 },  // 3 months — +$25
] as const;
// The old top tier was a YEAR-long window for $10. Nobody runs a year-long event, and it was not
// even offered in the create form (the options list stopped at 1 week), so it was dead weight that
// also under-priced the genuinely long windows. 1 month and 3 months are the real long-tail cases
// (exhibitions, touring shows, season-long clubs), and they now cost what the storage warrants.

/** The longest event the ladder can price; above it, tier 'custom'.
 *
 *  The worst of the three ceilings to leave open, because duration is not just an allowance: the
 *  upgrade route writes expiresAt from the request, and purgeAt is computed from expiresAt. A
 *  `durationHours: 100000` upgrade was charged the 3-month rung ($25) and given an event that
 *  expires in 2037 — which no purge sweep ever reaches, so the storage is ours forever. */
export const MAX_QUOTABLE_HOURS = DURATION_TIERS[DURATION_TIERS.length - 1].maxHours;

// Retention add-on (one-off, cents). Standard 1 week kept free; longer costs (storage).
export const RETENTION_FREE_DAYS = 7;
// Paid events include a full month (31 days) as standard. A 7-day default on a memories product is a landmine:
// anyone who does not notice the add-on can genuinely lose their photos, which is far worse than
// the lost upsell. A month is generous enough to cover "we'll grab them next weekend" without
// committing us to a year of storage for every event.
export const RETENTION_PAID_DAYS = 31;
export const RETENTION_TIERS = [
  { maxDays: 7,   amountCents: 0 },       // 1 week — included on free events
  // "1 month" is deliberately the GENEROUS month: 31 days retained, so the purge lands on the
  // 32nd day. Kept exactly equal to RETENTION_PAID_DAYS so a paid event picking "1 month" is never
  // charged an add-on for a day or two beyond its included allowance — that reads as a bug.
  { maxDays: 31,  amountCents: 300 },     // 1 month — +$3 (included on paid events)
  { maxDays: 92,  amountCents: 800 },     // 3 months — +$8
  { maxDays: 182, amountCents: 1200 },    // 6 months — +$12
  { maxDays: 365, amountCents: 2000 },    // 1 year — +$20
] as const;
/** The longest retention the ladder can price; above it, tier 'custom'. Same fallback trap as
 *  duration — retentionTierFor() would otherwise sell a decade of storage at the 1-year price. */
export const MAX_QUOTABLE_DAYS = RETENTION_TIERS[RETENTION_TIERS.length - 1].maxDays;

// Three messages rather than one, because the only job a refusal has is to name the number the
// organizer can change. Somebody who asked for a 100,000-hour event and is told "events over 400
// guests need a custom plan" reads it as our pricing page being broken, and asks for neither.
// (Declared here, not beside CUSTOM_PLAN_ERROR: they interpolate ladders defined further down.)
export const CUSTOM_DURATION_ERROR =
  `Events longer than ${Math.round(MAX_QUOTABLE_HOURS / 24)} days need a custom plan — please contact us at support@snapdini.com.`;
export const CUSTOM_RETENTION_ERROR =
  `Keeping photos longer than ${MAX_QUOTABLE_DAYS} days needs a custom plan — please contact us at support@snapdini.com.`;

export type Tier = 'free' | 'paid' | 'custom';
/** WHICH ladder a 'custom' quote fell off. Drives the refusal message; see customPlanError(). */
export type CustomReason = 'guests' | 'duration' | 'retention';
export interface QuoteInput {
  maxGuests: number;
  maxPhotos?: number;          // shots per person (default 12)
  aspectRatios?: string[];     // requested frame sizes; anything besides '1:1' needs the frame pack
  videoSeconds?: number;       // 0 = no video
  durationHours?: number;      // event length; >24h is an add-on
  retentionDays?: number;      // how long photos are kept; >7d is an add-on
}
export interface Quote {
  maxGuests: number;
  maxPhotos: number;
  aspectRatios: string[];
  videoSeconds: number;
  durationHours: number;
  retentionDays: number;
  tier: Tier;
  customReason: CustomReason | null;   // why no rung fits (tier 'custom'); null on any priced quote
  baseCents: number;           // guest-tier event pass
  shotsCents: number;          // extra-shots add-on
  frameCents: number;          // frame-sizes pack
  videoCents: number;          // video add-on
  durationCents: number;       // longer-event add-on
  retentionCents: number;      // longer-retention add-on
  amountCents: number;         // total
  requiresPayment: boolean;
  framePack: boolean;          // did the config buy the frame pack?
  features: { video: boolean; aspects: 'all' | 'square' };
  notes: string[];             // human-friendly UI notes (why something is unavailable)
}

/** The refusal message for a quote no rung can price. One place, so the create route, the upgrade
 *  route and the settings re-quote all say the same thing about the same limit. */
export function customPlanError(q: Pick<Quote, 'customReason'>): string {
  switch (q.customReason) {
    case 'duration':  return CUSTOM_DURATION_ERROR;
    case 'retention': return CUSTOM_RETENTION_ERROR;
    default:          return CUSTOM_PLAN_ERROR;
  }
}

const hasNonSquare = (aspects: string[]) => aspects.some((a) => a && a !== '1:1');
const shotsTierFor = (shots: number) =>
  SHOTS_TIERS.find((t) => shots <= t.maxShots) ?? SHOTS_TIERS[SHOTS_TIERS.length - 1];
const durationTierFor = (hours: number) =>
  DURATION_TIERS.find((t) => hours <= t.maxHours) ?? DURATION_TIERS[DURATION_TIERS.length - 1];
const retentionTierFor = (days: number) =>
  RETENTION_TIERS.find((t) => days <= t.maxDays) ?? RETENTION_TIERS[RETENTION_TIERS.length - 1];
// Included allowance depends on the tier: free events get 7 days, paid events 30. Anything at or
// below the allowance costs nothing; only genuine upgrades are charged.
const retentionCentsFor = (days: number, includedDays: number) =>
  days <= includedDays ? 0 : retentionTierFor(days).amountCents;

/** Compute the price + feature set for an event configuration. Pure — no Stripe calls.
 * Model: guest tiers gate the FEATURES (shots/frames/video are free for ≤10 guests, paid from 11).
 * Duration (>1 day) and retention (>1 week) are ALWAYS chargeable add-ons, independent of guest
 * count — they're the only things that cost money on a small event. */
export function quote(input: QuoteInput): Quote {
  const g = Math.max(1, Math.floor(input.maxGuests || 1));
  const reqShots = Math.max(1, Math.floor(input.maxPhotos || SHOTS_FREE));
  // The ENTITLED shot count: the rung's cap, never the number asked for. See MAX_QUOTABLE_SHOTS.
  const shots = Math.min(reqShots, MAX_QUOTABLE_SHOTS);
  const reqAspects = (input.aspectRatios && input.aspectRatios.length ? input.aspectRatios : ['1:1']);
  const videoSeconds = Math.max(0, Math.floor(input.videoSeconds || 0));
  const durationHours = Math.max(1, Math.floor(input.durationHours || DURATION_FREE_HOURS));
  const retentionDays = Math.max(1, Math.floor(input.retentionDays || RETENTION_FREE_DAYS));
  const notes: string[] = [];

  // Always-charged add-ons (independent of the guest tier).
  const durationCents = durationTierFor(durationHours).amountCents;
  // Charged against the allowance for the branch we end up in (set below), not a flat ladder.
  const retentionCentsFree = retentionCentsFor(retentionDays, RETENTION_FREE_DAYS);
  const retentionCentsPaid = retentionCentsFor(retentionDays, RETENTION_PAID_DAYS);

  // Finalize a quote: sum every component, derive amount + requiresPayment.
  const finalize = (q: Omit<Quote, 'amountCents' | 'requiresPayment'>): Quote => {
    const amountCents = q.baseCents + q.shotsCents + q.frameCents + q.videoCents + q.durationCents + q.retentionCents;
    return { ...q, amountCents, requiresPayment: amountCents > 0 };
  };

  // ── Off the top of ANY ladder → 'custom': a referral, not a price ──
  // Checked before the free branch on purpose. Duration and retention are charged independently of
  // guest count, so a ≤10-guest event is exactly where an off-the-ladder duration did its damage:
  // nothing to pay, and an expiresAt the purge never reaches.
  //
  // Refused rather than clamped, matching how POST /api/events already treats guests: handing back
  // a 3-month event to somebody who asked for eleven years, with a 200 and no explanation, is a
  // lie they only discover when the photos vanish. A refusal names the limit while they can still
  // choose a different one. (Shots are the deliberate exception — see MAX_QUOTABLE_SHOTS.)
  const customReason: CustomReason | null =
    g > MAX_QUOTABLE_GUESTS ? 'guests'
      : durationHours > MAX_QUOTABLE_HOURS ? 'duration'
        : retentionDays > MAX_QUOTABLE_DAYS ? 'retention'
          : null;
  if (customReason) {
    notes.push(
      customReason === 'guests'   ? `Over ${MAX_QUOTABLE_GUESTS} guests — contact us for a custom plan.`
      : customReason === 'duration' ? `Longer than ${Math.round(MAX_QUOTABLE_HOURS / 24)} days — contact us for a custom plan.`
      : `Kept longer than ${MAX_QUOTABLE_DAYS} days — contact us for a custom plan.`,
    );
    // Every component zero, so amountCents is 0 and requiresPayment false: there is genuinely
    // nothing to charge here. Duration/retention used to keep their (top-rung) prices in this
    // branch, which meant a quote we refuse to sell could still report requiresPayment true and be
    // mistaken for a priced configuration.
    return finalize({
      maxGuests: g, maxPhotos: shots, aspectRatios: reqAspects, videoSeconds, durationHours, retentionDays,
      tier: 'custom', customReason, baseCents: 0, shotsCents: 0, frameCents: 0, videoCents: 0,
      durationCents: 0, retentionCents: 0,
      framePack: hasNonSquare(reqAspects), features: { video: true, aspects: 'all' }, notes,
    });
  }

  // ── ≤10 guests: every FEATURE free (video/frames/up to 48 shots). Duration/retention still charge. ──
  if (g <= FREE_ALL_GUESTS) {
    return finalize({
      maxGuests: g, maxPhotos: shots, aspectRatios: reqAspects, videoSeconds, durationHours, retentionDays,
      tier: 'free', customReason: null, baseCents: 0, shotsCents: 0, frameCents: 0, videoCents: 0, durationCents, retentionCents: retentionCentsFree,
      framePack: hasNonSquare(reqAspects), features: { video: true, aspects: 'all' }, notes,
    });
  }

  // ── 11+ guests: paid base + opt-in add-ons. ──
  // g > MAX_QUOTABLE_GUESTS already returned 'custom' above, so a rung always exists; the fallback
  // is there to keep this honest for a type-checker rather than to be reached.
  const paidTier = PAID_TIERS.find((t) => g <= t.maxGuests) ?? PAID_TIERS[PAID_TIERS.length - 1];

  const framePack = hasNonSquare(reqAspects);
  const addon = videoSeconds > 0 ? VIDEO_ADDONS.find((v) => v.seconds === videoSeconds) : undefined;
  if (videoSeconds > 0 && !addon) notes.push('Unknown video length — pick 10, 30, 60 or 90s.');
  return finalize({
    maxGuests: g, maxPhotos: shots, aspectRatios: reqAspects, videoSeconds: addon ? videoSeconds : 0, durationHours, retentionDays,
    tier: 'paid', customReason: null, baseCents: paidTier.amountCents, shotsCents: shotsTierFor(shots).amountCents,
    frameCents: framePack ? FRAME_PACK_CENTS : 0, videoCents: addon ? videoCentsFor(videoSeconds, g) : 0, durationCents,
    retentionCents: retentionCentsPaid,
    framePack, features: { video: !!addon, aspects: 'all' }, notes,
  });
}

// What the frontend needs (exposed via /api/config). Never leak secret keys.
export function publicBillingConfig() {
  return {
    billingEnabled,
    currency: CURRENCY,
    freeAllGuests: FREE_ALL_GUESTS,
    paidTiers: PAID_TIERS,
    shotsFree: SHOTS_FREE,
    shotsTiers: SHOTS_TIERS,
    framePackCents: FRAME_PACK_CENTS,
    videoAddons: VIDEO_ADDONS,
    durationFreeHours: DURATION_FREE_HOURS,
    durationTiers: DURATION_TIERS,
    retentionFreeDays: RETENTION_FREE_DAYS,
    retentionPaidDays: RETENTION_PAID_DAYS,
    retentionTiers: RETENTION_TIERS,
  };
}

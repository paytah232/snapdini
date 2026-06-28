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

export const CURRENCY = (process.env.BILLING_CURRENCY || 'usd').toLowerCase();

// ── Pricing model (per-event one-off pass) ────────────────────────────────────
// ≤10 guests → free, every feature included · paid from 11, base scales by guest count + opt-in
// add-ons. (No in-between "limited" tier — it was too small a band to be worth the extra rules.)
export const FREE_ALL_GUESTS = 10;        // ≤ this → free, every feature (incl. video, frames, shots)

// Paid base passes (one-off, in BILLING_CURRENCY cents — default AUD). Smallest tier whose
// cap ≥ requested guests applies. Set to undercut competitors, whose prices are USD — so in
// AUD we're further below after FX (A$5 ≈ US$3.30 vs Lense US$4.99; A$59 ≈ US$39 vs Scene
// US$99.99 / Hipstamatic US$200). Self-hosted ZFS storage ⇒ marginal cost ≈ Stripe's ~3%.
export const PAID_TIERS = [
  { maxGuests: 25,  amountCents: 500 },   // A$5
  { maxGuests: 60,  amountCents: 1500 },  // A$15
  { maxGuests: 150, amountCents: 2900 },  // A$29
  { maxGuests: 400, amountCents: 5900 },  // A$59
] as const;

// ── Add-ons (paid events only; all included free on the ≤10 tier) ──
// Shots-per-person: ≤12 free; more is a tiered add-on (smallest tier whose cap ≥ requested).
export const SHOTS_FREE = 12;
export const SHOTS_TIERS = [
  { maxShots: 12, amountCents: 0 },     // included
  { maxShots: 24, amountCents: 300 },   // +$3
  { maxShots: 36, amountCents: 500 },   // +$5
  { maxShots: 48, amountCents: 800 },   // +$8
] as const;

// Frame-sizes pack: unlock any non-1:1 aspect ratios (organizer opts in to which). One flat fee.
export const FRAME_PACK_CENTS = 500;    // $5

// Slideshow "remove the Snapdini intro/outro frames" add-on. A small one-off ($1 for now). Always
// paid — even for ≤10-guest free events — UNLESS the event has already spent over $50, then free.
// Removing the Snapdini intro/outro frames is ALWAYS a paid add-on on hosted plans, regardless of
// event size or how much has been spent. Self-host (billing off) gets it free like everything else.
export const BRANDING_REMOVAL_CENTS = 100;            // $1
export function brandingRemovable(ev: { brandingRemovalPaid?: boolean | null }): boolean {
  if (!billingEnabled) return true;            // self-host: everything is free (no payment rail)
  return !!ev.brandingRemovalPaid;             // hosted: only once the add-on has been bought
}

// Video add-on (one-off, cents).
export const VIDEO_ADDONS = [
  { seconds: 10, amountCents: 200 },   // $2
  { seconds: 30, amountCents: 500 },   // $5
  { seconds: 60, amountCents: 800 },   // $8
  { seconds: 90, amountCents: 1200 },  // $12
] as const;

// Duration add-on (one-off, cents). Up to 2 days included; longer events scale.
export const DURATION_FREE_HOURS = 48;
export const DURATION_TIERS = [
  { maxHours: 48,   amountCents: 0 },     // up to 2 days — included
  { maxHours: 72,   amountCents: 200 },   // 3 days — +$2
  { maxHours: 168,  amountCents: 500 },   // up to 1 week — +$5
  { maxHours: 8760, amountCents: 1000 },  // longer — +$10
] as const;

// Retention add-on (one-off, cents). Standard 1 week kept free; longer costs (storage).
export const RETENTION_FREE_DAYS = 7;
export const RETENTION_TIERS = [
  { maxDays: 7,   amountCents: 0 },       // 1 week — included
  { maxDays: 31,  amountCents: 300 },     // 1 month — +$3
  { maxDays: 92,  amountCents: 800 },     // 3 months — +$8
  { maxDays: 365, amountCents: 1500 },    // 1 year — +$15
] as const;

export type Tier = 'free' | 'paid' | 'custom';
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

const hasNonSquare = (aspects: string[]) => aspects.some((a) => a && a !== '1:1');
const shotsTierFor = (shots: number) =>
  SHOTS_TIERS.find((t) => shots <= t.maxShots) ?? SHOTS_TIERS[SHOTS_TIERS.length - 1];
const durationTierFor = (hours: number) =>
  DURATION_TIERS.find((t) => hours <= t.maxHours) ?? DURATION_TIERS[DURATION_TIERS.length - 1];
const retentionTierFor = (days: number) =>
  RETENTION_TIERS.find((t) => days <= t.maxDays) ?? RETENTION_TIERS[RETENTION_TIERS.length - 1];

/** Compute the price + feature set for an event configuration. Pure — no Stripe calls.
 * Model: guest tiers gate the FEATURES (shots/frames/video are free for ≤10 guests, paid from 11).
 * Duration (>1 day) and retention (>1 week) are ALWAYS chargeable add-ons, independent of guest
 * count — they're the only things that cost money on a small event. */
export function quote(input: QuoteInput): Quote {
  const g = Math.max(1, Math.floor(input.maxGuests || 1));
  const reqShots = Math.max(1, Math.floor(input.maxPhotos || SHOTS_FREE));
  const reqAspects = (input.aspectRatios && input.aspectRatios.length ? input.aspectRatios : ['1:1']);
  const videoSeconds = Math.max(0, Math.floor(input.videoSeconds || 0));
  const durationHours = Math.max(1, Math.floor(input.durationHours || DURATION_FREE_HOURS));
  const retentionDays = Math.max(1, Math.floor(input.retentionDays || RETENTION_FREE_DAYS));
  const notes: string[] = [];

  // Always-charged add-ons (independent of the guest tier).
  const durationCents = durationTierFor(durationHours).amountCents;
  const retentionCents = retentionTierFor(retentionDays).amountCents;

  // Finalize a quote: sum every component, derive amount + requiresPayment.
  const finalize = (q: Omit<Quote, 'amountCents' | 'requiresPayment'>): Quote => {
    const amountCents = q.baseCents + q.shotsCents + q.frameCents + q.videoCents + q.durationCents + q.retentionCents;
    return { ...q, amountCents, requiresPayment: amountCents > 0 };
  };

  // ── ≤10 guests: every FEATURE free (video/frames/up to 48 shots). Duration/retention still charge. ──
  if (g <= FREE_ALL_GUESTS) {
    return finalize({
      maxGuests: g, maxPhotos: reqShots, aspectRatios: reqAspects, videoSeconds, durationHours, retentionDays,
      tier: 'free', baseCents: 0, shotsCents: 0, frameCents: 0, videoCents: 0, durationCents, retentionCents,
      framePack: hasNonSquare(reqAspects), features: { video: true, aspects: 'all' }, notes,
    });
  }

  // ── 11+ guests: paid base + opt-in add-ons. ──
  const paidTier = PAID_TIERS.find((t) => g <= t.maxGuests);
  if (!paidTier) {
    notes.push(`Over ${PAID_TIERS[PAID_TIERS.length - 1].maxGuests} guests — contact us for a custom plan.`);
    return finalize({
      maxGuests: g, maxPhotos: reqShots, aspectRatios: reqAspects, videoSeconds, durationHours, retentionDays,
      tier: 'custom', baseCents: 0, shotsCents: 0, frameCents: 0, videoCents: 0, durationCents, retentionCents,
      framePack: hasNonSquare(reqAspects), features: { video: true, aspects: 'all' }, notes,
    });
  }

  const framePack = hasNonSquare(reqAspects);
  const addon = videoSeconds > 0 ? VIDEO_ADDONS.find((v) => v.seconds === videoSeconds) : undefined;
  if (videoSeconds > 0 && !addon) notes.push('Unknown video length — pick 10, 30, 60 or 90s.');
  return finalize({
    maxGuests: g, maxPhotos: reqShots, aspectRatios: reqAspects, videoSeconds: addon ? videoSeconds : 0, durationHours, retentionDays,
    tier: 'paid', baseCents: paidTier.amountCents, shotsCents: shotsTierFor(reqShots).amountCents,
    frameCents: framePack ? FRAME_PACK_CENTS : 0, videoCents: addon?.amountCents ?? 0, durationCents, retentionCents,
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
    retentionTiers: RETENTION_TIERS,
  };
}

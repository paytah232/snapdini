// Shared types mirroring the Express API responses.

export interface Option<V = string> { value: V; label: string; }
export interface RevealMode extends Option { icon?: string; desc?: string; }
export interface RatingModeOption extends Option { desc?: string; }
export interface AspectRatio extends Option { pro?: boolean; }
export interface FontOption extends Option { stack: string; }

export interface AppOptions {
  durations: Option<number>[];
  shotsPerPerson: Option<number>[];
  revealModes: RevealMode[];
  revealDelays: Option<number>[];
  aspectRatios: AspectRatio[];
  ratingModes: RatingModeOption[];
  themeModes: Option[];
  fonts: FontOption[];
  defaults: { durationHours: number; maxPhotos: number; revealMode: string; aspectRatios: string[] };
}

/** videoMul: how much a clip costs on an event of this size, as a multiple of the listed add-on
 *  price. Video is the only add-on whose cost is guests x seconds rather than seconds alone — see
 *  PAID_TIERS on the server. Optional so a config from before this still reads (and prices at 1x). */
export interface BillingTier { maxGuests: number; amountCents: number; videoMul?: number; }
export interface VideoAddon { seconds: number; amountCents: number; }
export interface ShotsTier { maxShots: number; amountCents: number; }
export interface DurationTier { maxHours: number; amountCents: number; }
export interface RetentionTier { maxDays: number; amountCents: number; }
export interface BillingConfig {
  billingEnabled: boolean;
  currency: string;
  freeAllGuests: number;
  paidTiers: BillingTier[];
  shotsFree: number;
  shotsTiers: ShotsTier[];
  framePackCents: number;
  videoAddons: VideoAddon[];
  durationFreeHours: number;
  durationTiers: DurationTier[];
  retentionFreeDays: number;
  /** Days included on a PAID event — retention's own allowance, not the guest-tier feature rule. */
  retentionPaidDays: number;
  retentionTiers: RetentionTier[];
}

export interface BillingQuote {
  /** What the event ALREADY has, priced at today's prices. The upgrade charges the difference
   *  between this and `amountCents` — not against money paid in the past, which made every price
   *  change retroactive for events already sold at the old one. */
  coveredCents?: number;
  maxGuests: number;
  maxPhotos: number;
  aspectRatios: string[];
  videoSeconds: number;
  durationHours: number;
  retentionDays: number;
  tier: 'free' | 'paid' | 'custom';
  baseCents: number;
  shotsCents: number;
  frameCents: number;
  videoCents: number;
  durationCents: number;
  retentionCents: number;
  amountCents: number;
  requiresPayment: boolean;
  framePack: boolean;
  features: { video: boolean; aspects: 'all' | 'square' };
  notes: string[];
}

export interface AppConfig {
  version: string;
  videoMaxSeconds: number;
  videoHardMaxSeconds?: number;
  /** How long a guest has to bin a shot they just took. The client MUST read this rather than keep
   *  its own copy: an operator can change it, and a bin that outlives the server's acceptance is a
   *  button that fails. */
  photoDeleteWindowSeconds?: number;
  faceMatchingAvailable?: boolean;
  emailEnabled: boolean;
  supportEmail: string | null;
  /** Cloudflare Turnstile public site key; null = bot check disabled. */
  turnstileSiteKey: string | null;
  options: AppOptions;
  billing: BillingConfig;
}

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  plan: string;
  isAdmin?: boolean;
}

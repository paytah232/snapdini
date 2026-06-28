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

export interface BillingTier { maxGuests: number; amountCents: number; }
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
  retentionTiers: RetentionTier[];
}

export interface BillingQuote {
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
  emailEnabled: boolean;
  supportEmail: string | null;
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

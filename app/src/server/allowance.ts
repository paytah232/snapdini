// A guest's EFFECTIVE allowance.
//
// The event sets the roll; a guest may buy more for themselves. Those two numbers are ADDED, never
// substituted — so a host who later lowers the event roll can never remove something a guest paid
// for. Every route that answers "how many shots do I have left" must come through here: the failure
// mode of a second, slightly-different sum somewhere is that a paying guest is handed their old
// limit back, which is the worst bug this feature could have.
export interface AllowanceInput {
  maxPhotos: number;          // from the event
  extraPhotos?: number | null; // bought by this guest, for themselves
  photosTaken?: number | null;
}

export const effectiveMaxPhotos = (a: AllowanceInput): number =>
  Math.max(0, Number(a.maxPhotos || 0)) + Math.max(0, Number(a.extraPhotos || 0));

export const photosRemaining = (a: AllowanceInput): number =>
  Math.max(0, effectiveMaxPhotos(a) - Math.max(0, Number(a.photosTaken || 0)));

export const hasShotsLeft = (a: AllowanceInput): boolean => photosRemaining(a) > 0;

// One guest top-up: a flat product, deliberately not a ladder. Someone standing at a party with an
// empty roll should not be given a pricing decision, and at Stripe's real ~3.5% + A$0.30 on this
// account anything under about A$2 is mostly fee.
export const GUEST_SHOT_PACK = Number(process.env.GUEST_SHOT_PACK || 12);
export const GUEST_SHOT_PACK_CENTS = Number(process.env.GUEST_SHOT_PACK_CENTS || 300);

// Shots bought minutes before the camera closes are worthless and come straight back as a refund
// request — and Stripe keeps its fee on a refund either way.
export const GUEST_UPGRADE_CUTOFF_MS =
  Number(process.env.GUEST_UPGRADE_CUTOFF_MINUTES || 15) * 60 * 1000;

// One place that answers "fire this funnel action on every ad platform that's configured".
//
// Before this existed, each call site reached for gtag directly and gated itself on the GOOGLE
// label — which meant a Microsoft-only deploy would have measured nothing, and every new platform
// would need every call site edited (and one would get missed). Call sites now ask this module, so
// the per-platform detail lives here and nowhere else.
//
// Pure apart from the injected window, so it's unit-testable (adtracking.test.ts).
import { firePurchaseConversion, fireLeadConversion, type ConversionInput } from './conversions';
import { firePurchaseUet, fireLeadUet, type Uetq } from './msads';

/** The ad-platform fields $page.data carries (from routes/+layout.server.ts). All optional. */
export type AdConfig = {
  analyticsExclude?: boolean;
  purchaseSendTo?: string | null;
  signupSendTo?: string | null;
  createSendTo?: string | null;
  msPurchaseEvent?: string | null;
  msSignupEvent?: string | null;
  msCreateEvent?: string | null;
};

export type LeadAction = 'signup' | 'create';

type AdWindow = { gtag?: (...a: unknown[]) => void; uetq?: Uetq };

const googleLead = (c: AdConfig, which: LeadAction) => (which === 'signup' ? c.signupSendTo : c.createSendTo);
const msLead = (c: AdConfig, which: LeadAction) => (which === 'signup' ? c.msSignupEvent : c.msCreateEvent);

/**
 * Is a PURCHASE measured at all? Call sites use this to decide whether the work that only exists to
 * feed a conversion (the Stripe session lookup for the real amount charged) is worth doing.
 * Excluded users count as untracked, so an operator's own test never triggers the lookup either.
 */
export function purchaseTracked(c: AdConfig | null | undefined): boolean {
  if (!c || c.analyticsExclude) return false;
  return !!(c.purchaseSendTo || c.msPurchaseEvent);
}

/** Is this LEAD action measured on any platform? */
export function leadTracked(c: AdConfig | null | undefined, which: LeadAction): boolean {
  if (!c || c.analyticsExclude) return false;
  return !!(googleLead(c, which) || msLead(c, which));
}

/**
 * Fires the purchase conversion everywhere it's configured. Returns the platforms that actually
 * fired — [] when nothing is configured, the user is excluded, or no tag is present on the page.
 * Best-effort by construction: every underlying call no-ops rather than throwing.
 */
export function firePurchase(
  c: AdConfig | null | undefined,
  input: ConversionInput,
  w: AdWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as AdWindow),
): string[] {
  if (!c || c.analyticsExclude || !w) return [];
  const fired: string[] = [];
  if (firePurchaseConversion(w.gtag, c.purchaseSendTo, input)) fired.push('google');
  if (firePurchaseUet(w.uetq, c.msPurchaseEvent, input)) fired.push('microsoft');
  return fired;
}

/**
 * Fires a lead conversion (sign up / create event) everywhere it's configured. `transactionId` is
 * optional but recommended (e.g. the event join code) so both platforms de-duplicate a revisit.
 */
export function fireLead(
  c: AdConfig | null | undefined,
  which: LeadAction,
  transactionId?: string,
  w: AdWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as AdWindow),
): string[] {
  if (!c || c.analyticsExclude || !w) return [];
  const fired: string[] = [];
  if (fireLeadConversion(w.gtag, googleLead(c, which), transactionId)) fired.push('google');
  if (fireLeadUet(w.uetq, msLead(c, which), transactionId)) fired.push('microsoft');
  return fired;
}

// Google Ads conversion helpers. Pure + framework-free so they're unit-testable
// (conversions.test.ts). Tag id + conversion labels are operator config (env), never hardcoded.
import { isValidGtagId } from './consent';

// A conversion label looks like "AbC-D_efGhIjKlM" (base64url-ish). Validate so the composed
// send_to can't smuggle anything unexpected.
const VALID_LABEL = /^[A-Za-z0-9_-]{6,40}$/;

// The `send_to` string Google expects, e.g. "AW-123456789/AbC-D_efGhIjKlM" — or null when either
// the tag id or the label isn't configured (⇒ that conversion is off). Generic across all actions.
export function composeSendTo(gtagId: string | null | undefined, label: string | null | undefined): string | null {
  const id = (gtagId || '').trim();
  const lbl = (label || '').trim();
  if (!isValidGtagId(id) || !VALID_LABEL.test(lbl)) return null;
  return `${id}/${lbl}`;
}

// Back-compat alias for the purchase conversion (the payment-success pages import this name).
export const purchaseSendTo = composeSendTo;

export type ConversionInput = {
  amountTotalCents: number;
  currency: string;
  transactionId: string;
};

// The gtag('event','conversion', …) payload for a PURCHASE. Value is in major units (Google wants
// dollars, not cents). transaction_id lets Google de-duplicate on reload.
export function conversionArgs(sendTo: string, input: ConversionInput) {
  return {
    send_to: sendTo,
    value: Math.max(0, Math.round(input.amountTotalCents)) / 100,
    currency: (input.currency || 'AUD').toUpperCase(),
    transaction_id: input.transactionId || '',
  };
}

// Fires a purchase conversion via gtag if everything is present. Safe to call unconditionally —
// no tag / no sendTo / no gtag ⇒ no-op. Returns true if it actually fired.
export function firePurchaseConversion(
  gtag: ((...a: unknown[]) => void) | undefined,
  sendTo: string | null | undefined,
  input: ConversionInput,
): boolean {
  if (!gtag || !sendTo) return false;
  gtag('event', 'conversion', conversionArgs(sendTo, input));
  return true;
}

// Fires a value-less LEAD conversion (sign up, create event, …). transaction_id is optional but
// recommended (e.g. the event join code) so Google de-dupes if the success page is revisited.
export function fireLeadConversion(
  gtag: ((...a: unknown[]) => void) | undefined,
  sendTo: string | null | undefined,
  transactionId?: string,
): boolean {
  if (!gtag || !sendTo) return false;
  const args: { send_to: string; transaction_id?: string } = { send_to: sendTo };
  if (transactionId) args.transaction_id = transactionId;
  gtag('event', 'conversion', args);
  return true;
}

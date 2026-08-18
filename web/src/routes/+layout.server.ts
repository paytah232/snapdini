import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { isValidGtagId } from '$lib/consent';
import { purchaseSendTo } from '$lib/conversions';

// Surfaces analytics/ads config to pages:
//  • analyticsEnabled — gates the "Your Privacy Choices" opt-out link (US requirement).
//  • purchaseSendTo — the Google Ads conversion send_to ("AW-…/label"), or null when not configured,
//    used by the payment-success pages to fire a purchase conversion. All operator config (env); no
//    tag ⇒ nothing is exposed and nothing tracks. SSR so there's no hydration flash.
export const load: LayoutServerLoad = () => {
  const id = (env.GTAG_ID || '').trim();
  return {
    analyticsEnabled: isValidGtagId(id),
    purchaseSendTo: purchaseSendTo(id, (env.GADS_PURCHASE_LABEL || '').trim()),
  };
};

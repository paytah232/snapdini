import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { isValidGtagId } from '$lib/consent';
import { composeSendTo } from '$lib/conversions';

// Surfaces analytics/ads config to pages:
//  • analyticsEnabled — gates the "Your Privacy Choices" opt-out link (US requirement).
//  • *SendTo — the Google Ads conversion send_to ("AW-…/label") for each funnel action, or null
//    when that label isn't configured. Used by the relevant success pages to fire conversions.
// All operator config (env); no tag/label ⇒ nothing exposed and nothing tracks. SSR = no flash.
export const load: LayoutServerLoad = () => {
  const id = (env.GTAG_ID || '').trim();
  return {
    analyticsEnabled: isValidGtagId(id),
    purchaseSendTo: composeSendTo(id, (env.GADS_PURCHASE_LABEL || '').trim()),
    signupSendTo: composeSendTo(id, (env.GADS_SIGNUP_LABEL || '').trim()),
    createSendTo: composeSendTo(id, (env.GADS_CREATE_LABEL || '').trim()),
  };
};

import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { isValidGtagId } from '$lib/consent';
import { composeSendTo } from '$lib/conversions';
import { isValidUetId, uetAction } from '$lib/msads';

// Surfaces analytics/ads config to pages:
//  • analyticsEnabled — gates the "Your Privacy Choices" opt-out link (US requirement).
//  • *SendTo — the Google Ads conversion send_to ("AW-…/label") for each funnel action (or null).
//  • ms*Event — the Microsoft Advertising (UET) goal action name for the same funnel actions (or
//    null). Google and Microsoft are independent: configuring one does not require the other.
//  • analyticsExclude — true when the signed-in user is a site admin or an ANALYTICS_EXCLUDE_EMAILS
//    address, so the operator's own testing doesn't fire conversions and pollute the data. Only a
//    BOOLEAN is exposed (never the email list — that would leak owner PII into the page).
// All operator config (env); no tag ⇒ nothing tracks. SSR so there's no hydration flash.
export const load: LayoutServerLoad = async ({ request, fetch }) => {
  const id = (env.GTAG_ID || '').trim();
  const uetId = (env.MSUET_ID || '').trim();
  // Either tag being present means measurement is on, which is what gates the opt-out link.
  const analyticsEnabled = isValidGtagId(id) || isValidUetId(uetId);

  let analyticsExclude = false;
  // Only bother when analytics is on AND the request carries an auth cookie (guests join via a
  // localStorage token, not a cookie, so their pages skip this internal call entirely).
  if (analyticsEnabled && request.headers.get('cookie')) {
    try {
      const base = env.INTERNAL_API_BASE || '';
      const r = await fetch(base + '/api/auth/me', { headers: { cookie: request.headers.get('cookie') || '' } });
      if (r.ok) {
        const { user } = (await r.json()) as { user?: { email?: string; isAdmin?: boolean } | null };
        const excl = (env.ANALYTICS_EXCLUDE_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        analyticsExclude = !!user && (!!user.isAdmin || (!!user.email && excl.includes(user.email.toLowerCase())));
      }
    } catch { /* best-effort — default to not excluding */ }
  }

  return {
    analyticsEnabled,
    analyticsExclude,
    purchaseSendTo: composeSendTo(id, (env.GADS_PURCHASE_LABEL || '').trim()),
    signupSendTo: composeSendTo(id, (env.GADS_SIGNUP_LABEL || '').trim()),
    createSendTo: composeSendTo(id, (env.GADS_CREATE_LABEL || '').trim()),
    msPurchaseEvent: uetAction(uetId, (env.MSADS_PURCHASE_EVENT || '').trim()),
    msSignupEvent: uetAction(uetId, (env.MSADS_SIGNUP_EVENT || '').trim()),
    msCreateEvent: uetAction(uetId, (env.MSADS_CREATE_EVENT || '').trim()),
  };
};

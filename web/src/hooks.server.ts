import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { analyticsHead, isConsentRegion, isValidGtagId } from '$lib/consent';
import { isValidUetId, uetHead } from '$lib/msads';
import { isIndexable, robotsHeader } from '$lib/seo';

// Injects the ad/analytics tags into the %snapdini.analytics% placeholder in app.html at SSR —
// Google (Consent Mode v2) when GTAG_ID is set, and Microsoft Advertising (UET) when MSUET_ID is
// set. The two are INDEPENDENT: either, both or neither. No ids ⇒ nothing injected, so a default /
// self-hosted deploy ships zero third-party tracking. Tag ids are operator config (never
// hardcoded), so they stay out of the public repo and one operator can't fire another's tag. All
// consent logic lives in $lib/consent.ts and $lib/msads.ts (unit-tested); this hook just wires env
// + region into them.

export const handle: Handle = async ({ event, resolve }) => {
  const id = (env.GTAG_ID || '').trim();
  const uetId = (env.MSUET_ID || '').trim();
  const google = isValidGtagId(id);
  const microsoft = isValidUetId(uetId);
  // Cloudflare sets CF-IPCountry (forwarded through the proxy). Missing ⇒ treated as non-consent-region.
  const country = event.request.headers.get('cf-ipcountry');
  const inConsentRegion = isConsentRegion(country);
  // Ask when ANY tag is present and the visitor is in a prior-consent region.
  const ask = (google || microsoft) && inConsentRegion;

  // Belt and braces alongside the per-page <meta>: the header covers routes that render no head
  // tags at all, and is what a crawler sees even for a non-HTML response.
  const xRobots = robotsHeader(isIndexable(env.SEO_INDEXABLE));

  const response = await resolve(event, {
    transformPageChunk: ({ html }) => {
      if (!google && !microsoft) return html.replace('%snapdini.analytics%', '');
      // Tell the client-side banner whether to ask (consent region) and that a tag is present.
      const flag = `<script>window.__snapdiniConsent={enabled:true,eea:${ask}};</script>`;
      const tags = (google ? analyticsHead(id) : '') + (microsoft ? uetHead(uetId, inConsentRegion) : '');
      return html.replace('%snapdini.analytics%', flag + tags);
    },
  });
  if (xRobots) response.headers.set('X-Robots-Tag', xRobots);
  return response;
};

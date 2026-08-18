import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { analyticsHead, isConsentRegion, isValidGtagId } from '$lib/consent';

// Injects the Google Consent Mode v2 tag into the %snapdini.analytics% placeholder in app.html at
// SSR — but ONLY when GTAG_ID is set. No id ⇒ nothing injected, so a default / self-hosted deploy
// ships zero third-party tracking. The tag id is operator config (never hardcoded), so it stays out
// of the public repo and one operator can't fire another's tag. All consent logic lives in
// $lib/consent.ts (unit-tested); this hook just wires env + region into it.

export const handle: Handle = async ({ event, resolve }) => {
  const id = (env.GTAG_ID || '').trim();
  const enabled = isValidGtagId(id);
  // Cloudflare sets CF-IPCountry (forwarded through the proxy). Missing ⇒ treated as non-consent-region.
  const country = event.request.headers.get('cf-ipcountry');
  const ask = enabled && isConsentRegion(country);

  return resolve(event, {
    transformPageChunk: ({ html }) => {
      if (!enabled) return html.replace('%snapdini.analytics%', '');
      // Tell the client-side banner whether to ask (consent region) and that a tag is present.
      const flag = `<script>window.__snapdiniConsent={enabled:true,eea:${ask}};</script>`;
      return html.replace('%snapdini.analytics%', flag + analyticsHead(id));
    },
  });
};

import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { analyticsHead, isConsentRegion, isValidGtagId } from '$lib/consent';
import { isValidUetId, uetHead } from '$lib/msads';
import { isIndexable, robotsHeader } from '$lib/seo';
import { isTokenRoute, redactPath } from '../../shared/token-paths';

// Injects the ad/analytics tags into the %snapdini.analytics% placeholder in app.html at SSR —
// Google (Consent Mode v2) when GTAG_ID is set, and Microsoft Advertising (UET) when MSUET_ID is
// set. The two are INDEPENDENT: either, both or neither. No ids ⇒ nothing injected, so a default /
// self-hosted deploy ships zero third-party tracking. Tag ids are operator config (never
// hardcoded), so they stay out of the public repo and one operator can't fire another's tag. All
// consent logic lives in $lib/consent.ts and $lib/msads.ts (unit-tested); this hook just wires env
// + region into them.
//
// ── Routes where NO tag is injected ─────────────────────────────────────────────────
//
// On the email-link routes (shared/token-paths TOKEN_ROUTES) the URL IS the credential — the
// preference-centre token, for one, authenticates an account for 400 days and can be reused — and
// Google's default page_location is document.location.href. So those pages get no tag, no banner
// and no loader: nothing to leak through.
//
// This is a DENY-list, and the choice is deliberate. An allow-list fails closed on privacy but
// fails SILENTLY on measurement: add a landing page, forget the list, and there is no error, no
// symptom, just a funnel that stopped being attributed — which is what the tag is here for. A
// deny-list fails the other way, so it is not left as the only defence: page_location is
// independently redacted below for every route, deny-listed or not, and shared/token-paths also
// redacts BY SHAPE, so a credential on a route nobody has written yet is caught without anyone
// having to remember this file. The explicit list is the readable statement of the four routes we
// know about; the shape rule is what makes forgetting it survivable.

/** Page routes whose HTML must never be held by a cache — ours, a CDN's, or a browser's.
 *
 *  These pages are rendered FOR a person: a host's event manager, their dashboard, the platform
 *  console, the create wizard that carries an organizer code in its fragment. None of them should
 *  ever be handed to a second reader.
 *
 *  Until now they said nothing at all about caching, and were safe only because Cloudflare does not
 *  cache HTML by default. That is somebody else's default, in somebody else's dashboard, and this
 *  product already has a Cache Rule making one `/api/` path cacheable — the next such rule, written
 *  for a good reason by somebody moving fast, is all it would take. A page that must not be stored
 *  should say so itself rather than rely on nobody switching it on.
 *
 *  `/e` and `/gallery` are deliberately ABSENT. They are the same page for every guest and their
 *  data comes from the API, which does its own caching properly — making the shell uncacheable
 *  would cost the thing the cache rule was added for and protect nothing.
 *
 *  Prefix-matched on a path SEGMENT, so `/admin` catches `/admin/ABC123` without `/administrator`
 *  (were there ever one) sneaking in. */
const PRIVATE_PREFIXES = ['/admin', '/dashboard', '/siteadmin', '/app', '/login', '/signup'] as const;

export function isPrivatePage(pathname: string): boolean {
  return PRIVATE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export const handle: Handle = async ({ event, resolve }) => {
  const id = (env.GTAG_ID || '').trim();
  const uetId = (env.MSUET_ID || '').trim();
  // Microsoft's tag has no page_location equivalent to redact (bat.js reads document.location
  // itself, and enableAutoSpaTracking re-reads it on every client-side navigation), so for UET
  // this gate is the ONLY control there is — one more reason it decides both platforms together.
  const tagsAllowed = !isTokenRoute(event.url.pathname);
  const google = tagsAllowed && isValidGtagId(id);
  const microsoft = tagsAllowed && isValidUetId(uetId);
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
      const tags = (google ? analyticsHead(id, redactPath(event.url.pathname)) : '')
        + (microsoft ? uetHead(uetId, inConsentRegion) : '');
      return html.replace('%snapdini.analytics%', flag + tags);
    },
  });
  if (xRobots) response.headers.set('X-Robots-Tag', xRobots);
  // Set LAST and unconditionally, so it wins over anything a route decided for itself. A page on
  // this list is private whatever else it believes about caching.
  //
  // Token routes come along for the ride: the credential IS the URL there, so a stored copy is a
  // stored credential. isTokenRoute is reused rather than re-listed for the reason its own file
  // gives — two lists of the same routes drift, and that is how a 400-day bearer token ended up in
  // analytics once already.
  if (isPrivatePage(event.url.pathname) || isTokenRoute(event.url.pathname)) {
    response.headers.set('Cache-Control', 'private, no-store');
  }
  return response;
};

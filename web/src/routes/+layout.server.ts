import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { isValidGtagId } from '$lib/consent';

// Surfaces whether an analytics/ads tag is configured, so pages can show a "Your Privacy Choices"
// opt-out link only when there's actually something to opt out of (US state-law requirement; no tag
// on a self-hosted deploy ⇒ no link). SSR so there's no hydration flash.
export const load: LayoutServerLoad = () => ({
  analyticsEnabled: isValidGtagId((env.GTAG_ID || '').trim()),
});

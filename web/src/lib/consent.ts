// Consent Mode v2 helpers — the single source of truth for the analytics/ads tag and its consent
// gating. Kept framework-free and pure so it's unit-testable (see consent.test.ts) and shared by the
// server hook (hooks.server.ts) that injects the tag. No secrets here — the tag id is passed in.

// Regions where Consent Mode defaults to DENIED until the user opts in via the banner: the EEA
// (EU-27 + Iceland, Liechtenstein, Norway) plus the UK (GB) and Switzerland (CH), which have the
// same prior-consent regime under UK GDPR/PECR and the revised Swiss FADP.
export const CONSENT_REGIONS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
  'GB', 'CH',
] as const;

// Whether a visitor in `country` (ISO-3166-1 alpha-2, e.g. from Cloudflare's CF-IPCountry) must be
// asked for opt-in consent before the tag may share data.
export function isConsentRegion(country: string | null | undefined): boolean {
  if (!country) return false;
  return (CONSENT_REGIONS as readonly string[]).includes(country.toUpperCase());
}

// Accept only a well-formed Google tag id (AW-… Ads, G-… GA4, GT-/GTM-/DC-/UA- variants). Guards the
// string interpolation in analyticsHead() against a malformed operator-set value.
const VALID_ID = /^(AW|G|GT|GTM|DC|UA)-[A-Z0-9-]{4,20}$/i;

export function isValidGtagId(id: string | null | undefined): boolean {
  return !!id && VALID_ID.test(id.trim());
}

// The <head> markup: Consent Mode v2 defaults + gtag loader. Order matters — the consent `default`
// commands and the gtag() shim MUST precede the async library load, and there are TWO defaults: an
// explicit granted baseline for the rest of the world, then a denied override for CONSENT_REGIONS.
// Also honours the Global Privacy Control browser signal (auto-deny) and replays a stored choice.
export function analyticsHead(id: string): string {
  const regions = JSON.stringify(CONSENT_REGIONS);
  return (
    `<script>` +
    `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
    `gtag('consent','default',{ad_storage:'granted',ad_user_data:'granted',ad_personalization:'granted',analytics_storage:'granted'});` +
    `gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',region:${regions},wait_for_update:500});` +
    // Honour Global Privacy Control (a valid opt-out signal under several US state laws).
    `try{if(navigator.globalPrivacyControl===true)gtag('consent','update',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied'});}catch(e){}` +
    // Replay a previously stored choice before the tag fires.
    `try{var c=localStorage.getItem('snapdini-consent');if(c==='granted')gtag('consent','update',{ad_storage:'granted',ad_user_data:'granted',ad_personalization:'granted',analytics_storage:'granted'});else if(c==='denied')gtag('consent','update',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied'});}catch(e){}` +
    `gtag('set','ads_data_redaction',true);gtag('set','url_passthrough',true);` +
    `gtag('js',new Date());gtag('config','${id}');` +
    `</script>` +
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>`
  );
}

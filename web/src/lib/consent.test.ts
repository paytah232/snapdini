import { describe, it, expect } from 'vitest';
import { CONSENT_REGIONS, isConsentRegion, isValidGtagId, analyticsHead } from './consent';

describe('isConsentRegion', () => {
  it('asks EEA members', () => {
    for (const c of ['DE', 'FR', 'IE', 'IT', 'ES', 'NL', 'PL', 'SE', 'IS', 'LI', 'NO']) {
      expect(isConsentRegion(c)).toBe(true);
    }
  });
  it('asks the UK and Switzerland (same prior-consent regime)', () => {
    expect(isConsentRegion('GB')).toBe(true);
    expect(isConsentRegion('CH')).toBe(true);
  });
  it('does NOT ask the rest of the world', () => {
    for (const c of ['US', 'AU', 'CA', 'JP', 'BR', 'IN', 'NZ', 'ZA']) {
      expect(isConsentRegion(c)).toBe(false);
    }
  });
  it('is case-insensitive', () => {
    expect(isConsentRegion('de')).toBe(true);
    expect(isConsentRegion('gb')).toBe(true);
  });
  it('treats missing/empty country as non-consent-region (fail-open to no-banner)', () => {
    expect(isConsentRegion('')).toBe(false);
    expect(isConsentRegion(null)).toBe(false);
    expect(isConsentRegion(undefined)).toBe(false);
  });
  it('covers exactly EU-27 + IS/LI/NO + GB + CH (32)', () => {
    expect(CONSENT_REGIONS.length).toBe(32);
  });
});

describe('isValidGtagId', () => {
  it('accepts real Google tag ids', () => {
    expect(isValidGtagId('AW-TEST123456')).toBe(true);
    expect(isValidGtagId('G-ABC1234')).toBe(true);
    expect(isValidGtagId('GT-XYZ99')).toBe(true);
    expect(isValidGtagId('  AW-TEST123456  ')).toBe(true); // trimmed
  });
  it('rejects empty / malformed / injection attempts', () => {
    expect(isValidGtagId('')).toBe(false);
    expect(isValidGtagId(null)).toBe(false);
    expect(isValidGtagId(undefined)).toBe(false);
    expect(isValidGtagId('not-a-tag')).toBe(false);
    expect(isValidGtagId("AW-1');alert(1)//")).toBe(false); // no script injection through the id
  });
});

describe('analyticsHead (Consent Mode v2 markup)', () => {
  const html = analyticsHead('AW-TEST123456', '/pricing');

  it('emits TWO consent defaults: a granted baseline then a denied region override', () => {
    const defaults = html.match(/gtag\('consent','default'/g) ?? [];
    expect(defaults.length).toBe(2);
    const granted = html.indexOf("gtag('consent','default',{ad_storage:'granted'");
    const denied = html.indexOf("gtag('consent','default',{ad_storage:'denied'");
    expect(granted).toBeGreaterThanOrEqual(0);
    expect(denied).toBeGreaterThan(granted); // baseline first, region override second
  });

  it('scopes the denied default to the consent regions', () => {
    expect(html).toContain("region:[");
    expect(html).toContain('"GB"');
    expect(html).toContain('"CH"');
    expect(html).toContain('"DE"');
  });

  it('runs the consent defaults BEFORE the async gtag library loads', () => {
    const firstDefault = html.indexOf("gtag('consent','default'");
    const loader = html.indexOf('googletagmanager.com/gtag/js');
    expect(firstDefault).toBeGreaterThanOrEqual(0);
    expect(loader).toBeGreaterThan(firstDefault);
  });

  it('sets all four Consent Mode v2 signals', () => {
    for (const sig of ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage']) {
      expect(html).toContain(sig);
    }
  });

  it('honours Global Privacy Control and replays a stored choice', () => {
    expect(html).toContain('navigator.globalPrivacyControl');
    expect(html).toContain("localStorage.getItem('snapdini-consent')");
  });

  it('enables ad redaction + url passthrough and configs the given id', () => {
    expect(html).toContain("gtag('set','ads_data_redaction',true)");
    expect(html).toContain("gtag('set','url_passthrough',true)");
    expect(html).toContain("gtag('config','AW-TEST123456',{");
    expect(html).toContain('gtag/js?id=AW-TEST123456');
  });

  // The tag's own default page_location is document.location.href, which carries both the path
  // (where the email preference-centre token lives) and the fragment (where the organizer code
  // lives). Overriding it is the second layer under the hook's route deny-list.
  it('overrides page_location instead of letting the tag read document.location', () => {
    expect(html).toContain('page_location:location.origin+"/pricing"+location.search');
    expect(html).not.toContain('location.href');
    expect(html).not.toContain('location.hash');
  });

  it('interpolates the path as a JS string literal, so it cannot close the script', () => {
    // pathname is URL-encoded in practice; belt and braces all the same, since this string is
    // built server-side and dropped straight into an inline <script>.
    const nasty = analyticsHead('AW-TEST123456', '/x</script><script>alert(1)</script>');
    expect(nasty).not.toContain('</script><script>alert(1)');
    expect(nasty).toContain('\\u003c/script>');
  });
});

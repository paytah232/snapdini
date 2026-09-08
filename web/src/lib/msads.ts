// Microsoft Advertising UET (Universal Event Tracking) — the Bing-side twin of $lib/consent.ts +
// $lib/conversions.ts, deliberately kept symmetric with them so the two ad platforms are wired the
// same way and neither can silently drift.
//
// Everything here is operator config (env), never hardcoded: no MSUET_ID ⇒ nothing is injected and
// nothing fires, so a default / self-hosted deploy still ships zero third-party tracking. Pure and
// framework-free so it's unit-testable (msads.test.ts).

// A UET tag id is a plain numeric id (currently 8-9 digits; range kept loose for future growth).
// Validating it guards the string interpolation in uetHead() against a malformed operator value.
const VALID_UET_ID = /^[0-9]{6,12}$/;

export function isValidUetId(id: string | null | undefined): boolean {
  return !!id && VALID_UET_ID.test(id.trim());
}

// Microsoft "Event" goals match on the action name you push, so the action is the UET equivalent of
// a Google Ads conversion label — free-form operator config. Allow readable names only.
const VALID_ACTION = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,39}$/;

export function isValidUetAction(action: string | null | undefined): boolean {
  return !!action && VALID_ACTION.test(action.trim());
}

/** The action name to push, or null when it isn't configured / is malformed ⇒ that goal is off. */
export function uetAction(id: string | null | undefined, action: string | null | undefined): string | null {
  const a = (action || '').trim();
  if (!isValidUetId(id) || !isValidUetAction(a)) return null;
  return a;
}

// UET's consent mode has exactly ONE signal (ad_storage) — not Google's four. Mapping our single
// banner choice onto it keeps one decision driving both platforms.
const consentPush = (state: 'granted' | 'denied') =>
  `window.uetq.push('consent','update',{ad_storage:'${state}'});`;

/**
 * The <head> markup: uetq queue + consent default + the deferred bat.js load.
 *
 * Order matters and mirrors the Google tag: the queue exists first, consent is pushed onto it BEFORE
 * the library initialises, and the library is loaded on idle (or first interaction) rather than
 * during the initial paint. That is safe because `uetq` is a plain array until bat.js arrives, and
 * the official snippet hands the queued array to `new UET(...)` as `o.q` — so consent commands and
 * any conversion events pushed early are replayed in order once it loads.
 *
 * `enableAutoSpaTracking` makes client-side SvelteKit navigations register as page views, which a
 * one-shot pageLoad would miss.
 *
 * @param denyByDefault true for a consent-region visitor ⇒ ad_storage defaults to denied until the
 *   banner grants it. Decided server-side because UET has no region parameter of its own.
 */
export function uetHead(id: string, denyByDefault: boolean): string {
  return (
    `<script>` +
    `window.uetq=window.uetq||[];` +
    // UET consent mode has no per-region parameter (Google's does), so the region test is made
    // SERVER-side from CF-IPCountry and baked into the default the page ships with.
    `window.uetq.push('consent','default',{ad_storage:'${denyByDefault ? 'denied' : 'granted'}'});` +
    // Honour Global Privacy Control (a valid opt-out signal under several US state laws).
    `try{if(navigator.globalPrivacyControl===true)${consentPush('denied')}}catch(e){}` +
    // Replay a previously stored choice before the tag fires.
    `try{var c=localStorage.getItem('snapdini-consent');` +
    `if(c==='granted')${consentPush('granted')}else if(c==='denied')${consentPush('denied')}}catch(e){}` +
    `</script>` +
    `<script>` +
    `(function(){var loaded=false;function go(){if(loaded)return;loaded=true;` +
    `var f=function(){var o={ti:'${id}',enableAutoSpaTracking:true};o.q=window.uetq;` +
    `window.uetq=new UET(o);window.uetq.push('pageLoad');};` +
    `var n=document.createElement('script');n.src='https://bat.bing.com/bat.js';n.async=true;` +
    `n.onload=n.onreadystatechange=function(){var s=this.readyState;` +
    `if(s&&s!=='loaded'&&s!=='complete')return;f();n.onload=n.onreadystatechange=null;};` +
    `document.head.appendChild(n);}` +
    `['pointerdown','keydown','touchstart','scroll'].forEach(function(e){` +
    `addEventListener(e,go,{once:true,passive:true});});` +
    `if('requestIdleCallback' in window)requestIdleCallback(go,{timeout:3500});else setTimeout(go,2500);` +
    `})();` +
    `</script>`
  );
}

// A push target: either the raw array (before bat.js loads) or the UET object (after). Both expose
// .push, which is exactly why the queue pattern works.
export type Uetq = { push: (...a: unknown[]) => void } | unknown[] | undefined;

function pushTo(uetq: Uetq, args: unknown[]): boolean {
  const q = uetq as { push?: (...a: unknown[]) => void } | undefined;
  if (!q || typeof q.push !== 'function') return false;
  q.push(...args);
  return true;
}

export type UetPurchase = {
  amountTotalCents: number;
  currency: string;
  transactionId: string;
};

/** The UET payload for a purchase. `revenue_value` is in major units, as Microsoft expects. */
export function purchaseArgs(action: string, input: UetPurchase) {
  return [
    'event',
    action,
    {
      revenue_value: Math.max(0, Math.round(input.amountTotalCents)) / 100,
      currency: (input.currency || 'AUD').toUpperCase(),
      transaction_id: input.transactionId || '',
    },
  ];
}

/** Fires a purchase goal. Safe to call unconditionally — no id / no action / no queue ⇒ no-op. */
export function firePurchaseUet(uetq: Uetq, action: string | null | undefined, input: UetPurchase): boolean {
  if (!action) return false;
  return pushTo(uetq, purchaseArgs(action, input));
}

/** Fires a value-less lead goal (sign up, create event, …). */
export function fireLeadUet(uetq: Uetq, action: string | null | undefined, transactionId?: string): boolean {
  if (!action) return false;
  const params: Record<string, string> = {};
  if (transactionId) params.transaction_id = transactionId;
  return pushTo(uetq, ['event', action, params]);
}

/** Pushes the banner decision onto the queue. Exported so ConsentBanner can drive both platforms. */
export function updateUetConsent(uetq: Uetq, granted: boolean): boolean {
  return pushTo(uetq, ['consent', 'update', { ad_storage: granted ? 'granted' : 'denied' }]);
}

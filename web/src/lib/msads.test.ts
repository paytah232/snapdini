import { describe, it, expect } from 'vitest';
import {
  isValidUetId, isValidUetAction, uetAction, uetHead,
  firePurchaseUet, fireLeadUet, updateUetConsent, purchaseArgs,
} from './msads';

describe('isValidUetId', () => {
  it('accepts a real-shaped numeric UET tag id', () => {
    for (const id of ['97012345', '187654321', '123456']) expect(isValidUetId(id)).toBe(true);
  });
  it('trims surrounding whitespace', () => {
    expect(isValidUetId('  97012345  ')).toBe(true);
  });
  it('rejects anything that is not a bare number', () => {
    // A Google id in the Microsoft slot is the most likely operator mistake.
    for (const id of ['AW-123456789', 'G-ABCDEF', '', '   ', '12345', '1234567890123', '9701234a',
                      '97012345;alert(1)', '97012345"']) {
      expect(isValidUetId(id)).toBe(false);
    }
  });
  it('rejects null / undefined', () => {
    expect(isValidUetId(null)).toBe(false);
    expect(isValidUetId(undefined)).toBe(false);
  });
});

describe('isValidUetAction', () => {
  it('accepts readable goal action names', () => {
    for (const a of ['purchase', 'sign_up', 'Create Event', 'snapdini.purchase', 'lead-2']) {
      expect(isValidUetAction(a)).toBe(true);
    }
  });
  it('rejects names that could break out of the quoted push', () => {
    for (const a of ["pur'chase", 'pur"chase', 'a);alert(1', 'x\nY', '', 'a', 'z'.repeat(41)]) {
      expect(isValidUetAction(a)).toBe(false);
    }
  });
});

describe('uetAction', () => {
  it('returns the action when BOTH the id and the action are valid', () => {
    expect(uetAction('97012345', 'purchase')).toBe('purchase');
    expect(uetAction('97012345', '  purchase  ')).toBe('purchase');
  });
  it('is off (null) when the tag id is missing or malformed', () => {
    expect(uetAction('', 'purchase')).toBeNull();
    expect(uetAction('AW-123456', 'purchase')).toBeNull();
  });
  it('is off (null) when the action is missing — one goal off does not affect the others', () => {
    expect(uetAction('97012345', '')).toBeNull();
    expect(uetAction('97012345', undefined)).toBeNull();
  });
});

describe('uetHead', () => {
  const id = '97012345';
  it('creates the queue before anything pushes to it', () => {
    const h = uetHead(id, false);
    expect(h.indexOf('window.uetq=window.uetq||[]')).toBeLessThan(h.indexOf("uetq.push('consent'"));
  });
  it('pushes the consent default BEFORE the library can initialise', () => {
    const h = uetHead(id, false);
    expect(h.indexOf("push('consent','default'")).toBeLessThan(h.indexOf('bat.bing.com'));
  });
  it('defaults ad_storage to granted outside consent regions', () => {
    expect(uetHead(id, false)).toContain("push('consent','default',{ad_storage:'granted'})");
  });
  it('defaults ad_storage to DENIED for a consent-region visitor', () => {
    const h = uetHead(id, true);
    expect(h).toContain("push('consent','default',{ad_storage:'denied'})");
    expect(h).not.toContain("push('consent','default',{ad_storage:'granted'})");
  });
  it('honours Global Privacy Control', () => {
    expect(uetHead(id, false)).toContain('navigator.globalPrivacyControl===true');
  });
  it('replays a stored choice both ways', () => {
    const h = uetHead(id, false);
    expect(h).toContain("localStorage.getItem('snapdini-consent')");
    expect(h).toContain("c==='granted'");
    expect(h).toContain("c==='denied'");
  });
  it('carries the tag id into the UET init', () => {
    expect(uetHead(id, false)).toContain(`ti:'${id}'`);
  });
  it('tracks SPA navigations (SvelteKit routes client-side)', () => {
    expect(uetHead(id, false)).toContain('enableAutoSpaTracking:true');
  });
  it('hands the queued array to UET so early pushes are replayed', () => {
    expect(uetHead(id, false)).toContain('o.q=window.uetq');
  });
  it('defers bat.js to idle or the first interaction, never the initial paint', () => {
    const h = uetHead(id, false);
    expect(h).toContain('requestIdleCallback');
    expect(h).toContain('pointerdown');
    expect(h).toContain('n.async=true');
  });
  it('keeps every tag/consent detail out of the markup when nothing is passed through', () => {
    // Sanity: the id is the only interpolation, and it is number-only by validation.
    expect(uetHead(id, false).match(/\$\{/)).toBeNull();
  });
});

// A stand-in for both states of the global: the plain array (before bat.js) and the UET object.
const arrayQueue = () => [] as unknown[];
const objectQueue = () => { const calls: unknown[][] = []; return { calls, push: (...a: unknown[]) => { calls.push(a); } }; };

describe('firePurchaseUet', () => {
  it('pushes revenue in MAJOR units with the currency and transaction id', () => {
    const q = objectQueue();
    expect(firePurchaseUet(q, 'purchase', { amountTotalCents: 4900, currency: 'aud', transactionId: 'cs_1' })).toBe(true);
    expect(q.calls[0]).toEqual(['event', 'purchase', { revenue_value: 49, currency: 'AUD', transaction_id: 'cs_1' }]);
  });
  it('works on the raw array queue too (fired before bat.js loads)', () => {
    // Before bat.js arrives, uetq is a PLAIN ARRAY, so push(a,b,c) appends three items — the flat
    // form the snippet hands to `new UET({q: uetq})` to replay. This is the same shape Microsoft's
    // own consent-mode docs push before the tag snippet, so replay has to support it; asserting the
    // flat layout here pins that contract rather than assuming a grouped one.
    const q = arrayQueue();
    expect(firePurchaseUet(q, 'purchase', { amountTotalCents: 100, currency: 'AUD', transactionId: 't' })).toBe(true);
    expect(q).toEqual(['event', 'purchase', { revenue_value: 1, currency: 'AUD', transaction_id: 't' }]);
  });
  it('never sends a negative revenue', () => {
    const q = objectQueue();
    firePurchaseUet(q, 'purchase', { amountTotalCents: -500, currency: 'AUD', transactionId: 't' });
    expect((q.calls[0][2] as { revenue_value: number }).revenue_value).toBe(0);
  });
  it('rounds sub-cent amounts rather than emitting a long float', () => {
    expect((purchaseArgs('p', { amountTotalCents: 4900.4, currency: 'AUD', transactionId: 't' })[2] as { revenue_value: number }).revenue_value).toBe(49);
  });
  it('no-ops when the goal is not configured', () => {
    const q = objectQueue();
    expect(firePurchaseUet(q, null, { amountTotalCents: 100, currency: 'AUD', transactionId: 't' })).toBe(false);
    expect(q.calls).toHaveLength(0);
  });
  it('no-ops when no tag is on the page at all', () => {
    expect(firePurchaseUet(undefined, 'purchase', { amountTotalCents: 100, currency: 'AUD', transactionId: 't' })).toBe(false);
  });
});

describe('fireLeadUet', () => {
  it('pushes the action with a de-duplicating transaction id', () => {
    const q = objectQueue();
    expect(fireLeadUet(q, 'create_event', 'ABC123')).toBe(true);
    expect(q.calls[0]).toEqual(['event', 'create_event', { transaction_id: 'ABC123' }]);
  });
  it('omits the transaction id when there is nothing to de-duplicate on', () => {
    const q = objectQueue();
    fireLeadUet(q, 'sign_up');
    expect(q.calls[0]).toEqual(['event', 'sign_up', {}]);
  });
  it('no-ops when the goal is off', () => {
    const q = objectQueue();
    expect(fireLeadUet(q, undefined, 'x')).toBe(false);
    expect(q.calls).toHaveLength(0);
  });
});

describe('updateUetConsent', () => {
  it('maps the banner decision onto ad_storage', () => {
    const q = objectQueue();
    updateUetConsent(q, true);
    updateUetConsent(q, false);
    expect(q.calls).toEqual([
      ['consent', 'update', { ad_storage: 'granted' }],
      ['consent', 'update', { ad_storage: 'denied' }],
    ]);
  });
  it('no-ops with no tag on the page (banner still works)', () => {
    expect(updateUetConsent(undefined, true)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { firePurchase, fireLead, purchaseTracked, leadTracked, type AdConfig } from './adtracking';

const GOOGLE: AdConfig = {
  purchaseSendTo: 'AW-123456789/AbC-D_efG', signupSendTo: 'AW-123456789/Sign-Up_1', createSendTo: 'AW-123456789/Create_1',
};
const MICROSOFT: AdConfig = { msPurchaseEvent: 'purchase', msSignupEvent: 'sign_up', msCreateEvent: 'create_event' };
const BOTH: AdConfig = { ...GOOGLE, ...MICROSOFT };
const PURCHASE = { amountTotalCents: 4900, currency: 'AUD', transactionId: 'cs_test_1' };

function fakeWindow(opts: { google?: boolean; microsoft?: boolean } = { google: true, microsoft: true }) {
  const gcalls: unknown[][] = [];
  const ucalls: unknown[][] = [];
  return {
    w: {
      gtag: opts.google ? (...a: unknown[]) => { gcalls.push(a); } : undefined,
      uetq: opts.microsoft ? { push: (...a: unknown[]) => { ucalls.push(a); } } : undefined,
    },
    gcalls, ucalls,
  };
}

describe('purchaseTracked', () => {
  it('is true when either platform is configured', () => {
    expect(purchaseTracked(GOOGLE)).toBe(true);
    expect(purchaseTracked(MICROSOFT)).toBe(true);
    expect(purchaseTracked(BOTH)).toBe(true);
  });
  it('is false when neither is — so the Stripe lookup that only feeds it is skipped', () => {
    expect(purchaseTracked({})).toBe(false);
    expect(purchaseTracked(null)).toBe(false);
  });
  it('is false for an excluded (admin / internal) user even with both configured', () => {
    expect(purchaseTracked({ ...BOTH, analyticsExclude: true })).toBe(false);
  });
});

describe('leadTracked', () => {
  it('is per-action, so one goal being off does not silence the other', () => {
    expect(leadTracked({ signupSendTo: GOOGLE.signupSendTo }, 'signup')).toBe(true);
    expect(leadTracked({ signupSendTo: GOOGLE.signupSendTo }, 'create')).toBe(false);
    expect(leadTracked({ msCreateEvent: 'create_event' }, 'create')).toBe(true);
    expect(leadTracked({ msCreateEvent: 'create_event' }, 'signup')).toBe(false);
  });
  it('is false for an excluded user', () => {
    expect(leadTracked({ ...BOTH, analyticsExclude: true }, 'signup')).toBe(false);
  });
});

describe('firePurchase', () => {
  it('fires BOTH platforms from one call — the point of the facade', () => {
    const { w, gcalls, ucalls } = fakeWindow();
    expect(firePurchase(BOTH, PURCHASE, w)).toEqual(['google', 'microsoft']);
    expect(gcalls).toHaveLength(1);
    expect(ucalls).toHaveLength(1);
  });
  it('sends the same money to both, each in that platform’s shape', () => {
    const { w, gcalls, ucalls } = fakeWindow();
    firePurchase(BOTH, PURCHASE, w);
    expect(gcalls[0][2]).toMatchObject({ value: 49, currency: 'AUD', transaction_id: 'cs_test_1' });
    expect(ucalls[0][2]).toMatchObject({ revenue_value: 49, currency: 'AUD', transaction_id: 'cs_test_1' });
  });
  it('fires Microsoft even when Google is not configured (the old bug)', () => {
    const { w, gcalls, ucalls } = fakeWindow();
    expect(firePurchase(MICROSOFT, PURCHASE, w)).toEqual(['microsoft']);
    expect(gcalls).toHaveLength(0);
    expect(ucalls).toHaveLength(1);
  });
  it('fires Google alone when Microsoft is not configured', () => {
    const { w } = fakeWindow();
    expect(firePurchase(GOOGLE, PURCHASE, w)).toEqual(['google']);
  });
  it('reports only what actually fired when a tag is configured but absent from the page', () => {
    const { w } = fakeWindow({ google: false, microsoft: true });
    expect(firePurchase(BOTH, PURCHASE, w)).toEqual(['microsoft']);
  });
  it('fires nothing for an excluded user', () => {
    const { w, gcalls, ucalls } = fakeWindow();
    expect(firePurchase({ ...BOTH, analyticsExclude: true }, PURCHASE, w)).toEqual([]);
    expect(gcalls).toHaveLength(0);
    expect(ucalls).toHaveLength(0);
  });
  it('is safe with no config and no window (SSR)', () => {
    expect(firePurchase(null, PURCHASE, undefined)).toEqual([]);
    expect(firePurchase(BOTH, PURCHASE, undefined)).toEqual([]);
  });
});

describe('fireLead', () => {
  it('fires both platforms and passes the de-dup id through', () => {
    const { w, gcalls, ucalls } = fakeWindow();
    expect(fireLead(BOTH, 'create', 'ABC123', w)).toEqual(['google', 'microsoft']);
    expect(gcalls[0][2]).toMatchObject({ transaction_id: 'ABC123' });
    expect(ucalls[0]).toEqual(['event', 'create_event', { transaction_id: 'ABC123' }]);
  });
  it('picks the right goal per action', () => {
    const { w, ucalls } = fakeWindow();
    fireLead(BOTH, 'signup', undefined, w);
    expect(ucalls[0][1]).toBe('sign_up');
  });
  it('fires nothing when that action has no goal on either platform', () => {
    const { w } = fakeWindow();
    expect(fireLead({ msPurchaseEvent: 'purchase' }, 'signup', undefined, w)).toEqual([]);
  });
});

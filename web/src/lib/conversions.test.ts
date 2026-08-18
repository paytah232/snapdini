import { describe, it, expect, vi } from 'vitest';
import { purchaseSendTo, conversionArgs, firePurchaseConversion } from './conversions';

describe('purchaseSendTo', () => {
  it('composes tag id + label when both valid', () => {
    expect(purchaseSendTo('AW-TEST123456', 'TESTlbl_123')).toBe('AW-TEST123456/TESTlbl_123');
    expect(purchaseSendTo('  AW-TEST123  ', '  Lbl_abc-123  ')).toBe('AW-TEST123/Lbl_abc-123'); // trimmed
  });
  it('is null when the id or label is missing / malformed', () => {
    expect(purchaseSendTo('', 'TESTlbl_123')).toBeNull();
    expect(purchaseSendTo('AW-TEST123456', '')).toBeNull();
    expect(purchaseSendTo('not-a-tag', 'TESTlbl_123')).toBeNull();
    expect(purchaseSendTo('AW-TEST123456', 'bad label!')).toBeNull();
    expect(purchaseSendTo(null, null)).toBeNull();
  });
});

describe('conversionArgs', () => {
  it('converts cents to major units and upper-cases currency', () => {
    expect(conversionArgs('AW-1/x', { amountTotalCents: 1500, currency: 'aud', transactionId: 'pi_1' })).toEqual({
      send_to: 'AW-1/x',
      value: 15,
      currency: 'AUD',
      transaction_id: 'pi_1',
    });
  });
  it('handles $0 (100%-off promo) and rounds cents', () => {
    expect(conversionArgs('AW-1/x', { amountTotalCents: 0, currency: 'AUD', transactionId: 't' }).value).toBe(0);
    expect(conversionArgs('AW-1/x', { amountTotalCents: 399, currency: 'AUD', transactionId: 't' }).value).toBe(3.99);
  });
  it('never emits a negative value', () => {
    expect(conversionArgs('AW-1/x', { amountTotalCents: -50, currency: 'AUD', transactionId: 't' }).value).toBe(0);
  });
});

describe('firePurchaseConversion', () => {
  const input = { amountTotalCents: 500, currency: 'AUD', transactionId: 'pi_abc' };

  it('fires gtag with the conversion event when everything is present', () => {
    const gtag = vi.fn();
    const fired = firePurchaseConversion(gtag, 'AW-TEST123456/TESTlbl_123', input);
    expect(fired).toBe(true);
    expect(gtag).toHaveBeenCalledWith('event', 'conversion', {
      send_to: 'AW-TEST123456/TESTlbl_123',
      value: 5,
      currency: 'AUD',
      transaction_id: 'pi_abc',
    });
  });

  it('is a no-op (no throw) when the tag or send_to is missing', () => {
    const gtag = vi.fn();
    expect(firePurchaseConversion(gtag, null, input)).toBe(false);
    expect(firePurchaseConversion(undefined, 'AW-1/x', input)).toBe(false);
    expect(gtag).not.toHaveBeenCalled();
  });
});

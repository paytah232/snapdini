import { describe, it, expect, vi } from 'vitest';
import { composeSendTo, purchaseSendTo, conversionArgs, firePurchaseConversion, fireLeadConversion } from './conversions';

describe('composeSendTo', () => {
  it('composes tag id + label when both valid', () => {
    expect(composeSendTo('AW-TEST123456', 'TESTlbl_123')).toBe('AW-TEST123456/TESTlbl_123');
    expect(composeSendTo('  AW-TEST123  ', '  Lbl_abc-123  ')).toBe('AW-TEST123/Lbl_abc-123'); // trimmed
  });
  it('is null when the id or label is missing / malformed', () => {
    expect(composeSendTo('', 'TESTlbl_123')).toBeNull();
    expect(composeSendTo('AW-TEST123456', '')).toBeNull();
    expect(composeSendTo('not-a-tag', 'TESTlbl_123')).toBeNull();
    expect(composeSendTo('AW-TEST123456', 'bad label!')).toBeNull();
    expect(composeSendTo(null, null)).toBeNull();
  });
  it('purchaseSendTo is the same generic composer (back-compat alias)', () => {
    expect(purchaseSendTo).toBe(composeSendTo);
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

describe('fireLeadConversion (sign up / create event — no value)', () => {
  it('fires a value-less conversion with a transaction_id', () => {
    const gtag = vi.fn();
    expect(fireLeadConversion(gtag, 'AW-TEST123456/TESTlbl_123', 'ABCD1234')).toBe(true);
    expect(gtag).toHaveBeenCalledWith('event', 'conversion', {
      send_to: 'AW-TEST123456/TESTlbl_123',
      transaction_id: 'ABCD1234',
    });
  });
  it('omits transaction_id when not provided', () => {
    const gtag = vi.fn();
    fireLeadConversion(gtag, 'AW-TEST123456/TESTlbl_123');
    expect(gtag).toHaveBeenCalledWith('event', 'conversion', { send_to: 'AW-TEST123456/TESTlbl_123' });
  });
  it('is a no-op when the tag or send_to is missing', () => {
    const gtag = vi.fn();
    expect(fireLeadConversion(gtag, null, 'x')).toBe(false);
    expect(fireLeadConversion(undefined, 'AW-1/x', 'x')).toBe(false);
    expect(gtag).not.toHaveBeenCalled();
  });
});

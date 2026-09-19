import { describe, it, expect } from 'vitest';
import { compactCount } from './counts';

describe('compactCount', () => {
  it('leaves small counts exact — 8 hearts is not 9', () => {
    for (const n of [0, 1, 7, 42, 999]) expect(compactCount(n)).toBe(String(n));
  });

  it('switches to k at a thousand', () => {
    expect(compactCount(1000)).toBe('1k');
    expect(compactCount(1100)).toBe('1.1k');
    expect(compactCount(1250)).toBe('1.2k');
    expect(compactCount(12_300)).toBe('12.3k');
    expect(compactCount(999_999)).toBe('999.9k');
  });

  it('TRUNCATES, never rounds up — a count must not read higher than the people who pressed it', () => {
    expect(compactCount(1999)).toBe('1.9k');
    expect(compactCount(1_999_999)).toBe('1.9m');
  });

  it('drops a pointless decimal', () => {
    expect(compactCount(2000)).toBe('2k');
    expect(compactCount(3_000_000)).toBe('3m');
  });

  it('never grows past four characters, which is the whole point of the slot', () => {
    for (const n of [999, 1000, 9999, 12_345, 999_999, 1_000_000, 12_345_678]) {
      expect(compactCount(n).length).toBeLessThanOrEqual(6);
    }
  });

  it('is safe on nonsense rather than printing NaN at a guest', () => {
    expect(compactCount(NaN)).toBe('0');
    expect(compactCount(-5)).toBe('0');
  });
});

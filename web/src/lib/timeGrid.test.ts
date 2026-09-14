// The snap exists because `step` on <input type="time"> only validates. An off-grid value is still
// accepted into the field, and the browser's own picker offers 5-minute options whatever step says,
// so a host could pick 9:05, see 9:05, and have the sweep act on a different minute entirely.
import { describe, it, expect } from 'vitest';
import { snapDown, snapUp, isOnGrid, parseHhmm, TICK_MIN } from './timeGrid';

describe('snapping a wall-clock time onto the 15-minute grid', () => {
  it('leaves a time that is already on it', () => {
    for (const t of ['00:00', '09:00', '09:15', '09:30', '09:45', '23:45']) {
      expect(snapDown(t)).toBe(t);
      expect(isOnGrid(t)).toBe(true);
    }
  });

  it('rounds DOWN, never up', () => {
    expect(snapDown('09:01')).toBe('09:00');
    expect(snapDown('09:07')).toBe('09:00');
    expect(snapDown('09:14')).toBe('09:00');
    expect(snapDown('09:16')).toBe('09:15');
    expect(snapDown('09:44')).toBe('09:30');
    expect(snapDown('09:59')).toBe('09:45');
  });

  it('never rolls into the next hour', () => {
    // The reason it is down and not to-nearest: 9:50 rounded UP is 10:00, and a guest at the door
    // at 9:55 would find the event had not started. Early costs nothing; late locks someone out.
    expect(snapDown('09:50')).toBe('09:45');
    expect(snapDown('23:59')).toBe('23:45');
  });

  it('leaves an empty time empty', () => {
    // Blank means "I only picked a day" — the server reads that as midnight. Turning it into 00:00
    // here would convert an absence into a decision the host never made.
    expect(snapDown('')).toBe('');
    expect(snapDown(null)).toBe('');
    expect(snapDown(undefined)).toBe('');
    expect(isOnGrid('')).toBe(true);
  });

  it('leaves anything that is not a time alone rather than inventing one', () => {
    for (const junk of ['9', 'nine', '25:00', '09:60', '--:--']) {
      expect(snapDown(junk)).toBe(junk);
      expect(parseHhmm(junk)).toBeNull();
    }
  });

  it('flags exactly the values that will move', () => {
    expect(isOnGrid('09:05')).toBe(false);
    expect(isOnGrid('09:15')).toBe(true);
  });

  it('always returns something already on the grid', () => {
    for (let m = 0; m < 24 * 60; m++) {
      const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const s = snapDown(t);
      expect(parseHhmm(s)! % TICK_MIN).toBe(0);
      expect(parseHhmm(s)!).toBeLessThanOrEqual(m);   // never forward
      expect(m - parseHhmm(s)!).toBeLessThan(TICK_MIN);
    }
  });
});

// The two ends of the product want opposite answers, and getting it backwards is unrecoverable in
// one direction only: a reveal that fires early has already shown everybody the album.
describe('snapping upward, for anything that must not happen early', () => {
  it('rounds UP to the next quarter', () => {
    expect(snapUp('09:01')).toBe('09:15');
    expect(snapUp('09:14')).toBe('09:15');
    expect(snapUp('09:16')).toBe('09:30');
    expect(snapUp('09:46')).toBe('10:00');
  });

  it('leaves a time already on the grid where it is', () => {
    for (const t of ['00:00', '09:15', '23:45']) expect(snapUp(t)).toBe(t);
  });

  it('never wraps past midnight into the previous day', () => {
    // 23:50 has nowhere forward to go; rolling to 00:00 would move the reveal a whole day EARLIER,
    // which is the exact failure this direction exists to prevent.
    expect(snapUp('23:50')).toBe('23:45');
    expect(snapUp('23:59')).toBe('23:45');
  });

  it('leaves an empty or unparseable value alone', () => {
    expect(snapUp('')).toBe('');
    expect(snapUp('nine')).toBe('nine');
  });

  it('is the mirror of snapDown everywhere they can both act', () => {
    for (let m = 0; m < 23 * 60 + 45; m++) {
      const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const up = parseHhmm(snapUp(t))!, down = parseHhmm(snapDown(t))!;
      expect(up).toBeGreaterThanOrEqual(m);
      expect(down).toBeLessThanOrEqual(m);
      expect(up % TICK_MIN).toBe(0);
      if (m % TICK_MIN !== 0) expect(up - down).toBe(TICK_MIN);
    }
  });
});


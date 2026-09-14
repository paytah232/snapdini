// A reveal has exactly one job: happen when the host said it would. Two things can break that
// quietly, and neither shows up as an error anywhere — the host is simply told one time and the
// guests get another.
//
//   · the tick. The moment is rounded before it is stored, so the number the UI promises and the
//     number the gate compares against have to be the same rounding, in the same direction.
//   · the zone. "7 pm" is a wall clock reading, and the server's clock is UTC. Resolving it in the
//     wrong zone is off by hours, is invisible in testing from one timezone, and is worst for
//     exactly the host who most needs it right — the one setting up an event somewhere else.
import { describe, it, expect } from 'vitest';
import {
  REVEAL_TICK_MS, REVEAL_CUSTOM, ceilToRevealTick,
  zonedWallTimeToMs, msToZonedWallTime, scheduledRevealAt,
} from '../../../shared/reveal';

const utc = (iso: string) => Date.parse(iso);

describe('the tick a reveal is pinned to', () => {
  it('is the 15 minutes the finest sweep already runs at', () => {
    expect(REVEAL_TICK_MS).toBe(15 * 60 * 1000);
  });

  it('divides an hour, so the grid falls on :00 :15 :30 :45 and the UI can name it', () => {
    expect(3_600_000 % REVEAL_TICK_MS).toBe(0);
    expect(REVEAL_TICK_MS / 60000).toBe(15);
  });

  it('rounds a chosen moment UP, never back', () => {
    // The direction is the whole point: 7:05 → 7:15 is a host waiting ten more minutes, 7:05 → 7:00
    // is photos on screen before the moment they picked, and that one cannot be taken back.
    const base = utc('2026-10-03T09:00:00Z');
    expect(ceilToRevealTick(base + 5 * 60_000)).toBe(base + REVEAL_TICK_MS);
    expect(ceilToRevealTick(base + 60_000)).toBe(base + REVEAL_TICK_MS);
    expect(ceilToRevealTick(base + 14 * 60_000 + 59_000)).toBe(base + REVEAL_TICK_MS);
    expect(ceilToRevealTick(base + 16 * 60_000)).toBe(base + 2 * REVEAL_TICK_MS);
  });

  it('leaves a moment already on the grid exactly where it is', () => {
    // Idempotent, because a saved event is re-rounded on every settings save: a rounding that crept
    // forward each time would walk a wedding reveal into the following morning.
    for (const t of ['2026-10-03T09:00:00Z', '2026-10-03T09:15:00Z', '2026-10-03T09:30:00Z', '2026-10-03T09:45:00Z']) {
      const ms = utc(t);
      expect(ceilToRevealTick(ms)).toBe(ms);
      expect(ceilToRevealTick(ceilToRevealTick(ms))).toBe(ms);
    }
  });

  it('lands on a quarter hour of the HOST’s clock, even on a :45 zone', () => {
    // Every zone in use is a whole number of quarter-hours off UTC, which is why a grid laid out in
    // epoch ms is also a grid on the wall clock. Nepal and the Chathams are the awkward cases.
    for (const zone of ['Asia/Kathmandu', 'Pacific/Chatham', 'Asia/Kolkata', 'Australia/Brisbane', 'America/New_York']) {
      const chosen = zonedWallTimeToMs('2026-12-25', '19:05', zone);
      expect(chosen).not.toBeNull();
      expect(msToZonedWallTime(ceilToRevealTick(chosen as number), zone)?.time).toBe('19:15');
    }
  });
});

describe('a wall-clock time means what it says in the event’s zone', () => {
  it('resolves a fixed-offset zone against UTC', () => {
    // Brisbane never moves; anything other than +10 here is a plain arithmetic fault.
    expect(zonedWallTimeToMs('2026-12-25', '19:00', 'Australia/Brisbane')).toBe(utc('2026-12-25T09:00:00Z'));
    expect(zonedWallTimeToMs('2026-12-25', '19:00', 'Australia/Perth')).toBe(utc('2026-12-25T11:00:00Z'));
    expect(zonedWallTimeToMs('2026-12-25', '19:00', 'UTC')).toBe(utc('2026-12-25T19:00:00Z'));
  });

  it('uses the offset in force on the DAY, not the offset today', () => {
    // The same clock reading is +11 in Sydney's summer and +10 in its winter. An event booked in
    // one season and revealed in the other is the case a single fixed offset gets wrong by an hour.
    expect(zonedWallTimeToMs('2026-12-25', '19:00', 'Australia/Sydney')).toBe(utc('2026-12-25T08:00:00Z'));
    expect(zonedWallTimeToMs('2026-07-01', '19:00', 'Australia/Sydney')).toBe(utc('2026-07-01T09:00:00Z'));
    expect(zonedWallTimeToMs('2026-06-15', '19:00', 'Europe/London')).toBe(utc('2026-06-15T18:00:00Z'));
    expect(zonedWallTimeToMs('2026-01-15', '19:00', 'Europe/London')).toBe(utc('2026-01-15T19:00:00Z'));
    expect(zonedWallTimeToMs('2026-07-04', '19:00', 'America/New_York')).toBe(utc('2026-07-04T23:00:00Z'));
    expect(zonedWallTimeToMs('2026-01-04', '19:00', 'America/New_York')).toBe(utc('2026-01-05T00:00:00Z'));
  });

  it('handles the two hours a year that are not ordinary', () => {
    // Spring forward: 02:30 never happened in Sydney on 4 Oct 2026. It resolves to the instant just
    // after the jump — the next moment the host could have meant — rather than to null or to an
    // hour earlier, which would reveal the photos before they asked.
    expect(zonedWallTimeToMs('2026-10-04', '02:30', 'Australia/Sydney')).toBe(utc('2026-10-03T16:30:00Z'));
    expect(msToZonedWallTime(utc('2026-10-03T16:30:00Z'), 'Australia/Sydney')?.time).toBe('03:30');

    // Fall back: 02:30 happened twice on 5 Apr 2026. It resolves to the LATER one, so a reveal is
    // never earlier than the host's reading of the clock.
    expect(zonedWallTimeToMs('2026-04-05', '02:30', 'Australia/Sydney')).toBe(utc('2026-04-04T16:30:00Z'));
    expect(msToZonedWallTime(utc('2026-04-04T16:30:00Z'), 'Australia/Sydney')?.time).toBe('02:30');

    // Same two, northern hemisphere — where the transitions run the other way round the calendar.
    // Both still land LATE, which is the property that has to hold everywhere and not just in the
    // zone whoever wrote this happened to be sitting in.
    expect(zonedWallTimeToMs('2026-03-08', '02:30', 'America/New_York')).toBe(utc('2026-03-08T07:30:00Z'));
    expect(msToZonedWallTime(utc('2026-03-08T07:30:00Z'), 'America/New_York')?.time).toBe('03:30');
    expect(zonedWallTimeToMs('2026-11-01', '01:30', 'America/New_York')).toBe(utc('2026-11-01T06:30:00Z'));
    expect(msToZonedWallTime(utc('2026-11-01T06:30:00Z'), 'America/New_York')?.time).toBe('01:30');
    // …and the earlier of the repeated hours is a different instant, so "the later one" is a real
    // choice rather than an accident of which one Intl happened to name.
    expect(msToZonedWallTime(utc('2026-11-01T05:30:00Z'), 'America/New_York')?.time).toBe('01:30');
  });

  it('survives midnight, which the h23 clock reports as hour 24', () => {
    expect(zonedWallTimeToMs('2026-12-25', '00:00', 'Australia/Brisbane')).toBe(utc('2026-12-24T14:00:00Z'));
    expect(msToZonedWallTime(utc('2026-12-24T14:00:00Z'), 'Australia/Brisbane')).toEqual({ date: '2026-12-25', time: '00:00' });
  });

  it('round-trips the moment back into the boxes the host typed it into', () => {
    for (const zone of ['Australia/Brisbane', 'Australia/Sydney', 'America/New_York', 'Europe/London', 'Asia/Kathmandu']) {
      for (const [date, time] of [['2026-12-25', '19:15'], ['2026-07-01', '06:30'], ['2026-03-14', '23:45']]) {
        const ms = zonedWallTimeToMs(date, time, zone);
        expect(ms).not.toBeNull();
        expect(msToZonedWallTime(ms as number, zone)).toEqual({ date, time });
      }
    }
  });

  it('refuses rather than guessing when it cannot tell what was meant', () => {
    // Null, never "the machine's own zone" — that is UTC on the server and the host's phone in the
    // browser, which is precisely the disagreement this exists to prevent.
    expect(zonedWallTimeToMs('', '19:00', 'Australia/Brisbane')).toBeNull();
    expect(zonedWallTimeToMs('2026-12-25', '', 'Australia/Brisbane')).toBeNull();
    expect(zonedWallTimeToMs('25/12/2026', '19:00', 'Australia/Brisbane')).toBeNull();
    expect(zonedWallTimeToMs('2026-12-25', '7pm', 'Australia/Brisbane')).toBeNull();
    expect(zonedWallTimeToMs('2026-12-25', '19:00', 'Middle/Earth')).toBeNull();
    expect(msToZonedWallTime(utc('2026-12-25T09:00:00Z'), 'Middle/Earth')).toBeNull();
  });
});

describe('when the gallery unlocks by itself', () => {
  const base = { revealMode: 'at_end', expiresAt: utc('2026-12-25T09:00:00Z'), revealDelayHours: 0 };

  it('is nothing at all unless the mode schedules one', () => {
    expect(scheduledRevealAt({ ...base, revealMode: 'instant' })).toBeNull();
    expect(scheduledRevealAt({ ...base, revealMode: 'manual' })).toBeNull();
    // …including when a custom instant is still on the row from before the mode was changed.
    expect(scheduledRevealAt({ ...base, revealMode: 'manual', revealAt: utc('2026-12-26T09:00:00Z') })).toBeNull();
  });

  it('is the end plus the delay for every event that predates the custom column', () => {
    // The regression that matters most: an absent or null reveal_at must behave EXACTLY as before,
    // for every event already created.
    expect(scheduledRevealAt(base)).toBe(base.expiresAt);
    expect(scheduledRevealAt({ ...base, revealAt: null })).toBe(base.expiresAt);
    expect(scheduledRevealAt({ ...base, revealDelayHours: 3 })).toBe(utc('2026-12-25T12:00:00Z'));
    expect(scheduledRevealAt({ ...base, revealDelayHours: 168, revealAt: null })).toBe(utc('2027-01-01T09:00:00Z'));
    // The three rungs added alongside the custom picker.
    expect(scheduledRevealAt({ ...base, revealDelayHours: 48 })).toBe(utc('2026-12-27T09:00:00Z'));
    expect(scheduledRevealAt({ ...base, revealDelayHours: 72 })).toBe(utc('2026-12-28T09:00:00Z'));
  });

  it('is the host’s own instant when they set one, whatever the delay says', () => {
    const at = utc('2026-12-31T12:15:00Z');
    expect(scheduledRevealAt({ ...base, revealAt: at })).toBe(at);
    expect(scheduledRevealAt({ ...base, revealDelayHours: 24, revealAt: at })).toBe(at);
  });

  it('does not move when the event is rescheduled, which is why it is stored absolute', () => {
    // A delay is anchored to expires_at, so moving the event drags it. An instant the host chose
    // on purpose must not follow the event around.
    const at = utc('2026-12-31T12:15:00Z');
    const moved = { ...base, expiresAt: utc('2027-02-01T09:00:00Z'), revealAt: at };
    expect(scheduledRevealAt(moved)).toBe(at);
    expect(scheduledRevealAt({ ...moved, revealAt: null })).toBe(moved.expiresAt);
  });
});

describe('the sentinel the delay control carries', () => {
  it('is a string, so it can never be mistaken for an hour count', () => {
    expect(typeof REVEAL_CUSTOM).toBe('string');
    expect(Number.isNaN(parseInt(REVEAL_CUSTOM, 10))).toBe(true);
    // Which is what makes the server's existing clamp safe: 'custom' falls to a 0-hour delay, and
    // the absolute instant it resolves separately is what actually wins.
    expect(Math.min(Math.max(parseInt(REVEAL_CUSTOM, 10) || 0, 0), 168)).toBe(0);
  });
});

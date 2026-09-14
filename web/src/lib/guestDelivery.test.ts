// The two rules behind "how do my guests get the photos" that fail silently when they are wrong:
// a day-before reminder offered where no day exists (the host turns it on and nothing ever
// happens), and a scheduled send placed before the reveal (the guest gets a link to a locked
// gallery). Neither raises anything anywhere, so they are pinned here.
import { describe, it, expect } from 'vitest';
import {
  GUEST_DELIVERY_DEFAULT, GUEST_DELIVERY_OPTIONS, GUEST_DELIVERY_AT_CREATION, REMINDER_LEAD_MS,
  guestReleaseAt, isManualDelivery, releaseDateKnown, reminderCanFire, reminderFiresAt,
  revealInstant, scheduledSendIssue, scopeFor,
} from './guestDelivery';

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const ENDS = at('2026-10-03T09:00:00Z');

describe('the options a host is offered', () => {
  it('keeps the behaviour every existing event already has as the default', () => {
    // An event created before this question existed must look and behave exactly as it does today.
    expect(GUEST_DELIVERY_DEFAULT).toBe('all_on_reveal');
  });

  it('offers all four, worded as outcomes rather than as the stored value', () => {
    expect(GUEST_DELIVERY_OPTIONS.map((o) => o.value))
      .toEqual(['all_on_reveal', 'favourites_manual', 'scheduled', 'manual']);
    // …and the wizard offers the subset a host can answer before the event exists. The other two
    // ask about photographs nobody has taken yet, so they belong on the event page.
    expect(GUEST_DELIVERY_AT_CREATION).toEqual(['all_on_reveal', 'manual']);
    expect(GUEST_DELIVERY_AT_CREATION).toContain(GUEST_DELIVERY_DEFAULT);
    for (const v of GUEST_DELIVERY_AT_CREATION) {
      expect(GUEST_DELIVERY_OPTIONS.some((o) => o.value === v)).toBe(true);
    }
    for (const o of GUEST_DELIVERY_OPTIONS) {
      expect(o.label).not.toContain('_');
      expect(o.desc.length).toBeGreaterThan(0);
    }
  });

  it('knows which settings never send on their own', () => {
    expect(isManualDelivery('favourites_manual')).toBe(true);
    expect(isManualDelivery('manual')).toBe(true);
    expect(isManualDelivery('all_on_reveal')).toBe(false);
    expect(isManualDelivery('scheduled')).toBe(false);
  });
});

describe('the moment the photos reach the guests', () => {
  const reveal = ENDS + 48 * HOUR;

  it('is the reveal when everything goes out on reveal', () => {
    expect(guestReleaseAt('all_on_reveal', reveal, null)).toBe(reveal);
  });

  it('is the chosen time when the host scheduled one', () => {
    const sendAt = reveal + 2 * HOUR;
    expect(guestReleaseAt('scheduled', reveal, sendAt)).toBe(sendAt);
  });

  it('is unknown on both manual settings, even though the reveal itself is known', () => {
    // The host has not decided yet, so nothing downstream may invent a date for them.
    expect(guestReleaseAt('favourites_manual', reveal, null)).toBeNull();
    expect(guestReleaseAt('manual', reveal, null)).toBeNull();
  });

  it('is unknown when only the host can open the gallery', () => {
    expect(guestReleaseAt('all_on_reveal', null, null)).toBeNull();
  });
});

describe('the reveal instant the rest of this hangs off', () => {
  it('takes the delay after the end when no exact moment was picked', () => {
    expect(revealInstant({ revealMode: 'at_end', endsAt: ENDS, delayHours: 24, customAt: null }))
      .toBe(ENDS + 24 * HOUR);
  });

  it('lets an exact moment beat the delay', () => {
    const exact = ENDS + 90 * HOUR;
    expect(revealInstant({ revealMode: 'at_end', endsAt: ENDS, delayHours: 24, customAt: exact }))
      .toBe(exact);
  });

  it('has no instant for a manual or instant reveal', () => {
    expect(revealInstant({ revealMode: 'manual', endsAt: ENDS, delayHours: 24, customAt: null })).toBeNull();
    expect(revealInstant({ revealMode: 'instant', endsAt: ENDS, delayHours: 0, customAt: null })).toBeNull();
  });
});

describe('offering the day-before reminder', () => {
  it('is offered when the gallery opens a clear day or more after the event ends', () => {
    expect(reminderCanFire(ENDS, ENDS + 48 * HOUR)).toBe(true);
  });

  it('is NOT offered at exactly 24 hours, because the reminder would land on the end itself', () => {
    // This test used to assert the opposite, and passed, while the server's test asserted THIS and
    // also passed — the two halves each had their own copy of the rule, one character apart. The
    // host was shown the switch on, with a fire time, and the sweep never sent it. One rule now,
    // in shared/guest-reminder.ts, so a disagreement like that has nowhere left to hide.
    expect(reminderCanFire(ENDS, ENDS + REMINDER_LEAD_MS)).toBe(false);
    expect(reminderFiresAt(ENDS, ENDS + REMINDER_LEAD_MS)).toBeNull();
  });

  it('IS offered a minute over 24 hours — the first gap with room in it', () => {
    expect(reminderCanFire(ENDS, ENDS + REMINDER_LEAD_MS + 60_000)).toBe(true);
    expect(reminderFiresAt(ENDS, ENDS + REMINDER_LEAD_MS + 60_000)).toBe(ENDS + 60_000);
  });

  it('is NOT offered a minute under 24 hours', () => {
    // One minute short and the reminder would fire before the event has even ended: a switch the
    // host can turn on that nothing will ever act on.
    expect(reminderCanFire(ENDS, ENDS + REMINDER_LEAD_MS - 60_000)).toBe(false);
    expect(reminderFiresAt(ENDS, ENDS + REMINDER_LEAD_MS - 60_000)).toBeNull();
  });

  it('is NOT offered for the common case of a few hours after the end', () => {
    expect(reminderCanFire(ENDS, ENDS + 3 * HOUR)).toBe(false);
    expect(reminderCanFire(ENDS, ENDS)).toBe(false);
  });

  it('is NOT offered when no release moment is known at all', () => {
    expect(reminderCanFire(ENDS, null)).toBe(false);
    expect(reminderFiresAt(ENDS, null)).toBeNull();
  });

  it('fires exactly 24 hours before the gallery opens', () => {
    const release = ENDS + 72 * HOUR;
    expect(reminderFiresAt(ENDS, release)).toBe(release - REMINDER_LEAD_MS);
  });

  it('is never offered on a setting that has no release moment, however long the event', () => {
    // A month-long event on "I'll send it myself" still cannot have a day-before reminder.
    const release = guestReleaseAt('manual', ENDS + 720 * HOUR, null);
    expect(reminderCanFire(ENDS, release)).toBe(false);
  });
});

describe('printing the release date in the event-end email', () => {
  it('prints one when the gallery opens after the email goes out', () => {
    expect(releaseDateKnown(ENDS, ENDS + 1)).toBe(true);
  });

  it('prints none when the gallery is already open by then', () => {
    // An instant reveal, or a zero delay: there is no future date to promise, so the email is a
    // thank-you and nothing more.
    expect(releaseDateKnown(ENDS, ENDS)).toBe(false);
    expect(releaseDateKnown(ENDS, ENDS - HOUR)).toBe(false);
  });

  it('prints none when nobody has set a release moment', () => {
    expect(releaseDateKnown(ENDS, null)).toBe(false);
  });
});

describe('a scheduled send is never before the reveal', () => {
  const reveal = ENDS + 24 * HOUR;

  it('accepts a time after the reveal', () => {
    expect(scheduledSendIssue(reveal + 1, reveal)).toBeNull();
  });

  it('accepts a time exactly on the reveal', () => {
    // The gallery is open at that instant, so the link works — only earlier is a problem.
    expect(scheduledSendIssue(reveal, reveal)).toBeNull();
  });

  it('refuses a time before the reveal rather than quietly moving it', () => {
    expect(scheduledSendIssue(reveal - 60_000, reveal)).toBe('before-reveal');
    expect(scheduledSendIssue(ENDS, reveal)).toBe('before-reveal');
  });

  it('asks for the time when the host has not given one', () => {
    expect(scheduledSendIssue(null, reveal)).toBe('missing');
    expect(scheduledSendIssue(null, null)).toBe('missing');
  });

  it('imposes no floor when only the host can open the gallery', () => {
    // A manual reveal has no instant to be "before", so any time the host picks is allowed.
    expect(scheduledSendIssue(ENDS - 100 * HOUR, null)).toBeNull();
  });
});

describe('which photos a send carries', () => {
  it('is fixed by the two options that already say it', () => {
    // Otherwise the stored scope could contradict the words the host chose the option by.
    expect(scopeFor('all_on_reveal', 'favourites')).toBe('all');
    expect(scopeFor('favourites_manual', 'all')).toBe('favourites');
  });

  it('is the host’s own choice on the two that do not', () => {
    expect(scopeFor('scheduled', 'favourites')).toBe('favourites');
    expect(scopeFor('scheduled', 'all')).toBe('all');
    expect(scopeFor('manual', 'favourites')).toBe('favourites');
  });
});

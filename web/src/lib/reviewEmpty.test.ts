import { describe, it, expect } from 'vitest';
import { reviewEmptyState } from './reviewEmpty';

// Branch and action only — never the wording. Copy is meant to be edited; a test that breaks on a
// comma is one people learn to ignore.
describe('what the review screen says when it is empty', () => {
  it('tells an upcoming event to go and share its link', () => {
    const s = reviewEmptyState({ isUpcoming: true, participantCount: 0, startsAtLabel: 'Sat 7pm' });
    expect(s.key).toBe('upcoming');
    expect(s.action?.kind).toBe('link');
    expect(s.body, 'it should say WHEN, not "soon"').toContain('Sat 7pm');
  });

  it('tells a live event with nobody in it that nobody is in it', () => {
    const s = reviewEmptyState({ participantCount: 0 });
    expect(s.key).toBe('nobody');
    expect(s.action?.kind).toBe('link');
  });

  // The page does not poll, so the only honest offer here is one that re-reads.
  it('offers a re-read once guests are in and the wait is the answer', () => {
    const s = reviewEmptyState({ participantCount: 4 });
    expect(s.key).toBe('waiting');
    expect(s.action?.kind).toBe('refresh');
    expect(s.title).toContain('4 guests are in');
  });

  it('counts one guest as one guest', () => {
    expect(reviewEmptyState({ participantCount: 1 }).title).toContain('1 guest is in');
    expect(reviewEmptyState({ isExpired: true, participantCount: 1 }).body).toContain('1 guest joined');
  });

  // "It is over" beats "waiting for a photo" on an event that will never get one — so expired is
  // tested FIRST, and this is the case that proves the order.
  it('says an event is over even when it had guests', () => {
    const s = reviewEmptyState({ isExpired: true, participantCount: 9 });
    expect(s.key).toBe('finished');
    expect(s.action, 'there is nothing left to do').toBeNull();
    expect(s.body).toContain('9 guests joined');
  });

  it('never offers an action that leads nowhere on a finished event', () => {
    expect(reviewEmptyState({ isExpired: true, participantCount: 0 }).action).toBeNull();
  });

  it('still answers when it knows nothing at all', () => {
    for (const input of [null, undefined, {}]) {
      const s = reviewEmptyState(input);
      expect(s.title.length, 'an empty state must never be empty').toBeGreaterThan(0);
      expect(s.icon.length).toBeGreaterThan(0);
    }
  });
});

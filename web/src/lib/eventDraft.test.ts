import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { saveDraft, readDraft, hasFreshDraft, clearDraft, DRAFT_KEY, DRAFT_TTL_MS } from './eventDraft';

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('saveDraft / readDraft', () => {
  it('round-trips the fields someone typed', () => {
    saveDraft({ name: "Lisa's Birthday", maxGuests: 150 });
    expect(readDraft()).toMatchObject({ name: "Lisa's Birthday", maxGuests: 150 });
  });
  it('does NOT consume, so two tabs cannot race each other for it', () => {
    // The whole point: reading used to remove, and on one device the tab that opened the
    // verification email and the tab that was polling both went to /app — whichever mounted first
    // ate the draft and the other showed an empty form.
    saveDraft({ name: 'X' });
    expect(readDraft()).toMatchObject({ name: 'X' });
    expect(readDraft()).toMatchObject({ name: 'X' });
    expect(readDraft()).toMatchObject({ name: 'X' });
  });
  it('ends only when the event is created', () => {
    saveDraft({ name: 'X' });
    clearDraft();
    expect(readDraft()).toBeNull();
  });
  it('stamps the draft so age can be judged', () => {
    saveDraft({ name: 'X' });
    expect(typeof JSON.parse(localStorage.getItem(DRAFT_KEY)!).savedAt).toBe('number');
  });
  it('uses localStorage, which survives the new tab a verification link opens', () => {
    saveDraft({ name: 'X' });
    expect(localStorage.getItem(DRAFT_KEY)).toBeTruthy();
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

describe('staleness', () => {
  it('drops a draft older than the window', () => {
    saveDraft({ name: 'old' });
    vi.setSystemTime(Date.now() + DRAFT_TTL_MS + 1000);
    expect(readDraft()).toBeNull();
  });
  it('clears a stale draft on read rather than leaving it to reappear', () => {
    saveDraft({ name: 'old' });
    vi.setSystemTime(Date.now() + DRAFT_TTL_MS + 1000);
    readDraft();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
  it('keeps one still inside the window', () => {
    saveDraft({ name: 'recent' });
    vi.setSystemTime(Date.now() + DRAFT_TTL_MS - 1000);
    expect(readDraft()).toMatchObject({ name: 'recent' });
  });
  it('clears a stale draft rather than letting it reappear later', () => {
    saveDraft({ name: 'old' });
    vi.setSystemTime(Date.now() + DRAFT_TTL_MS + 1000);
    expect(hasFreshDraft()).toBe(false);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

describe('hasFreshDraft', () => {
  it('reports a waiting draft', () => {
    saveDraft({ name: 'X' });
    expect(hasFreshDraft()).toBe(true);
  });
  it('does not consume the draft either', () => {
    saveDraft({ name: 'X' });
    expect(hasFreshDraft()).toBe(true);
    expect(hasFreshDraft()).toBe(true);
    expect(readDraft()).toMatchObject({ name: 'X' });
  });
  it('is false with nothing stored', () => expect(hasFreshDraft()).toBe(false));
  it('is false for a draft with no stamp (written by an older build)', () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: 'unstamped' }));
    expect(hasFreshDraft()).toBe(false);
  });
});

describe('storage being unavailable is never an error', () => {
  it('corrupt JSON reads as "no draft" instead of throwing', () => {
    localStorage.setItem(DRAFT_KEY, '{not json');
    expect(hasFreshDraft()).toBe(false);
    expect(readDraft()).toBeNull();
  });
  it('a throwing localStorage does not break saving or reading', () => {
    const boom = () => { throw new Error('private mode'); };
    const g = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    const s = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    const r = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
    expect(() => saveDraft({ name: 'X' })).not.toThrow();
    expect(readDraft()).toBeNull();
    expect(hasFreshDraft()).toBe(false);
    expect(() => clearDraft()).not.toThrow();
    g.mockRestore(); s.mockRestore(); r.mockRestore();
  });
});

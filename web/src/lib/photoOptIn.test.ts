import { describe, it, expect } from 'vitest';
import { looksLikeEmail, planOptIn, optInMessage } from './photoOptIn';

describe('looksLikeEmail', () => {
  it('accepts ordinary addresses, trimmed', () => {
    expect(looksLikeEmail('alex@example.com')).toBe(true);
    expect(looksLikeEmail('  alex@example.com  ')).toBe(true);
    expect(looksLikeEmail('alex.b+party@mail.example.co.uk')).toBe(true);
  });
  it('rejects the things a phone keyboard actually produces', () => {
    expect(looksLikeEmail('')).toBe(false);
    expect(looksLikeEmail('alex')).toBe(false);
    expect(looksLikeEmail('alex@example')).toBe(false);
    expect(looksLikeEmail('alex @example.com')).toBe(false);
    expect(looksLikeEmail('@example.com')).toBe(false);
  });
});

describe('planOptIn', () => {
  it('sends straight away when an address is already on file — no dialog, one tap', () => {
    expect(planOptIn({ hasEmail: true, asking: false, draft: '' })).toEqual({ kind: 'send' });
  });
  it('does NOT pass an address it was not given — the server uses the one on the row', () => {
    const step = planOptIn({ hasEmail: true, asking: false, draft: 'stale@example.com' });
    expect(step).toEqual({ kind: 'send' });
  });
  it('asks for an address when there is nowhere to send', () => {
    expect(planOptIn({ hasEmail: false, asking: false, draft: '' })).toEqual({ kind: 'ask' });
  });
  it('sends the typed address once the field is open', () => {
    expect(planOptIn({ hasEmail: false, asking: true, draft: '  alex@example.com ' }))
      .toEqual({ kind: 'send', email: 'alex@example.com' });
  });
  it('flags a bad address instead of sending it', () => {
    expect(planOptIn({ hasEmail: false, asking: true, draft: 'alex' })).toEqual({ kind: 'badEmail' });
    expect(planOptIn({ hasEmail: false, asking: true, draft: '' })).toEqual({ kind: 'badEmail' });
  });
  it('an open field wins over the address on file — that is the guest correcting it', () => {
    expect(planOptIn({ hasEmail: true, asking: true, draft: 'new@example.com' }))
      .toEqual({ kind: 'send', email: 'new@example.com' });
  });
});

describe('optInMessage', () => {
  it('names the address the server stored', () => {
    const m = optInMessage({ wantsPhotos: true, email: 'alex@example.com' });
    expect(m.headline).toContain('alex@example.com');
    expect(m.headline).toContain('when the event ends');
    expect(m.note).toBe('');
  });
  it('falls back to a generic line when no address comes back and none was typed', () => {
    const m = optInMessage({ wantsPhotos: true, email: null });
    expect(m.headline).toBe('We’ll email your photos when the event ends.');
    expect(m.note).toBe('');
  });
  it('a collision still confirms, names the typed address, and explains without alarming', () => {
    const m = optInMessage({ wantsPhotos: true, email: null, emailTaken: true }, 'shared@example.com');
    expect(m.headline).toContain('shared@example.com');
    expect(m.note).toBe('We’ll send these to you, but that address is already registered to another guest here.');
    // Never an error: the tap worked and the photos are coming.
    expect(m.note.toLowerCase()).not.toContain('error');
    expect(m.note.toLowerCase()).not.toContain('failed');
  });
  it('prefers the stored address over the typed one when both exist', () => {
    const m = optInMessage({ wantsPhotos: true, email: 'stored@example.com' }, 'typed@example.com');
    expect(m.headline).toContain('stored@example.com');
    expect(m.headline).not.toContain('typed@example.com');
  });
  it('says nothing alarming after an undo', () => {
    const m = optInMessage({ wantsPhotos: false, email: 'alex@example.com' });
    expect(m.note).toBe('');
    expect(m.headline).toContain('any time');
  });
});

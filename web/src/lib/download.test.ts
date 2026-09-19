import { describe, it, expect } from 'vitest';
import { zipHref, downloadFilename, heartedPhotos, favouritesUnion } from './download';

describe('zipHref', () => {
  it('asks for the whole event when given no ids', () => {
    expect(zipHref('ABC123')).toBe('/api/photos/ABC123/download');
    expect(zipHref('ABC123', [])).toBe('/api/photos/ABC123/download');
  });
  it('names a subset explicitly', () => {
    expect(zipHref('ABC123', ['a', 'b'])).toBe('/api/photos/ABC123/download?ids=a,b');
  });
  // The token is what lets a guest zip their own roll before the reveal; the server bounds the
  // result to that guest, so it narrows the answer rather than widening it.
  it('carries a session token, encoded', () => {
    expect(zipHref('ABC123', undefined, 'tok en/1')).toBe('/api/photos/ABC123/download?sessionToken=tok%20en%2F1');
    expect(zipHref('ABC123', ['a'], 'tok')).toBe('/api/photos/ABC123/download?ids=a&sessionToken=tok');
  });
});

describe('downloadFilename', () => {
  // The reason the id is in the name at all: without it these two collide, and the second silently
  // replaces the first in the downloads folder with nothing on screen to say a photo went missing.
  it('separates two shots taken in the same second', () => {
    const at = Date.UTC(2026, 0, 2, 3, 4, 5);
    const a = downloadFilename({ id: 'aaaaaaaa-1111', takenAt: at });
    const b = downloadFilename({ id: 'bbbbbbbb-2222', takenAt: at });
    expect(a).not.toBe(b);
    expect(a.startsWith('snapdini-2026-01-02-03-04-05-')).toBe(true);
  });
  it('gives a clip an mp4 extension and a photo a jpg', () => {
    const at = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(downloadFilename({ id: 'x', takenAt: at, mediaType: 'video' }).endsWith('.mp4')).toBe(true);
    expect(downloadFilename({ id: 'x', takenAt: at }).endsWith('.jpg')).toBe(true);
  });
});

// Two people's favourites, one download. The host stars (isHighlighted) and the guests heart, and
// the two sets overlap in ways that used to be worked out inline at the call site.
const shot = (id: string, isHighlighted = false) => ({ id, isHighlighted, takenAt: 0 });

describe('heartedPhotos', () => {
  it('keeps only what has a heart', () => {
    const list = [shot('a'), shot('b'), shot('c')];
    expect(heartedPhotos(list, { a: 2, c: 1 }).map((p) => p.id)).toEqual(['a', 'c']);
    // A zero is not a heart. It arrives as one whenever a guest hearts and un-hearts a photo.
    expect(heartedPhotos(list, { a: 0 })).toEqual([]);
    expect(heartedPhotos(list, {})).toEqual([]);
  });
  it('puts the most-hearted first', () => {
    const list = [shot('a'), shot('b'), shot('c')];
    expect(heartedPhotos(list, { a: 1, b: 9, c: 4 }).map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });
  // Ties keeping gallery order is what stops the set reshuffling between two renders of the same
  // sheet — and with it, the order files land in the downloads folder.
  it('leaves equal hearts in the order they came', () => {
    const list = [shot('a'), shot('b'), shot('c')];
    expect(heartedPhotos(list, { a: 3, b: 3, c: 3 }).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
  it('does not reorder the caller-s own array', () => {
    const list = [shot('a'), shot('b')];
    heartedPhotos(list, { b: 5 });
    expect(list.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('favouritesUnion', () => {
  it('takes the host-s stars and the hearted ones together', () => {
    const list = [shot('a', true), shot('b'), shot('c'), shot('d', true)];
    expect(favouritesUnion(list, { b: 1 }).map((p) => p.id)).toEqual(['a', 'b', 'd']);
  });
  // The reason it is a filter over one list rather than two lists joined: a starred AND hearted
  // photo counted twice would be zipped twice, under two names.
  it('counts a starred and hearted photo once', () => {
    const list = [shot('a', true), shot('b')];
    expect(favouritesUnion(list, { a: 4 }).map((p) => p.id)).toEqual(['a']);
  });
  it('stays in gallery order rather than hearts order', () => {
    const list = [shot('a', true), shot('b'), shot('c')];
    expect(favouritesUnion(list, { c: 9, b: 1 }).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
  it('is just the stars when nothing is hearted, and just the hearts when nothing is starred', () => {
    const list = [shot('a', true), shot('b')];
    expect(favouritesUnion(list, {}).map((p) => p.id)).toEqual(['a']);
    expect(favouritesUnion([shot('a'), shot('b')], { b: 2 }).map((p) => p.id)).toEqual(['b']);
  });
});

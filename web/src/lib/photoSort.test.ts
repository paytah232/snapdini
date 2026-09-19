import { describe, it, expect } from 'vitest';
import { sortPhotos } from './photoSort';
import type { Photo } from './events';

const p = (id: string, takenAt: number): Photo => ({
  id, url: `/u/${id}.jpg`, thumbUrl: `/u/${id}t.jpg`, takenAt,
  participantName: 'Ada', participantId: 'g1', isHighlighted: false, rating: 0,
  mediaType: 'photo', width: 10, height: 10,
});

describe('ordering a gallery by hearts', () => {
  const list = [p('a', 300), p('b', 100), p('c', 200), p('d', 400)];
  const counts = { a: 2, b: 9, c: 2 };          // d absent — no hearts at all

  it('puts the most hearted first', () => {
    expect(sortPhotos(list, 'hearted', counts).map((x) => x.id)[0]).toBe('b');
  });

  it('breaks ties by newest, so two loads agree', () => {
    // a and c both have two. Without the tie-break their order is whatever the input was, which is
    // not stable — and most of a real gallery is ties.
    const ids = sortPhotos(list, 'hearted', counts).map((x) => x.id);
    expect(ids).toEqual(['b', 'a', 'c', 'd']);
    // Same answer from a different starting order.
    expect(sortPhotos([...list].reverse(), 'hearted', counts).map((x) => x.id)).toEqual(ids);
  });

  it('treats a photo nobody hearted as zero rather than dropping it', () => {
    expect(sortPhotos(list, 'hearted', counts).map((x) => x.id)).toContain('d');
  });

  it('leaves the order alone when sorting by newest', () => {
    expect(sortPhotos(list, 'newest', counts).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never reorders the array it was given', () => {
    const before = list.map((x) => x.id);
    sortPhotos(list, 'hearted', counts);
    expect(list.map((x) => x.id), 'the download scope reads this same array').toEqual(before);
  });
});

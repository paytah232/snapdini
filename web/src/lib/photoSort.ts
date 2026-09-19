// How a gallery orders itself, in one place because two galleries offer the same choice.
//
// The rule that matters is the TIE-BREAK. Most photos at a real event have the same small number of
// hearts as each other — the seeded dev event has fifty photos and counts between 0 and 8 — so a
// sort on the count alone leaves most of the grid in whatever order the array happened to be in,
// and that order is not stable between two loads. Falling back to newest-first gives every run the
// same answer and keeps the untouched majority reading the way the gallery always reads.
import type { Photo } from './events';

export type PhotoSort = 'newest' | 'hearted';

/** Newest first — the order every gallery has always used. */
export const byNewest = (a: Photo, b: Photo): number => b.takenAt - a.takenAt;

/** Most hearted first, then newest. `counts` is the map the page already holds; a photo missing
 *  from it has none, which is the same thing as zero. */
export const byHearts = (counts: Record<string, number>) => (a: Photo, b: Photo): number =>
  ((counts[b.id] ?? 0) - (counts[a.id] ?? 0)) || byNewest(a, b);

/** Sorted, and never in place — the caller's array is its own, and a gallery that reordered the
 *  list it was handed would reorder the one the download scope reads too. */
export function sortPhotos(list: Photo[], sort: PhotoSort, counts: Record<string, number>): Photo[] {
  return sort === 'hearted' ? [...list].sort(byHearts(counts)) : [...list];
}

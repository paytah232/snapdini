/** Shared bits of the one download decision both galleries have to make.
 *
 *  Files or a zip is ASKED EVERY TIME rather than remembered. Browsers do not agree on what saving
 *  a file even looks like — Chrome on Android downloads a whole roll without asking, Opera prompts
 *  for every file, iOS has no downloads folder and needs the share sheet a batch at a time — so the
 *  right answer genuinely changes with the browser, the size of the set and what the person means
 *  to do with it. A remembered answer turns all of that into a download that starts with no
 *  question asked, which is indistinguishable from a button that ignores you.
 */

/** The server's zip of the ORIGINALS. No ids means "everything this event holds" — which is not the
 *  same as everything the page has loaded, and is deliberately the server's business to decide.
 *
 *  `sessionToken` is what lets a guest zip their OWN roll before the reveal; the server bounds the
 *  result to that guest's photos, so it is not a way to ask for more than the page already shows.
 *  It goes in the URL because this is reached by navigating to it — the zip is streamed, not held
 *  in memory — and a navigation cannot carry a header. */
export function zipHref(code: string, ids?: string[], sessionToken?: string): string {
  // Built by hand rather than with URLSearchParams, which percent-encodes the separator into
  // `ids=a%2Cb`. The server decodes that back and it works, but a comma is legal unencoded in a
  // query value and the readable form is what the endpoint documents. The token IS encoded — it is
  // opaque and not ours to assume anything about.
  const q: string[] = [];
  if (ids && ids.length) q.push(`ids=${ids.join(',')}`);
  if (sessionToken) q.push(`sessionToken=${encodeURIComponent(sessionToken)}`);
  return `/api/photos/${code}/download${q.length ? `?${q.join('&')}` : ''}`;
}

/** One naming rule for saved files, so a guest's roll and the event gallery cannot disagree about
 *  what the same photo is called.
 *
 *  The id suffix is not decoration: burst shots share a second, and a timestamp alone had two of
 *  them landing on one filename — where the second silently replaces the first in the downloads
 *  folder, with nothing on screen to say a photo went missing. */
export function downloadFilename(p: { id: string; takenAt: number; mediaType?: string }): string {
  const stamp = new Date(p.takenAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `snapdini-${stamp}-${p.id.slice(0, 6)}.${p.mediaType === 'video' ? 'mp4' : 'jpg'}`;
}

/** Every answer the scope chooser can give. 'hearts' and 'both' arrive on their own event out of
 *  ShareScope.svelte — the dispatcher there says why. */
export type DownloadScope = 'all' | 'favourites' | 'hearts' | 'both' | 'select' | 'new';

/** Guest favourites: everything carrying at least one ♥, most-hearted first.
 *
 *  The order only reaches the FILES path — saveAsFiles walks this list, so a phone (or a person)
 *  that gives up two thirds of the way through has still got the best of them. A zip cannot honour
 *  it: the server names entries in its own (person, time) order on purpose, because a tie there
 *  renumbers files between two downloads of the same event.
 *
 *  Array.sort is stable, so photos on equal hearts keep the gallery's order instead of an arbitrary
 *  one that would shuffle between renders. */
export function heartedPhotos<T extends { id: string }>(
  list: T[], hearts: Record<string, number>,
): T[] {
  return list.filter((p) => (hearts[p.id] ?? 0) > 0)
    .sort((a, b) => (hearts[b.id] ?? 0) - (hearts[a.id] ?? 0));
}

/** Host favourites and guest favourites together — the host's stars (isHighlighted) plus anything
 *  hearted.
 *
 *  Written as one filter over the gallery rather than two lists concatenated: that is what makes it
 *  deduplicated for free (a photo both starred AND hearted appears once, so it cannot land in a zip
 *  twice) and what keeps it in the same order as every other scope. */
export function favouritesUnion<T extends { id: string; isHighlighted?: boolean }>(
  list: T[], hearts: Record<string, number>,
): T[] {
  return list.filter((p) => p.isHighlighted || (hearts[p.id] ?? 0) > 0);
}

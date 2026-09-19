// What the review screen says when there is nothing to review.
//
// Out here rather than inside +page.svelte for the reason upgradePlan.ts and shotWindow.ts give: a
// rule that lives only in a component is a rule no test can reach. And this one is a rule, not a
// string — "No photos yet" was the whole screen on a fresh event, which is the first thing a host
// sees after buying one. An empty state is only useful if it knows WHY it is empty, and the page
// already knows: whether the event has opened, whether anyone has joined, whether it is over. Those
// are four situations with four different next actions, and one sentence answers none of them.
//
// The TESTS pin which branch is chosen and what it offers, never the wording — copy is meant to be
// edited, and a test that breaks on a comma is a test people learn to ignore.

/** What the host should do next, if anything. `link` goes to the manage hub for the QR and join
 *  link; `refresh` re-reads the photos, because this page does not poll and nothing here may
 *  pretend otherwise. */
export type EmptyAction = { kind: 'link' | 'refresh'; label: string } | null;
export type EmptyState = { key: 'finished' | 'upcoming' | 'nobody' | 'waiting'; icon: string; title: string; body: string; action: EmptyAction };

export interface EmptyStateInput {
  isExpired?: boolean;
  isUpcoming?: boolean;
  participantCount?: number;
  /** Already formatted in the event's own timezone — this decides nothing, it only reads it out. */
  startsAtLabel?: string;
}

export function reviewEmptyState(ev: EmptyStateInput | null | undefined): EmptyState {
  const guests = ev?.participantCount ?? 0;
  // Order matters: an event can be BOTH expired and have had guests, and "it is over" is the more
  // useful thing to say than "waiting for a photo" on an event that will never get one.
  if (ev?.isExpired) return {
    key: 'finished', icon: '\u{1F4ED}',
    title: 'This event finished without any photos',
    body: guests
      ? `${guests} ${guests === 1 ? 'guest' : 'guests'} joined, but nobody shot anything before it closed.`
      : 'Nobody joined, so there is nothing here. Your event details and settings are kept.',
    action: null,
  };
  if (ev?.isUpcoming) return {
    key: 'upcoming', icon: '\u{1F5D3}\uFE0F',
    title: 'Nothing to review yet',
    body: `Your event opens ${ev.startsAtLabel ?? 'soon'}. Photos appear here as guests shoot them`
      + ' — there is nothing to do on this page until then.',
    action: { kind: 'link', label: 'Get your QR and join link \u2192' },
  };
  if (!guests) return {
    key: 'nobody', icon: '\u{1F4F7}',
    title: 'No one has joined yet',
    body: 'Guests scan your QR code or open the join link to start shooting. Their photos land here as they go.',
    action: { kind: 'link', label: 'Get your QR and join link \u2192' },
  };
  return {
    key: 'waiting', icon: '\u{1F4F7}',
    title: `${guests} ${guests === 1 ? 'guest is' : 'guests are'} in — no photos yet`,
    body: 'The first photo shows up here as soon as somebody takes one.',
    action: { kind: 'refresh', label: 'Check again' },
  };
}

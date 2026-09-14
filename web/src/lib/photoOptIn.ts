/** "Email me the photos when the event ends" — the guest's side of it, as decisions rather than
 *  markup.
 *
 *  Two surfaces offer this (the join screen and the guest's own roll) and they must not drift on
 *  what a tap means or on what the collision case says. It also means the awkward paths — no
 *  address on file, an address another guest here already owns — are pinned by tests instead of
 *  by someone holding a phone in a dark room at a party. */

/** The same shape the join screen and attachEmail already accept, kept deliberately loose: real
 *  validation is the server's job, and a stricter pattern here only rejects valid addresses typed
 *  on a phone keyboard — the one failure a guest standing in a room cannot work around. */
export const looksLikeEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/** What a tap on the offer should do next.
 *  - `send`   → call the server now; `email` is present only when the guest just typed one
 *  - `ask`    → open the inline address field first, there is nowhere to send to
 *  - `badEmail` → they typed something that is not an address; say so, keep the field open */
export type OptInStep =
  | { kind: 'send'; email?: string }
  | { kind: 'ask' }
  | { kind: 'badEmail' };

/** `asking` is whether the inline field is already open, NOT whether we have an address. A guest
 *  with an address on file must never see the field: the whole promise of this control is that
 *  the common case is one tap and no dialog. */
export function planOptIn(s: { hasEmail: boolean; asking: boolean; draft: string }): OptInStep {
  if (!s.asking) return s.hasEmail ? { kind: 'send' } : { kind: 'ask' };
  const v = s.draft.trim();
  return looksLikeEmail(v) ? { kind: 'send', email: v } : { kind: 'badEmail' };
}

/** What the server answered. Mirrors PhotoOptIn in events.ts — repeated as a structural type so
 *  this module stays free of the fetch layer and can be tested without one. */
export interface OptInOutcome {
  wantsPhotos: boolean;
  email: string | null;
  emailTaken?: boolean;
}

export interface OptInMessage {
  /** The line beside the tick. Never blank while opted in. */
  headline: string;
  /** A quieter second line, or ''. Only the collision uses it today. */
  note: string;
}

/** The words to show once the server has answered.
 *
 *  `typed` is what the guest just entered and is needed for the collision case: an address that
 *  already belongs to another guest at this event is NOT stored, so the server's `email` comes
 *  back null and this side is the only place that still knows where the photos are going. Without
 *  it the confirmation would read "we'll email your photos" with no address at all, immediately
 *  after someone typed one — which reads as "it didn't take". */
export function optInMessage(r: OptInOutcome, typed?: string): OptInMessage {
  if (!r.wantsPhotos) return { headline: 'No problem — you can ask for them any time.', note: '' };
  const addr = (r.email ?? typed ?? '').trim();
  return {
    headline: addr
      ? `We’ll email your photos to ${addr} when the event ends.`
      : "We’ll email your photos when the event ends.",
    // Plain, and pointedly not an error: their tap worked, they are getting their photos. The only
    // thing that did not happen is a database write they were never told about in the first place.
    note: r.emailTaken
      ? "We’ll send these to you, but that address is already registered to another guest here."
      : '',
  };
}

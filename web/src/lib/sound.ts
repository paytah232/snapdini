import { writable } from 'svelte/store';

/** Has this viewer asked for sound yet, in this visit?
 *
 *  Module scope, not component state. The lightbox is created and destroyed every time a photo is
 *  opened and closed, so a flag living inside it reset on the way back in — you turned sound on,
 *  closed the photo, opened the next one and were back to silent, having to ask again. Paging left
 *  and right kept it only because that never unmounts the component.
 *
 *  Deliberately NOT persisted. The browser grants audio off the back of a user GESTURE, and a
 *  gesture does not survive a reload — restoring `true` on a fresh page would have us autoplaying
 *  with sound again, which is the thing the policy refuses and the reason clips played silently in
 *  the first place. One tap per visit is the honest price.
 */
export const wantSound = writable(false);

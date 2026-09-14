// How a host's guests get the photos, and which emails go with it.
//
// The rules live here rather than in either screen because the create wizard and the admin Settings
// form ask the SAME question, and a host who sets it up one way must not be shown different words —
// or a different answer — when they come back to change it.
//
// Two of these rules are the whole feature, and both fail silently when they are got wrong:
//
//  · a day-before reminder needs a day to exist in. Offered when the gallery opens less than 24
//    hours after the event ends, it is a switch the host turns on and nothing ever happens — no
//    error, no email, nothing to notice.
//  · a scheduled send placed before the reveal emails a gallery link that opens onto a locked
//    gallery. The host sees the time they chose; the guest sees a door that will not open.

import { scheduledRevealAt } from '../../../shared/reveal';

/** What the host chose on "How should your guests get the photos?" */
export type GuestDelivery = 'all_on_reveal' | 'favourites_manual' | 'scheduled' | 'manual';
/** Which photos a send carries. */
export type GuestSendScope = 'all' | 'favourites';

/** The behaviour every event created before this question existed already has, so an untouched
 *  event must keep it. */
export const GUEST_DELIVERY_DEFAULT: GuestDelivery = 'all_on_reveal';

export interface GuestDeliveryOption {
  value: GuestDelivery;
  /** The outcome, in the host's words — never the stored value. */
  label: string;
  desc: string;
}

/** Worded as outcomes, in the order a host weighs them: hands-off first, most work last. */
export const GUEST_DELIVERY_OPTIONS: readonly GuestDeliveryOption[] = [
  { value: 'all_on_reveal', label: 'Everything, as soon as photos are revealed',
    desc: 'Every guest who asked for the photos gets the whole gallery the moment it opens. Nothing for you to do.' },
  { value: 'favourites_manual', label: "Just my favourites, when I've picked them",
    desc: 'Nothing goes out until you say so. Star the ones you love, then press send.' },
  { value: 'scheduled', label: 'At a time I choose',
    desc: 'Pick the date and time below. It goes out then, whether or not you are near your phone.' },
  { value: 'manual', label: "I'll send it myself",
    desc: 'No email is ever sent automatically. You press send from your event page when you are ready.' },
];

/** How far ahead of the gallery opening the "photos release tomorrow" email goes out. */
export const REMINDER_LEAD_MS = 24 * 3_600_000;

/** The reveal instant for a set of reveal controls, or null when only the host can open the gallery.
 *
 *  A thin wrapper on the shared rule on purpose: both screens hold the host's choice as a delay OR
 *  an exact moment, and calling the shared function with the two assembled differently is how the
 *  wizard and Settings would come to disagree about when the photos appear. */
export function revealInstant(o: {
  revealMode: string;
  /** The event's end as an instant. */
  endsAt: number;
  delayHours: number;
  /** The exact moment the host picked, when they picked one — it wins over the delay. */
  customAt: number | null;
}): number | null {
  return scheduledRevealAt({
    revealMode: o.revealMode, expiresAt: o.endsAt,
    revealDelayHours: o.delayHours, revealAt: o.customAt,
  });
}

/** When the guests' photos actually reach them, or null when nothing can name that moment yet.
 *
 *  Null is a real answer, not a missing one: on the two manual settings the host has not decided,
 *  and on a manual reveal nobody has. Everything downstream — the reminder gate, the dates printed
 *  in the emails — has to degrade rather than invent a time. */
export function guestReleaseAt(
  delivery: GuestDelivery, reveal: number | null, sendAt: number | null,
): number | null {
  if (delivery === 'all_on_reveal') return reveal;
  if (delivery === 'scheduled') return sendAt;
  return null;   // favourites_manual / manual — the host sends it, so there is no moment to name
}

/** Is there room between the event ending and the gallery opening for a day-before reminder?
 *
 *  Measured against the event's END, not against now, because that is where the reminder sits in
 *  the sequence: the thank-you goes out when the event ends, and a reminder that would fire at or
 *  before that moment has already been overtaken. Deliberately free of the clock so the control
 *  cannot appear and disappear under a host who is still filling the form in. */
export function reminderCanFire(endsAt: number, releaseAt: number | null): boolean {
  return releaseAt !== null && releaseAt - endsAt >= REMINDER_LEAD_MS;
}

/** When the reminder would land, or null when it cannot. */
export function reminderFiresAt(endsAt: number, releaseAt: number | null): number | null {
  return reminderCanFire(endsAt, releaseAt) ? (releaseAt as number) - REMINDER_LEAD_MS : null;
}

/** Can the event-end email print a release date at all?
 *
 *  Only when the gallery opens AFTER the moment that email is sent. A gallery that is already open
 *  by the end of the event (instant reveal, or no delay) has no date to promise, and a manual
 *  reveal has none yet — in both cases the email degrades to the thank-you alone, and the host is
 *  told so rather than left to find out. */
export function releaseDateKnown(endsAt: number, releaseAt: number | null): boolean {
  return releaseAt !== null && releaseAt > endsAt;
}

/** Why a scheduled send cannot be saved, or null when it can.
 *
 *  'before-reveal' is said out loud rather than clamped: a host who typed a time and silently got a
 *  different one has been overruled without being told, and the next thing they do is wonder which
 *  of the two the guests will actually get. */
export type ScheduledSendIssue = 'missing' | 'before-reveal' | null;
export function scheduledSendIssue(sendAt: number | null, reveal: number | null): ScheduledSendIssue {
  if (sendAt === null) return 'missing';
  if (reveal !== null && sendAt < reveal) return 'before-reveal';
  return null;
}

/** The scope a delivery setting implies, or the host's own choice where it implies none.
 *
 *  Two of the four options ARE a scope ("everything" / "just my favourites"), so storing whatever
 *  the host last picked alongside them would let the stored scope contradict the option on screen —
 *  and the send would then quietly disagree with the words the host chose it by. */
export function scopeFor(delivery: GuestDelivery, chosen: GuestSendScope): GuestSendScope {
  if (delivery === 'all_on_reveal') return 'all';
  if (delivery === 'favourites_manual') return 'favourites';
  return chosen;
}

/** Does this setting ever send on its own? Drives whether a host is told the only way photos go out
 *  is the button they have to press. */
export function isManualDelivery(delivery: GuestDelivery): boolean {
  return delivery === 'favourites_manual' || delivery === 'manual';
}

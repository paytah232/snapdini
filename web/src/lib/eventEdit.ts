// ── Running the create wizard again, over an event that already exists ───────
//
// The wizard on /app is the only place the product ever EXPLAINS itself: what moderation does, what
// a reveal delay is for, what the guest email actually says. Once an event is created that whole
// explanation is gone, and the host is left with the admin page's settings card — which is correct,
// dense and says nothing. So the wizard takes a second mode rather than a second copy: same file,
// same bindings, same validation, one flag.
//
// The one thing that mode has to get right is that roughly half of what the wizard asks is NOT
// settings. Guest capacity, event length, video, frame shapes, shots each and retention are paid
// entitlements, and PUT /api/events/:joinCode/settings deliberately refuses to change any of them
// (it preserves the paid span on a reschedule, and it re-quotes a shape request and refuses one
// that costs more than was paid). Walking a host through those questions again and then dropping
// their answers is worse than not asking: they would leave believing they had changed something.
//
// Hence the three buckets below. They are DATA, in a module a test can import, because the only
// other place this knowledge could live is the markup — where nothing can check it and where the
// server's rules have already drifted away from the client's twice.
import type { AdminEvent } from './events';
import { REVEAL_CUSTOM, msToZonedWallTime } from '../../../shared/reveal';
import { scopeFor, isManualDelivery, type GuestDelivery, type GuestSendScope } from './guestDelivery';

/**
 * Every key PUT /api/events/:joinCode/settings actually reads and writes.
 *
 * Verified against app/src/server/routes/events.ts — the handler's own destructure plus the second
 * `gBody = req.body` read inside the same handler, which is where the guest-delivery and
 * guest-email fields come from.
 */
export const EDITABLE_SETTINGS = [
  'name', 'blurb', 'slug', 'timezone', 'eventType',
  'startsAt', 'startDate', 'startTime',
  'revealMode', 'revealDelayHours', 'revealDate', 'revealTime',
  'moderationEnabled', 'allowDownloads', 'noFlash', 'ratingMode', 'heartsEnabled', 'commentsEnabled',
  'guestMayBuyShots', 'guestMayBuyVideo', 'guestMayBuyFrames', 'guestMayRequest',
  'faceMatchingEnabled',
  'guestDelivery', 'guestSendScope', 'guestSendAt', 'guestSendDate', 'guestSendTime',
  'guestMailThanks', 'guestMailReminder', 'guestMailLive',
] as const;

/**
 * What the wizard asks about that Settings will never change: every one of these is bought.
 *
 * `aspectRatios` is on this list even though the endpoint accepts the key, because it only accepts
 * a SUBSET of what the event already owns — an edit-mode host cannot add a shape here, and the one
 * thing they might legitimately do (take an owned shape away again) already has a control on the
 * admin page. Sending it from here could only ever be a no-op or a refusal.
 */
export const UPGRADE_ONLY = [
  'maxGuests', 'durationHours', 'videoSeconds', 'framePackOn', 'aspectRatios',
  'retentionDays', 'maxPhotos',
] as const;

/**
 * Asked by the wizard, owned by neither endpoint: the SEED is a one-shot action taken at creation,
 * and from then on the list belongs to the missions editor, which can add, edit and reword
 * individual cards. Re-running the seed over a host's own list would overwrite it with a generated
 * one, and "build me a list" is not a setting an event holds — it is a thing that already happened.
 *
 * ── Why `eventType` is no longer on this list ───────────────────────────────
 * It was, and the reasoning was that the type is "stored alongside the trick list and written by
 * the same endpoint". Half right, and the wrong half was load-bearing. PUT /challenges does write
 * both columns in one statement and cannot be asked for the type alone (it 400s without a parseable
 * list, and a body whose list is empty CLEARS the column and reseats every guest) — so routing a
 * type change through there really would destroy host work. But nothing anywhere derives the list
 * FROM the type: the packs live in web/src/lib/challenges.ts and seeding from one is a client
 * action. The type on its own is a plain column, and PUT /settings now writes it.
 *
 * Which matters because the wizard's last step asks "are you sure you want to save" over a list of
 * changes. A field shown inside that flow which silently cannot be saved is the real defect — and
 * unset, it rendered as the word "Not set" with nowhere to go.
 */
export const EDIT_ELSEWHERE = ['seedMissions', 'trickVariety'] as const;

export const isEditableSetting = (field: string): boolean =>
  (EDITABLE_SETTINGS as readonly string[]).includes(field);
export const isUpgradeOnly = (field: string): boolean =>
  (UPGRADE_ONLY as readonly string[]).includes(field);
export const isEditElsewhere = (field: string): boolean =>
  (EDIT_ELSEWHERE as readonly string[]).includes(field);

/**
 * How many sub-pages a wizard step has.
 *
 * Lifted out of the component so the create/edit difference is something a test can state. `paid`
 * and `editing` are PARAMETERS, never read from scope: Svelte tracks what a reactive statement
 * mentions directly, not what a function it calls happens to read, and a `subsFor(step)` that read
 * `billing` from scope is exactly how step 1 once silently lost a page.
 *
 * Editing drops step 1's guests-and-price page. It is the guest tier and the live quote — the one
 * page of the wizard that is purely about buying, on a thing that is already bought.
 */
export function subsFor(step: number, paid: boolean, editing = false): number {
  if (step === 1) return (paid && !editing) ? 3 : 2;
  if (step === 4) return 3;
  return 1;
}

export interface RescheduleState {
  startsAt: number;
  participantCount?: number;
  photoCount?: number;
  /** The server's own answer, on the admin payload. Preferred whenever it is present. */
  canReschedule?: boolean;
}

/**
 * Is the start time fixed for good?
 *
 * The gate is USAGE, not time: an event nobody ever joined can still be moved after it has ended,
 * and the moment one guest joins or one photo exists it locks. This has to be known BEFORE step 2
 * renders, because the alternative is walking a host through picking a new date and then answering
 * them with a 409 several screens later.
 *
 * The server sends `canReschedule` on the admin payload and that is the authority; the local
 * computation is the fallback for an older API, and mirrors the same rule.
 */
export function startLocked(ev: RescheduleState | null | undefined, now = Date.now()): boolean {
  if (!ev) return false;
  if (typeof ev.canReschedule === 'boolean') return !ev.canReschedule;
  if (now < ev.startsAt) return false;
  return (ev.participantCount ?? 0) > 0 || (ev.photoCount ?? 0) > 0;
}

/** Every wizard field an edit prefills, in the shape the component's own variables take. */
export interface EditPrefill {
  /** Defaulted in prefillFromEvent, so the wizard's own non-optional state can take them
   *  directly — an older admin payload that omits them still yields the schema's defaults. */
  heartsEnabled: boolean;
  commentsEnabled: boolean;
  name: string; blurb: string; slug: string; timezone: string;
  startDate: string; startTime: string;
  durationHours: number; maxPhotos: number; retentionDays: number;
  maxGuests: number; videoSeconds: number; framePackOn: boolean;
  allowDownloads: boolean; noFlash: boolean;
  revealMode: string; revealDelayHours: number | string; revealDate: string; revealTime: string;
  moderationEnabled: boolean;
  eventType: string | null;
  guestDelivery: GuestDelivery; guestSendScope: GuestSendScope;
  guestSendDate: string; guestSendTime: string;
  guestMailThanks: boolean; guestMailReminder: boolean; guestMailLive: boolean;
}

/**
 * The event, read back into the wizard's own variables.
 *
 * Wall-clock strings are resolved in the EVENT's timezone, not the browser's, for the same reason
 * creating one writes them that way: a host in Sydney opening a Perth event must be shown the time
 * their guests will see, and round-tripping it through the browser's zone would move the event two
 * hours every time they pressed save.
 *
 * A stored `revealAt` becomes REVEAL_CUSTOM plus its two fields, because that is what the host
 * originally chose — showing them the delay dropdown on a preset they never picked would quietly
 * offer to throw their exact moment away.
 */
export function prefillFromEvent(ev: AdminEvent): EditPrefill {
  const tz = ev.timezone || 'UTC';
  const start = msToZonedWallTime(ev.startsAt, tz);
  const customReveal = ev.revealMode === 'at_end' && typeof ev.revealAt === 'number' && ev.revealAt !== null;
  const reveal = customReveal ? msToZonedWallTime(ev.revealAt as number, tz) : null;
  const send = typeof ev.guestSendAt === 'number' && ev.guestSendAt !== null
    ? msToZonedWallTime(ev.guestSendAt, tz) : null;
  return {
    name: ev.name || '',
    blurb: ev.blurb || '',
    slug: ev.slug || '',
    timezone: ev.timezone || '',
    startDate: start?.date ?? '',
    startTime: start?.time ?? '00:00',
    // Derived, never stored: the paid span IS expiry minus start, and the settings endpoint
    // preserves it across a reschedule rather than reading a duration back.
    durationHours: Math.max(1, Math.round((ev.expiresAt - ev.startsAt) / 3_600_000)),
    maxPhotos: ev.maxPhotos,
    retentionDays: ev.retentionDays,
    maxGuests: ev.guestCap,
    videoSeconds: ev.videoSeconds,
    framePackOn: (ev.aspectRatios ?? ['1:1']).some((a) => a !== '1:1'),
    allowDownloads: !!ev.allowDownloads,
    noFlash: !!ev.noFlash,
    heartsEnabled: ev.heartsEnabled !== false,
    commentsEnabled: ev.commentsEnabled === true,
    revealMode: ev.revealMode || 'at_end',
    revealDelayHours: customReveal ? REVEAL_CUSTOM : (ev.revealDelayHours ?? 0),
    revealDate: reveal?.date ?? '',
    revealTime: reveal?.time ?? '',
    moderationEnabled: !!ev.moderationEnabled,
    eventType: ev.eventType ?? null,
    guestDelivery: ev.guestDelivery as GuestDelivery,
    guestSendScope: ev.guestSendScope as GuestSendScope,
    guestSendDate: send?.date ?? '',
    guestSendTime: send?.time ?? '',
    guestMailThanks: !!ev.guestMailThanks,
    guestMailReminder: !!ev.guestMailReminder,
    guestMailLive: !!ev.guestMailLive,
  };
}

/** The wizard state an edit-mode save reads. Only the editable half of it exists here. */
export interface EditSaveState {
  name: string; blurb: string; slug: string; timezone: string;
  /** Already resolved in the event's zone and rounded onto the reveal tick by the caller. */
  startsAt: number | null;
  startDate: string; startTime: string;
  /** The instant the event currently holds, so an untouched start can be left out. */
  originalStartsAt: number;
  /** From startLocked(). True means the start is not ours to send at all. */
  startLocked: boolean;
  revealMode: string;
  revealDelayHours: number | string;
  wantsCustomReveal: boolean;
  revealDate: string; revealTime: string;
  moderationEnabled: boolean; allowDownloads: boolean; noFlash: boolean;
  heartsEnabled: boolean; commentsEnabled: boolean;
  /** The chips' own value. null is a real answer — "none of these fit" — not a missing one. */
  eventType: string | null;
  guestDelivery: GuestDelivery; guestSendScope: GuestSendScope;
  guestSendAt: number | null;
  guestMailThanks: boolean;
  guestMailReminder: boolean;
  /** Whether the day-before switch was on screen at all. */
  guestReminderOffered: boolean;
  guestMailLive: boolean;
}

/**
 * The PUT body an edit-mode save sends — and nothing else.
 *
 * Built here rather than inline in the component so the one property that matters can be asserted
 * by a test instead of by eye: every key is one the settings endpoint honours, and not one of them
 * is a paid entitlement. A body that carried maxGuests or durationHours would not fail — it would
 * be silently ignored, which is the failure mode this whole mode exists to avoid.
 *
 * A locked start contributes NO keys — and neither does an UNMOVED one. The server has a
 * 60-second tolerance and would ignore it either way, but "would be ignored" is not the same as
 * "was never sent": an event whose start has already passed and which nobody ever joined is still
 * reschedulable, and re-sending its own past instant would be answered with "Pick a start time in
 * the future" — a 400 on a field the host never touched. Same tolerance, same rule, said here.
 */
export const START_TOLERANCE_MS = 60_000;

export function editSettingsBody(s: EditSaveState): Record<string, unknown> {
  const startMoved = s.startsAt !== null
    && Math.abs(s.startsAt - s.originalStartsAt) > START_TOLERANCE_MS;
  return {
    name: s.name.trim(),
    blurb: s.blurb.trim(),
    slug: s.slug.trim(),
    timezone: s.timezone,
    ...(s.startLocked || !startMoved
      ? {}
      : { startsAt: s.startsAt, startDate: s.startDate, startTime: s.startTime }),
    revealMode: s.revealMode,
    // 'custom' on purpose — the server reads it as "the two fields below", and any number here
    // would be indistinguishable from an hour preset.
    revealDelayHours: s.wantsCustomReveal ? REVEAL_CUSTOM : parseInt(String(s.revealDelayHours), 10) || 0,
    ...(s.wantsCustomReveal ? { revealDate: s.revealDate, revealTime: s.revealTime } : {}),
    moderationEnabled: s.moderationEnabled,
    allowDownloads: s.allowDownloads,
    noFlash: s.noFlash,
    // ALWAYS sent, null included. The chips toggle off as well as on ("skip it if none of them
    // fit"), so an omitted key would make un-saying the type the one edit the wizard could not
    // make — and the server reads an absent key as "leave it alone" precisely so that older
    // clients cannot clear it by accident.
    eventType: s.eventType,
    guestDelivery: s.guestDelivery,
    // Derived, never the raw chip: two of the four options ARE a scope, so sending whatever the
    // host last picked alongside them would store a scope that contradicts the words on screen.
    guestSendScope: scopeFor(s.guestDelivery, s.guestSendScope),
    ...(s.guestDelivery === 'scheduled' ? { guestSendAt: s.guestSendAt } : {}),
    guestMailThanks: s.guestMailThanks,
    // Off when the gap cannot carry it: the switch was never on screen, so it is not a choice the
    // host made, and a stored true would arm an email that can only fire before the event it
    // follows.
    guestMailReminder: s.guestReminderOffered && s.guestMailReminder,
    // ON where it is the MECHANISM, and otherwise left exactly as the event already has it.
    //
    // The wizard has no switch for this at all — "photos are live" IS the automatic delivery modes
    // (see the locked row on step 4c), so an automatic mode must store true or the delivery the
    // host just chose silently never happens. The admin page, by contrast, carries a free toggle
    // for it, which is the whole problem: sending the DERIVED value from here reset a setting the
    // host had made on another screen and never showed them. On a manual mode the flag is inert —
    // liveSendDue() answers 'never' before it is ever read — so preserving it cannot change what
    // sends, and clobbering it could only ever lose a choice.
    guestMailLive: !isManualDelivery(s.guestDelivery) || s.guestMailLive,
  };
}

export interface EditChange { label: string; was: string; now: string; }

/** What a row that is not there at all reads as. Not blank: blank is a value some settings really
 *  have ("Welcome blurb" is already shown as this when empty), and a change list cannot afford to
 *  render "stopped applying" and "was left empty" the same way. */
export const EDIT_ABSENT = '—';

/**
 * What this save will actually change, for the last step.
 *
 * The create wizard ends on a price. An edit has no price — it ends on a list, because the question
 * a host has at that point is not "what does this cost" but "what am I about to do to an event that
 * is already out there on a printed card".
 *
 * Compared as the STRINGS on screen rather than as raw values: two epochs a second apart are not a
 * change anybody made, and "7:00 pm" against "7:00 pm" is the honest answer.
 *
 * ── Both directions, and why one was not enough ────────────────────────────────
 * This walked `after` only, so it could report a setting that changed value and a setting that
 * started applying — and was structurally blind to one that STOPPED. editSummaryRows() omits a row
 * rather than showing it as blank when it no longer applies ("a row that cannot be set is not a row
 * whose value is nothing"), which is right for a summary and fatal for a diff built only from it: a
 * row that disappears is a change with nothing to iterate over.
 *
 * The sharpest instance, and it is a real one: moving the start closer than a day makes the
 * day-before reminder impossible, so `guestReminderOffered` goes false, the switch leaves the
 * screen, the row leaves the summary — and `editSettingsBody` sends `guestMailReminder: false`
 * regardless. The host turns an email off, is shown a change list that does not mention it, and
 * finds out when it does not arrive.
 *
 * So the union, with the missing side rendered as EDIT_ABSENT in whichever direction it is missing.
 */
export function editChanges(before: Record<string, string>, after: Record<string, string>): EditChange[] {
  const out: EditChange[] = [];
  // Order follows `after` first so the list reads in the order the form does, then picks up
  // anything that only exists in `before` — the rows that have gone. A Set because a label in both
  // must be considered once.
  const labels = [...new Set([...Object.keys(after), ...Object.keys(before)])];
  for (const label of labels) {
    const had = Object.prototype.hasOwnProperty.call(before, label);
    const has = Object.prototype.hasOwnProperty.call(after, label);
    const was = had ? before[label] : EDIT_ABSENT;
    const now = has ? after[label] : EDIT_ABSENT;
    if (was !== now) out.push({ label, was, now });
  }
  return out;
}

export interface SlugAnswer { available: boolean; slug?: string; reason?: string; }

/**
 * What to say under the custom-URL box.
 *
 * Three things the wizard used to get wrong with one message. A reserved word came back as
 * "already taken", which sends a host off inventing variations of a name nobody has. And in edit
 * mode an event's OWN slug comes back unavailable — it is taken, by them — so the field that was
 * already correct read as an error they had to fix.
 */
export function slugVerdict(value: string, answer: SlugAnswer, ownSlug?: string | null,
  /** Which namespace the URL lives in: `e` for an event's own address, `s` for a share link. Two
   *  separate uniqueness checks on the server, and the host is told which one they are looking at —
   *  but the WORDS are the same in both, because the question is the same question. */
  prefix: 'e' | 's' = 'e'):
  { text: string; cls: 'ok' | 'err' | 'muted' } {
  const what = prefix === 's' ? 'this share' : 'your event';
  if (ownSlug && value === ownSlug) return { text: `✓ This is ${what}'s URL — /${prefix}/${value}`, cls: 'ok' };
  if (answer.available) return { text: `✓ Available — URL will be /${prefix}/${answer.slug ?? value}`, cls: 'ok' };
  if (answer.reason === 'Reserved') return { text: '✗ That word is reserved — try a different one', cls: 'err' };
  if (answer.reason === 'Too short') return { text: 'Too short — at least 2 characters', cls: 'err' };
  return { text: '✗ Already taken — try a different name', cls: 'err' };
}

/**
 * The event a `/app?edit=<id>` link names.
 *
 * EITHER form, because /admin/[code] takes either: requireOrganizer resolves through
 * eventByIdentifier(), which looks the value up as a join code uppercased and then as a slug
 * lowercased. The "Re-run the wizard" link is built from whatever identifier the host's own admin
 * URL carried, so a host who reached their event by its custom URL sends a slug down this parameter.
 *
 * It used to be read as `raw.toUpperCase().replace(/[^A-Z0-9]/g, '')` — which is exactly right for a
 * join code and destroys a slug: `my-party` arrived as `MYPARTY`, an event that does not exist, and
 * the wizard answered "Could not open that event" on a link it had generated itself.
 *
 * Case is therefore left alone (the server decides it per column) and only the characters neither
 * form can contain are dropped, so a hand-edited link still cannot put anything else in the path.
 * 50 is the slug ceiling the server's own slugify() imposes.
 */
export function editIdentifier(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 50);
}

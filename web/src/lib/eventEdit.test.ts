import { describe, it, expect } from 'vitest';
import {
  EDITABLE_SETTINGS, UPGRADE_ONLY, EDIT_ELSEWHERE,
  isEditableSetting, isUpgradeOnly, isEditElsewhere,
  subsFor, startLocked, prefillFromEvent, editSettingsBody, editChanges, slugVerdict,
  editIdentifier, type EditSaveState, EDIT_ABSENT } from './eventEdit';
import type { AdminEvent } from './events';

// ── Which fields are editable, and which are bought ──────────────────────────

describe('the three buckets', () => {
  it('never puts the same field in two of them', () => {
    for (const f of UPGRADE_ONLY) expect(isEditableSetting(f)).toBe(false);
    for (const f of EDIT_ELSEWHERE) expect(isEditableSetting(f)).toBe(false);
    for (const f of EDIT_ELSEWHERE) expect(isUpgradeOnly(f)).toBe(false);
  });

  it('names every paid entitlement the wizard asks about', () => {
    // The whole reason edit mode exists in this shape. If one of these ever moves to EDITABLE
    // without the server changing too, a host answers a question whose answer is dropped.
    for (const f of ['maxGuests', 'durationHours', 'videoSeconds', 'framePackOn', 'aspectRatios',
                     'retentionDays', 'maxPhotos']) {
      expect(isUpgradeOnly(f)).toBe(true);
    }
  });

  it('keeps the guest-delivery and guest-email fields editable', () => {
    // They are read from a second `gBody = req.body` inside the settings handler rather than from
    // its destructure, which is easy to miss when reading the route.
    for (const f of ['guestDelivery', 'guestSendScope', 'guestSendAt', 'guestSendDate',
                     'guestSendTime', 'guestMailThanks', 'guestMailReminder', 'guestMailLive']) {
      expect(isEditableSetting(f)).toBe(true);
    }
  });

  it('leaves the trick list to the missions editor', () => {
    // The SEED, not the type. "Build me a list" is a one-shot action taken at creation, not a
    // setting an event holds, and re-running it over a list the host has rewritten would replace
    // their words with generated ones.
    expect(isEditElsewhere('seedMissions')).toBe(true);
    expect(isEditElsewhere('trickVariety')).toBe(true);
    expect(isEditableSetting('seedMissions')).toBe(false);
  });

  it('makes the kind of event editable — deliberately moved out of EDIT_ELSEWHERE', () => {
    // This assertion used to read the other way round, and the comment that justified it said the
    // type "is stored alongside the trick list and written by the same endpoint". Half true. PUT
    // /challenges does write both columns at once and cannot be asked for the type alone — it 400s
    // without a parseable list, and an EMPTY list clears the column and reseats every guest — so a
    // type change routed through there would genuinely destroy host work. But nothing derives the
    // list from the type: the packs are front-end data and seeding one is a client action at
    // creation. PUT /settings now writes the single column, so it is a setting like any other.
    //
    // It had to become one. The wizard's last step asks "are you sure you want to save" over a list
    // of changes, and a field shown inside that flow which silently cannot be saved is the real
    // inconsistency — worst of all on an event that never had a type, where the read-only line
    // rendered the words "Not set" and offered nothing to do about it.
    expect(isEditElsewhere('eventType')).toBe(false);
    expect(isEditableSetting('eventType')).toBe(true);
    expect(isUpgradeOnly('eventType')).toBe(false);
  });

  it('has no duplicates', () => {
    expect(new Set(EDITABLE_SETTINGS).size).toBe(EDITABLE_SETTINGS.length);
  });
});

// ── Sub-page counts ──────────────────────────────────────────────────────────

describe('subsFor', () => {
  it('gives step 1 three pages when creating a paid-capable event', () => {
    expect(subsFor(1, true, false)).toBe(3);
  });
  it('drops the guests-and-price page when editing', () => {
    expect(subsFor(1, true, true)).toBe(2);
  });
  it('already had two pages with billing off, editing or not', () => {
    expect(subsFor(1, false, false)).toBe(2);
    expect(subsFor(1, false, true)).toBe(2);
  });
  it('leaves every other step alone', () => {
    for (const editing of [false, true]) {
      expect(subsFor(2, true, editing)).toBe(1);
      expect(subsFor(3, true, editing)).toBe(1);
      expect(subsFor(4, true, editing)).toBe(3);
      expect(subsFor(5, true, editing)).toBe(1);
    }
  });
  it('defaults to create mode when the flag is omitted', () => {
    expect(subsFor(1, true)).toBe(3);
  });
});

// ── The locked start ─────────────────────────────────────────────────────────

describe('startLocked', () => {
  const NOW = 1_700_000_000_000;

  it('trusts the server answer above anything it could work out itself', () => {
    expect(startLocked({ startsAt: NOW - 1000, canReschedule: true, participantCount: 9 }, NOW)).toBe(false);
    expect(startLocked({ startsAt: NOW + 86_400_000, canReschedule: false }, NOW)).toBe(true);
  });

  it('is never locked before the event starts', () => {
    expect(startLocked({ startsAt: NOW + 3600_000, participantCount: 50, photoCount: 200 }, NOW)).toBe(false);
  });

  it('locks once it has started AND someone has used it', () => {
    expect(startLocked({ startsAt: NOW - 1, participantCount: 1, photoCount: 0 }, NOW)).toBe(true);
    expect(startLocked({ startsAt: NOW - 1, participantCount: 0, photoCount: 1 }, NOW)).toBe(true);
  });

  it('leaves an event nobody ever joined movable, even after it ended', () => {
    // The support case this rule exists for: bought it, never got the QR in front of anyone.
    expect(startLocked({ startsAt: NOW - 86_400_000, participantCount: 0, photoCount: 0 }, NOW)).toBe(false);
  });

  it('is not locked when there is no event yet', () => {
    expect(startLocked(null, NOW)).toBe(false);
    expect(startLocked(undefined, NOW)).toBe(false);
  });
});

// ── Prefill ──────────────────────────────────────────────────────────────────

const EV = {
  name: 'Lisa’s Birthday', blurb: 'Snap away!', slug: 'lisas-birthday',
  timezone: 'Australia/Brisbane',
  startsAt: Date.UTC(2026, 10, 14, 9, 0),        // 19:00 Brisbane (UTC+10)
  expiresAt: Date.UTC(2026, 10, 15, 9, 0),       // + 24h
  maxPhotos: 25, retentionDays: 30, guestCap: 60, videoSeconds: 15,
  aspectRatios: ['1:1', '4:5', '9:16'],
  allowDownloads: true, noFlash: true,
  revealMode: 'at_end', revealDelayHours: 2, revealAt: null,
  moderationEnabled: true, eventType: 'birthday',
  guestDelivery: 'all_on_reveal', guestSendScope: 'all', guestSendAt: null,
  guestMailThanks: true, guestMailReminder: false, guestMailLive: true,
} as unknown as AdminEvent;

describe('prefillFromEvent', () => {
  it('reads the start in the EVENT timezone, not the browser one', () => {
    const p = prefillFromEvent(EV);
    expect(p.startDate).toBe('2026-11-14');
    expect(p.startTime).toBe('19:00');
  });

  it('derives the duration from the paid span', () => {
    expect(prefillFromEvent(EV).durationHours).toBe(24);
  });

  it('carries every entitlement across so the read-only pages can show it', () => {
    const p = prefillFromEvent(EV);
    expect(p.maxGuests).toBe(60);
    expect(p.videoSeconds).toBe(15);
    expect(p.maxPhotos).toBe(25);
    expect(p.retentionDays).toBe(30);
    expect(p.framePackOn).toBe(true);
  });

  it('reads a square-only event as no frame pack', () => {
    expect(prefillFromEvent({ ...EV, aspectRatios: ['1:1'] } as AdminEvent).framePackOn).toBe(false);
  });

  it('keeps a preset reveal delay as a delay', () => {
    const p = prefillFromEvent(EV);
    expect(p.revealDelayHours).toBe(2);
    expect(p.revealDate).toBe('');
  });

  it('turns a stored exact reveal instant back into the custom option', () => {
    const p = prefillFromEvent({ ...EV, revealAt: Date.UTC(2026, 10, 15, 12, 30) } as AdminEvent);
    expect(p.revealDelayHours).toBe('custom');
    expect(p.revealDate).toBe('2026-11-15');
    expect(p.revealTime).toBe('22:30');
  });

  it('does not invent a custom reveal on a non-at_end event', () => {
    const p = prefillFromEvent({ ...EV, revealMode: 'instant', revealAt: 123 } as AdminEvent);
    expect(p.revealDelayHours).toBe(2);
  });

  it('reads a scheduled send in the event zone too', () => {
    const p = prefillFromEvent({
      ...EV, guestDelivery: 'scheduled', guestSendAt: Date.UTC(2026, 10, 16, 1, 0),
    } as unknown as AdminEvent);
    expect(p.guestSendDate).toBe('2026-11-16');
    expect(p.guestSendTime).toBe('11:00');
  });

  it('turns nulls into the empty strings the form binds to', () => {
    const p = prefillFromEvent({ ...EV, blurb: null, slug: null, eventType: null } as unknown as AdminEvent);
    expect(p.blurb).toBe('');
    expect(p.slug).toBe('');
    expect(p.eventType).toBeNull();
  });
});

// ── The save body ────────────────────────────────────────────────────────────

const SAVE: EditSaveState = {
  // Hearts on, comments off — the schema's defaults, stated here so the fixture is a real event.
  heartsEnabled: true, commentsEnabled: false,
  name: '  Lisa’s Birthday  ', blurb: ' Snap away! ', slug: ' lisas-birthday ',
  timezone: 'Australia/Brisbane',
  startsAt: Date.UTC(2026, 10, 14, 10, 0), startDate: '2026-11-14', startTime: '20:00',
  originalStartsAt: Date.UTC(2026, 10, 14, 9, 0),
  startLocked: false,
  revealMode: 'at_end', revealDelayHours: 2, wantsCustomReveal: false,
  revealDate: '', revealTime: '',
  moderationEnabled: true, allowDownloads: true, noFlash: false,
  eventType: 'birthday',
  guestDelivery: 'all_on_reveal', guestSendScope: 'favourites', guestSendAt: null,
  guestMailThanks: true, guestMailReminder: true, guestReminderOffered: true, guestMailLive: true,
};

describe('editSettingsBody', () => {
  it('sends only keys the settings endpoint honours', () => {
    for (const k of Object.keys(editSettingsBody(SAVE))) {
      expect(isEditableSetting(k), `${k} is not an editable setting`).toBe(true);
    }
  });

  it('never sends a paid entitlement', () => {
    const keys = Object.keys(editSettingsBody(SAVE));
    for (const f of UPGRADE_ONLY) expect(keys).not.toContain(f);
  });

  it('never sends the trick-list fields', () => {
    const keys = Object.keys(editSettingsBody(SAVE));
    for (const f of EDIT_ELSEWHERE) expect(keys).not.toContain(f);
  });

  it('sends the kind of event', () => {
    // Without this the chips in edit mode are decoration: the settings endpoint reads an absent
    // key as "leave it alone", so a host could pick a type, see it on the change list, press Save
    // and be told it saved while the column never moved. That is what the field did for its whole
    // life as read-only text, except at least the text admitted it.
    expect(editSettingsBody(SAVE).eventType).toBe('birthday');
    expect(editSettingsBody({ ...SAVE, eventType: 'wedding' }).eventType).toBe('wedding');
  });

  it('sends the kind of event as null rather than omitting the key', () => {
    // The chips toggle OFF as well as on — "skip it if none of them fit" — so un-saying the type
    // has to travel. An omitted key means "leave it alone" on the server (deliberately, so an older
    // client cannot clear it), which would make this the one edit the wizard could not make.
    const b = editSettingsBody({ ...SAVE, eventType: null });
    expect(b).toHaveProperty('eventType');
    expect(b.eventType).toBeNull();
  });

  it('never sends the trick list itself, whatever the type says', () => {
    // The type is a column. The list is the host's writing, and this body must never carry it.
    const keys = Object.keys(editSettingsBody({ ...SAVE, eventType: 'wedding' }));
    expect(keys).not.toContain('challenges');
    expect(keys).not.toContain('tick');
  });

  it('omits the start entirely when it is locked', () => {
    const b = editSettingsBody({ ...SAVE, startLocked: true });
    expect(b).not.toHaveProperty('startsAt');
    expect(b).not.toHaveProperty('startDate');
    expect(b).not.toHaveProperty('startTime');
    expect(b.name).toBe('Lisa’s Birthday');   // everything else still saves
  });

  it('sends the start when it has actually moved', () => {
    expect(editSettingsBody(SAVE).startsAt).toBe(Date.UTC(2026, 10, 14, 10, 0));
    expect(editSettingsBody(SAVE).startTime).toBe('20:00');
  });

  it('leaves an untouched start out, so a past-but-unused event is not refused', () => {
    // The server would ignore a same-instant start, but it would ALSO answer a past one with
    // "Pick a start time in the future" — on a field the host never went near.
    const same = editSettingsBody({ ...SAVE, startsAt: SAVE.originalStartsAt });
    expect(same).not.toHaveProperty('startsAt');
    // …and within the server's own 60-second tolerance, which is not a move anybody made.
    const jitter = editSettingsBody({ ...SAVE, startsAt: SAVE.originalStartsAt + 30_000 });
    expect(jitter).not.toHaveProperty('startsAt');
  });

  it('trims what it sends', () => {
    const b = editSettingsBody(SAVE);
    expect(b.name).toBe('Lisa’s Birthday');
    expect(b.blurb).toBe('Snap away!');
    expect(b.slug).toBe('lisas-birthday');
  });

  it('derives the send scope from the delivery mode rather than the raw chip', () => {
    expect(editSettingsBody(SAVE).guestSendScope).toBe('all');
    expect(editSettingsBody({ ...SAVE, guestDelivery: 'favourites_manual' }).guestSendScope).toBe('favourites');
  });

  it('only carries a send moment on the scheduled mode', () => {
    expect(editSettingsBody(SAVE)).not.toHaveProperty('guestSendAt');
    const sched = editSettingsBody({ ...SAVE, guestDelivery: 'scheduled', guestSendAt: 999 });
    expect(sched.guestSendAt).toBe(999);
  });

  it('sends custom as the delay, with its two fields, for an exact reveal', () => {
    const b = editSettingsBody({ ...SAVE, wantsCustomReveal: true, revealDelayHours: 'custom',
                                revealDate: '2026-11-15', revealTime: '22:30' });
    expect(b.revealDelayHours).toBe('custom');
    expect(b.revealDate).toBe('2026-11-15');
  });

  it('writes the reminder off when the switch was never on screen', () => {
    expect(editSettingsBody({ ...SAVE, guestReminderOffered: false }).guestMailReminder).toBe(false);
  });
});

// ── The "what you're changing" list ──────────────────────────────────────────

describe('editChanges', () => {
  it('lists only what actually differs', () => {
    const c = editChanges({ Name: 'A', Reveal: 'When it ends' }, { Name: 'B', Reveal: 'When it ends' });
    expect(c).toEqual([{ label: 'Name', was: 'A', now: 'B' }]);
  });
  it('is empty when nothing moved', () => {
    expect(editChanges({ Name: 'A' }, { Name: 'A' })).toEqual([]);
  });
  it('treats a field the event never had as a change from nothing', () => {
    // '—' rather than '': the list renders `was` inside <s>, and a struck-through empty string is
    // a strikethrough of nothing at all. It also has to be distinguishable from a setting whose
    // real value IS blank — "Welcome blurb" is already shown that way when empty.
    expect(editChanges({}, { Blurb: 'Hi' })).toEqual([{ label: 'Blurb', was: EDIT_ABSENT, now: 'Hi' }]);
  });

  // ── The direction that was structurally invisible ────────────────────────────
  //
  // This walked `after` only. editSummaryRows() OMITS a row rather than blanking it when the
  // setting no longer applies — correct for a summary, and fatal for a diff built from it, because
  // a row that disappears is a change with nothing left to iterate over.
  it('reports a setting that has STOPPED applying', () => {
    expect(editChanges({ 'Day-before reminder': 'On' }, {}))
      .toEqual([{ label: 'Day-before reminder', was: 'On', now: EDIT_ABSENT }]);
  });

  it('the real case: moving the start closer silently disarms the day-before reminder', () => {
    // guestReminderOffered goes false, so the switch leaves the screen and the row leaves the
    // summary — while editSettingsBody still sends `guestMailReminder: false`. The host turns an
    // email off, is shown a change list that does not mention it, and finds out when it does not
    // arrive. The list must name it.
    const before = { Starts: 'Sat 14 Nov, 7:00 pm', 'Day-before reminder': 'On' };
    const after  = { Starts: 'Tonight, 8:00 pm' };
    const diff = editChanges(before, after);
    expect(diff.map((d) => d.label).sort()).toEqual(['Day-before reminder', 'Starts']);
    expect(diff.find((d) => d.label === 'Day-before reminder')).toEqual(
      { label: 'Day-before reminder', was: 'On', now: EDIT_ABSENT });
    // ...and it is genuinely gone, not merely off — which is what editSettingsBody will send.
    expect(editSettingsBody({ ...SAVE, guestReminderOffered: false }).guestMailReminder).toBe(false);
  });

  it('a row that was absent on BOTH sides is not a change', () => {
    expect(editChanges({ Name: 'A' }, { Name: 'A' })).toEqual([]);
    expect(editChanges({}, {})).toEqual([]);
  });

  it('lists every label once, however many sides it appears on', () => {
    const diff = editChanges({ A: '1', B: '2' }, { B: '3', C: '4' });
    expect(diff.map((d) => d.label).sort()).toEqual(['A', 'B', 'C']);
    expect(new Set(diff.map((d) => d.label)).size).toBe(diff.length);
  });

  it('reads in form order, with the vanished rows after', () => {
    // The list is read top to bottom by someone checking their own edit; it should follow the form
    // they just walked, not the iteration order of an object union.
    expect(editChanges({ Gone: 'x', Name: 'A' }, { Name: 'B', Blurb: 'Hi' }).map((d) => d.label))
      .toEqual(['Name', 'Blurb', 'Gone']);
  });
});

// ── The slug verdict ─────────────────────────────────────────────────────────

describe('slugVerdict', () => {
  it('does not report an event its own URL as taken', () => {
    expect(slugVerdict('lisas-birthday', { available: false }, 'lisas-birthday'))
      .toEqual({ text: "✓ This is your event's URL — /e/lisas-birthday", cls: 'ok' });
  });
  it('still refuses somebody else’s', () => {
    expect(slugVerdict('taken', { available: false }, 'lisas-birthday').cls).toBe('err');
  });
  it('says reserved rather than taken', () => {
    expect(slugVerdict('admin', { available: false, reason: 'Reserved' }).text)
      .toContain('reserved');
  });
  it('accepts a free one, using the server’s slugified form', () => {
    expect(slugVerdict('New Name', { available: true, slug: 'new-name' }).text)
      .toContain('/e/new-name');
  });
});

// ── "Photos are live" is not the wizard's to reset ───────────────────────────

describe('editSettingsBody and guestMailLive', () => {
  it('keeps a manual event’s own setting instead of deriving one', () => {
    // The wizard shows NO switch for this — it is stated as locked to the delivery mode — while the
    // admin page carries a free toggle for it. Sending the derived value from here turned the
    // host's own choice off, silently, on a screen that never mentioned it.
    expect(editSettingsBody({ ...SAVE, guestDelivery: 'manual', guestMailLive: true }).guestMailLive)
      .toBe(true);
    expect(editSettingsBody({ ...SAVE, guestDelivery: 'favourites_manual', guestMailLive: true }).guestMailLive)
      .toBe(true);
    expect(editSettingsBody({ ...SAVE, guestDelivery: 'manual', guestMailLive: false }).guestMailLive)
      .toBe(false);
  });

  it('still forces it on where it IS the delivery', () => {
    // The other direction, and the reason a plain pass-through would be wrong: on the two automatic
    // modes this flag is the mechanism (sweepLive is gated on it), so a stored false would mean the
    // delivery the host just chose never happens.
    expect(editSettingsBody({ ...SAVE, guestDelivery: 'all_on_reveal', guestMailLive: false }).guestMailLive)
      .toBe(true);
    expect(editSettingsBody({ ...SAVE, guestDelivery: 'scheduled', guestMailLive: false }).guestMailLive)
      .toBe(true);
  });

  it('round-trips an event through prefill and save without moving it', () => {
    const ev = { ...EV, guestDelivery: 'manual', guestMailLive: true } as unknown as AdminEvent;
    const p = prefillFromEvent(ev);
    expect(p.guestMailLive).toBe(true);
    expect(editSettingsBody({ ...SAVE, guestDelivery: p.guestDelivery, guestMailLive: p.guestMailLive }).guestMailLive)
      .toBe(true);
  });
});

// ── /app?edit=<id> ──────────────────────────────────────────────────

describe('editIdentifier', () => {
  it('leaves a custom slug intact', () => {
    // The bug: /admin/my-party generates /app?edit=my-party, which was read as MYPARTY.
    expect(editIdentifier('my-party')).toBe('my-party');
    expect(editIdentifier('lisas-birthday')).toBe('lisas-birthday');
  });

  it('leaves a join code intact', () => {
    expect(editIdentifier('ABCD2345')).toBe('ABCD2345');
  });

  it('does not change the case either way — the server resolves both columns', () => {
    expect(editIdentifier('abcd2345')).toBe('abcd2345');
  });

  it('drops anything neither form can contain', () => {
    expect(editIdentifier('  my-party/../etc  ')).toBe('my-partyetc');
    expect(editIdentifier('a b<c>')).toBe('abc');
  });

  it('caps at the slug ceiling the server imposes', () => {
    expect(editIdentifier('a'.repeat(80))).toHaveLength(50);
  });
});

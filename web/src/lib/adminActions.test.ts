// Reading the admin action log off the wire.
//
// normalizeAdminAction is deliberately generous — it was written while the endpoint was being
// built in parallel and still reads every field through a list of candidate names — and generous
// code is exactly the kind that quietly stops being right. The failures worth guarding are the
// ones that would look FINE on screen: a `false` before-value printed as an em dash (the single
// most important thing an audit row can say), an object printed as [object Object], and a
// before/after pair that stops being unzipped into per-field rows and starts showing the operator
// two blobs of JSON to diff by eye.
import { describe, it, expect } from 'vitest';
import { normalizeAdminAction } from './events';

/** A row exactly as app/src/server/routes/admin.ts aliases it today. */
const WIRE = {
  id: 41, at: 1_700_000_000_000,
  adminUserId: 'u_1', adminEmail: 'ops@snapdini.com', adminName: 'Ops',
  eventId: 'ev1', eventName: 'Lisa & Dan', eventJoinCode: 'LISADAN',
  action: 'event.settings', targetType: 'event', targetId: 'ev1',
  before: { revealMode: 'manual', moderationEnabled: false },
  after: { revealMode: 'instant', moderationEnabled: true },
  eventExists: true,
};

describe('one row from the endpoint as it is actually written', () => {
  it('reads every column the server sends', () => {
    const a = normalizeAdminAction(WIRE, 0);
    expect(a.id).toBe('41');
    expect(a.at).toBe(1_700_000_000_000);
    expect(a.actor).toBe('ops@snapdini.com');
    expect(a.eventId).toBe('ev1');
    expect(a.eventName).toBe('Lisa & Dan');
    expect(a.eventCode).toBe('LISADAN');
    expect(a.action).toBe('event.settings');
    expect(a.target).toBe('event');
    expect(a.eventExists).toBe(true);
  });

  it('unzips the pair into one row per field that moved', () => {
    // The whole design of the table (0068): before and after are objects with the SAME keys holding
    // only what changed, so one renderer covers a settings save, a rotation and a bulk moderation.
    // Collapse this back to two JSON blobs and the operator is diffing by eye.
    expect(normalizeAdminAction(WIRE, 0).changes).toEqual([
      { key: 'revealMode', before: 'manual', after: 'instant' },
      { key: 'moderationEnabled', before: 'false', after: 'true' },
    ]);
  });

  it('prints `false` and `0` rather than losing them', () => {
    // THE one that matters. A `??` chain over a bag of unknown keys, or `String(v) || '—'`, turns
    // "downloads were ON and are now OFF" into "was —, now —", and the log stops being able to say
    // the thing it exists to say.
    const a = normalizeAdminAction({ before: { allowDownloads: true }, after: { allowDownloads: false } }, 0);
    expect(a.changes).toEqual([{ key: 'allowDownloads', before: 'true', after: 'false' }]);
    const n = normalizeAdminAction({ before: { maxPhotos: 0 }, after: { maxPhotos: 20 } }, 0);
    expect(n.changes[0].before).toBe('0');
  });

  it('prints a nested value as JSON, not as [object Object]', () => {
    const a = normalizeAdminAction({ before: { theme: { bg: '#0f0f0f' } }, after: { theme: null } }, 0);
    expect(a.changes[0].before).toBe('{"bg":"#0f0f0f"}');
    // Null on one side is an empty string here and an em dash in the view — never the word "null".
    expect(a.changes[0].after).toBe('');
  });

  it('a delete keeps the before-side, which is the only copy left', () => {
    // `after` NULL is meaningful and is not `{}`: the thing stopped existing. The snapshot in
    // `before` is then the whole of the recovery.
    const a = normalizeAdminAction({ action: 'event.delete', before: { name: 'Kate 40th' }, after: null }, 0);
    expect(a.changes).toEqual([{ key: 'name', before: 'Kate 40th', after: '' }]);
  });

  it('falls back to the raw pair when the values are not key-shaped', () => {
    // A scalar pair, or a shape this client has not been taught. Shown rather than dropped: a value
    // you can read is worth more than a tidy blank.
    const a = normalizeAdminAction({ before: 'pending', after: 'approved' }, 0);
    expect(a.changes).toEqual([]);
    expect([a.before, a.after]).toEqual(['pending', 'approved']);
  });

  it('still reads a row whose columns were named differently', () => {
    // The generosity that let this ship before the endpoint did. Worth keeping: it costs one array
    // per field and it is what makes a server-side rename a line in pick() rather than a hunt.
    const a = normalizeAdminAction({
      action_id: 'a2', created_at: '2026-09-20T01:02:03Z', admin_email: 'ops@snapdini.com',
      event: { id: 'ev2', name: 'Kate 40th' }, type: 'toggle', setting: 'moderationEnabled',
      old_value: { moderationEnabled: false }, new_value: { moderationEnabled: true },
    }, 0);
    expect(a.id).toBe('a2');
    expect(a.at).toBe(Date.parse('2026-09-20T01:02:03Z'));
    expect(a.actor).toBe('ops@snapdini.com');
    expect(a.eventName).toBe('Kate 40th');
    expect(a.action).toBe('toggle');
    expect(a.changes).toEqual([{ key: 'moderationEnabled', before: 'false', after: 'true' }]);
  });

  it('never invents a time it was not given', () => {
    // An audit row with a made-up "now" on it is worse than one with no time: it reads as fact.
    expect(normalizeAdminAction({}, 0).at).toBeNull();
    expect(normalizeAdminAction({ at: 'the other day' }, 0).at).toBeNull();
  });

  it('gives every row a key, so a list without ids still renders', () => {
    expect(normalizeAdminAction({}, 3).id).toBe('row-3');
  });

  it('assumes the event still exists unless told otherwise', () => {
    // Offering a link that 404s is a smaller failure than hiding a working one.
    expect(normalizeAdminAction({}, 0).eventExists).toBe(true);
    expect(normalizeAdminAction({ eventExists: false }, 0).eventExists).toBe(false);
  });

  it('does not throw on junk', () => {
    // This screen is opened when something has ALREADY gone wrong. It does not get to be the second
    // thing that is broken.
    for (const junk of [null, undefined, 'a string', 42, []]) {
      expect(() => normalizeAdminAction(junk, 0)).not.toThrow();
    }
    const a = normalizeAdminAction(null, 0);
    expect([a.actor, a.action, a.before, a.after]).toEqual(['', '', '', '']);
    expect(a.changes).toEqual([]);
  });
});

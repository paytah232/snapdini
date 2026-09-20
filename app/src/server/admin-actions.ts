/**
 * The operator's audit trail — what a SITE ADMIN changed on somebody else's event.
 *
 * WHY THIS EXISTS. A site admin can open any customer's event and drive it exactly as the host
 * would. Much of that surface saves on the tap: the guest-permission switches, allow-downloads,
 * lock, reveal. That is right for a host looking at their own event, and wrong for an operator
 * looking at a stranger's — one stray tap during somebody's reception leaves nothing behind but a
 * 200 in an access log, and the previous value is gone. This module writes the row that says what
 * was touched and what it used to be, so a person can put it back.
 *
 * WHAT IT DELIBERATELY IS NOT. There is no revert endpoint and there must not be one. Undoing an
 * old entry means merging it against everything the host has done since, on settings nobody is
 * watching, and a merge that guesses wrong is worse than the original mistake. The before-value is
 * enough: the operator restores it through the same screens the host uses, having read what it was.
 *
 * WHAT GETS RECORDED, in one sentence: a site admin acting on an event they neither own nor
 * co-host. Everything else — every host's own work, and the operator's work on his own events — is
 * dropped here rather than filtered later. A log that collects routine saves is a log where the one
 * entry that mattered is on page forty, and an operator who has to scroll stops looking.
 */
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { adminActions, events, type User } from './schema';
import * as auth from './auth';

/** Everything this module needs to know about the event, and everything every call site already
 *  holds (`req.event`). Passing the row rather than an id is not an optimisation for its own
 *  sake — see the note on `event.delete` in recordAdminAction(). */
export type EventRef = { id: string; name: string; joinCode: string; ownerUserId: string | null };

/** One side of a change. Keys are field names for a single object, or target ids when the action
 *  covered a set — see the shape note in 0068_admin_actions.sql, which is the contract this and
 *  the read endpoint both implement. */
export type ActionValues = Record<string, unknown>;

export interface AdminActionInput {
  /** The event row, or its id when the caller genuinely does not have one (the photo routes are
   *  addressed by photo id and never load the event). An id costs one extra SELECT, paid only on
   *  the rare request that turns out to be loggable. */
  event: EventRef | string;
  /** Verb, dotted, coarse: 'event.settings', 'photo.rotate', 'photo.moderate'. Coarse on purpose —
   *  the detail of WHAT changed lives in the value maps, so a new toggle needs no new verb. */
  action: string;
  targetType: 'event' | 'photo' | 'comment' | 'participant' | 'cohost';
  /** The one object acted on, or null when the action covered a set (the ids are then the keys of
   *  `before`/`after`). */
  targetId?: string | null;
  /** `null` on the after side means the object stopped existing; on the before side, that it did
   *  not exist yet. See the NULL note in the migration. */
  before?: ActionValues | null;
  after?: ActionValues | null;
}

/** How much of one value is worth keeping. The only realistic offender is a theme blob on
 *  PUT /theme; everything else is a boolean, a name or a filename. Truncating beats both
 *  alternatives — refusing to log a large value at all, and letting one paste put a megabyte in
 *  a row nobody will ever read to the end. */
const MAX_VALUE_CHARS = 4096;

/** Make one value safe to hand to jsonb, and comparable.
 *
 *  The round-trip through JSON is not decoration: `before` is usually a live Drizzle row, and a
 *  Date, a Buffer or a bigint reaching the driver from it either throws or stores something no
 *  reader can interpret. Failures collapse to null rather than propagating — this is a log, and a
 *  value we cannot represent is not a reason to fail the customer's save. */
function jsonValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_VALUE_CHARS ? v.slice(0, MAX_VALUE_CHARS) + '…[truncated]' : v;
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return null;
    return s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS) + '…[truncated]' : (JSON.parse(s) as unknown);
  } catch { return null; }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(jsonValue(a)) === JSON.stringify(jsonValue(b));

/**
 * Reduce a before/after pair to WHAT ACTUALLY CHANGED, or null for "nothing did".
 *
 * THE RULE, and it is what makes the call sites one line: only the keys present in `after` are
 * considered. `before` is therefore free to be the whole event row — which is exactly what every
 * settings call site has to hand — and `after` is the patch that was just written. Nothing has to
 * enumerate the fields twice, and a field added to a settings save is logged the day it is added
 * rather than the day somebody remembers to add it here.
 *
 * Returning null for an empty diff is the other half of the filter in this file's header. The
 * settings form re-sends every field on every save, so a host (or an operator) who opens Settings,
 * changes their mind and presses Save writes no row at all — instead of an entry claiming twenty
 * fields were "changed" from and to themselves.
 */
export function changedOnly(
  before: ActionValues | null | undefined,
  after: ActionValues | null | undefined,
): { before: ActionValues | null; after: ActionValues | null } | null {
  // A deletion, or a creation: there is no pair to diff, so the one side that exists is the record.
  if (after === null || after === undefined) return before ? { before: mapValues(before), after: null } : null;
  if (before === null || before === undefined) return { before: null, after: mapValues(after) };

  const b: ActionValues = {}, a: ActionValues = {};
  for (const k of Object.keys(after)) {
    if (same(before[k], after[k])) continue;
    b[k] = jsonValue(before[k]);
    a[k] = jsonValue(after[k]);
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

const mapValues = (o: ActionValues): ActionValues => {
  const out: ActionValues = {};
  for (const k of Object.keys(o)) out[k] = jsonValue(o[k]);
  return out;
};

/** Per-request memo of "is this request loggable, and against which event row?".
 *
 *  A symbol on the request rather than a module-level cache: the answer is about one request and
 *  must die with it. Handlers that record more than once (the settings save writes the event and
 *  may also touch the guest-delivery schedule) then resolve the session and the co-host check once
 *  instead of per entry. */
const MEMO = Symbol.for('snapdini.adminActionActor');
type Actor = { user: User; event: EventRef };

async function resolveActor(req: Request, event: EventRef | string): Promise<Actor | null> {
  // THE CHEAP EXIT, AND THE ONE THAT MATTERS FOR COST. requireOrganizer has already established
  // identity for every event route: 'owner' and 'cohost' ARE the youManage test, decided from
  // rows it had to read anyway. So the overwhelmingly common case — a host saving their own
  // settings — leaves this module without a single query. Only the organizer-CODE door, which is
  // how an operator gets into somebody else's event, goes any further.
  if (req.organizerVia === 'owner' || req.organizerVia === 'cohost') return null;

  // `req.user` is set by requireAuth/requireAdmin and is `null` there for "asked, nobody home";
  // `undefined` means nothing has asked yet. A guest has no session cookie at all, so
  // currentUser() answers null without touching the database — which is what keeps this off the
  // cost of a guest rotating their own photo.
  const user = req.user !== undefined ? req.user : await auth.currentUser(req);
  if (!user || !user.isAdmin) return null;

  const ev = typeof event === 'string' ? await loadEvent(event) : event;
  if (!ev) return null;

  // An operator's own events are his own business. Checked even though requireOrganizer would
  // normally have answered 'owner' above, because the photo routes have no :joinCode and so never
  // run that middleware — without this, an admin straightening a photo on their OWN event would
  // be audited as interference.
  if (await auth.youManage(ev, user.id)) return null;
  return { user, event: ev };
}

async function loadEvent(id: string): Promise<EventRef | null> {
  const [ev] = await db.select({
    id: events.id, name: events.name, joinCode: events.joinCode, ownerUserId: events.ownerUserId,
  }).from(events).where(eq(events.id, id));
  return ev ?? null;
}

function memo(req: Request, event: EventRef | string): Promise<Actor | null> {
  const key = typeof event === 'string' ? event : event.id;
  const r = req as Request & { [MEMO]?: Map<string, Promise<Actor | null>> };
  const cache = r[MEMO] ?? (r[MEMO] = new Map());
  const hit = cache.get(key);
  if (hit) return hit;
  const p = resolveActor(req, event);
  cache.set(key, p);
  return p;
}

/**
 * Record one operator action, if it is one. Call it from any write path; it decides for itself.
 *
 * THIS FUNCTION CANNOT FAIL THE THING IT IS LOGGING, and that is the single most important
 * property it has. A customer's settings save, their photo moderation, their reveal — none of
 * them may 500 because an audit row would not insert. The log is our bookkeeping and the save is
 * their event; if we have to lose one, it is ours. So every path here is inside one catch, the
 * failure goes to the console for an operator to find, and the caller is handed a resolved promise
 * either way. `await` it or don't: it never rejects.
 *
 * WHERE TO CALL IT. After the write, except for deletions — the event row is needed to say WHICH
 * event this was, and after `DELETE FROM events` there is nothing to read. Deletions therefore
 * record first and accept the trade: an entry for a delete that then failed is a false line in a
 * log a person reads, while the reverse is a customer's event gone with nothing to show who did it.
 */
export async function recordAdminAction(req: Request, input: AdminActionInput): Promise<void> {
  try {
    const diff = changedOnly(input.before, input.after);
    // Nothing changed — see changedOnly(). Decided BEFORE resolving the actor so a no-op save
    // costs nothing at all, on any request.
    if (!diff) return;

    const actor = await memo(req, input.event);
    if (!actor) return;

    await db.insert(adminActions).values({
      at: Date.now(),
      adminUserId: actor.user.id,
      adminEmail: actor.user.email,
      adminName: actor.user.displayName ?? null,
      eventId: actor.event.id,
      eventName: actor.event.name,
      eventJoinCode: actor.event.joinCode,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      before: diff.before,
      after: diff.after,
    });
  } catch (e) {
    // Deliberately swallowed. See the contract above.
    console.error('[admin-actions] could not record %s: %s', input.action, (e as Error)?.message);
  }
}

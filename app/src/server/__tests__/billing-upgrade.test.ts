// The two ways /api/billing/upgrade gave away entitlement it was never paid for.
//
// Both were invisible from the product: the pricing UI never offers a number off the top of a
// ladder, and a webhook redelivery looks like nothing at all from the outside. Only an assertion
// finds either, which is why they are pinned here.
//
//   1. quote() answered with the number the CLIENT asked for, not the rung's cap. `maxPhotos:
//      1000000` came back out of quote() and was written to the event; shotsTierFor() had already
//      fallen back to the top rung, so the price charged was $8 — and on a ≤10-guest event, where
//      shots are free, nothing at all. durationTierFor()/retentionTierFor() fall back the same way,
//      and duration is the worse of the two: expiresAt is written from the request, so a
//      100,000-hour upgrade bought an event no purge sweep would ever reach.
//
//   2. the webhook's `upgrade` branch ADDS money (amountPaidCents + paidNow) and recorded nothing
//      about which payment it had seen. Stripe retries any delivery that is not answered 2xx, so
//      one transient failure credited the same payment twice — and because the upgrade route only
//      charges newTotal − amountPaidCents, an inflated total makes the NEXT upgrade free.
//
// The database is a stand-in that records what was asked of it (the same approach, and for the
// same reason, as mailgun-webhook.test.ts): the claims worth making here are "the roll written to
// the event was 48, not a million" and "the second delivery issued no UPDATE at all", and a real
// Postgres would let both pass for the wrong reason.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Billing switches on from the environment at module load, so this has to be set before the
// modules under test are required — hence require() below rather than a top-level import.
// Obviously fake, and never a real key: nothing in this repository carries one.
const WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.BASE_URL = 'https://example.test';

// ── A database that only remembers what it was told ──────────────────────────

const tableName = (t: unknown): string =>
  (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? 'unknown';

/** Pull the bound values back out of a Drizzle condition, so the fake can honour a delete by id
 *  rather than guessing. `eq(col, x)` carries the column and a Param holding x. */
function condValues(cond: unknown): unknown[] {
  const vals: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if ('value' in n && (typeof n.value === 'string' || typeof n.value === 'number')) vals.push(n.value);
    if (Array.isArray(n.queryChunks)) n.queryChunks.forEach(walk);
  };
  walk(cond);
  return vals;
}

interface Op { kind: 'select' | 'update' | 'insert' | 'delete'; table: string; set?: Record<string, unknown>; values?: Record<string, unknown> }

type EventRow = Record<string, unknown> & { id: string };
let eventRow: EventRow | null = null;
let ops: Op[] = [];
/** The rows of processed_stripe_events, i.e. which Stripe events have been claimed. */
let claims: Set<string>;
/** Make every UPDATE throw, for the "a transient failure must not lose the payment" test. */
let updatesBroken = false;

const opsOn = (table: string, kind: Op['kind']) => ops.filter((o) => o.table === table && o.kind === kind);

// Typed `any` throughout and deliberately: this stands in for a Drizzle query builder, whose types
// exist to describe SQL that is not being generated here.
/* eslint-disable @typescript-eslint/no-explicit-any */
function chain<T>(produce: (c: any) => T): any {
  const o: any = {
    where(cond: unknown) { o._where = condValues(cond); return o; },
    set(v: Record<string, unknown>) { o._set = v; return o; },
    values(v: Record<string, unknown>) { o._values = v; return o; },
    onConflictDoNothing() { o._onConflict = true; return o; },
    returning() { return o; },
    limit() { return o; },
    innerJoin() { return o; },
    then(res: (v: T) => unknown, rej: (e: unknown) => unknown) {
      return Promise.resolve().then(() => produce(o)).then(res, rej);
    },
  };
  return o;
}

const fakeDb = {
  select() {
    return {
      from(t: unknown) {
        return chain(() => {
          const table = tableName(t);
          ops.push({ kind: 'select', table });
          return table === 'events' && eventRow ? [eventRow] : [];
        });
      },
    };
  },
  update(t: unknown) {
    return chain((c) => {
      const table = tableName(t);
      if (updatesBroken) throw new Error('connection terminated unexpectedly');
      ops.push({ kind: 'update', table, set: c._set });
      if (table === 'events' && eventRow) applySet(eventRow as Record<string, unknown>, c._set);
      return [];
    });
  },
  insert(t: unknown) {
    return chain((c) => {
      const table = tableName(t);
      ops.push({ kind: 'insert', table, values: c._values });
      if (table !== 'processed_stripe_events') return [];
      // ON CONFLICT DO NOTHING … RETURNING: a row comes back only when the insert actually won.
      const id = String(c._values.id);
      if (claims.has(id)) return [];
      claims.add(id);
      return [{ id }];
    });
  },
  delete(t: unknown) {
    return chain((c) => {
      const table = tableName(t);
      ops.push({ kind: 'delete', table });
      if (table === 'processed_stripe_events') for (const v of c._where ?? []) claims.delete(String(v));
      return [];
    });
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// Swapped into the module cache BEFORE the routes are first loaded, so their `import { db }`
// resolves to the stand-in. A unit suite that opens a socket is one that passes or fails on what
// else is running on the machine.
const dbPath = require.resolve('../db');
require(dbPath);                                     // constructs a pool object; connects to nothing
require.cache[dbPath]!.exports = { db: fakeDb, schema: {}, pool: {} };

const billing = require('../billing') as typeof import('../billing');
const { quote, customPlanError, MAX_QUOTABLE_SHOTS, MAX_QUOTABLE_HOURS, MAX_QUOTABLE_DAYS,
        MAX_QUOTABLE_GUESTS, FREE_ALL_GUESTS, SHOTS_TIERS } = billing;
const routes = require('../routes/billing') as typeof import('../routes/billing');

// ── Driving the two handlers ─────────────────────────────────────────────────

interface Reply { code: number; body: any }   // eslint-disable-line @typescript-eslint/no-explicit-any
function fakeRes(): { res: unknown; rec: Reply } {
  const rec: Reply = { code: 200, body: undefined };
  const res: Record<string, unknown> = {
    status(c: number) { rec.code = c; return res; },
    json(b: unknown) { rec.body = b; return res; },
    end() { return res; },
  };
  return { res, rec };
}

/** The upgrade route, pulled off its own router so the test drives the handler and not Express. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routeHandler = (path: string): ((req: any, res: any) => Promise<void>) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (routes.default as any).stack.find((l: any) => l.route?.path === path);
  assert.ok(layer, `no route at ${path} — the handler under test has moved`);
  return layer.route.stack[0].handle;
};

async function upgrade(body: Record<string, unknown>): Promise<Reply> {
  const { res, rec } = fakeRes();
  await routeHandler('/upgrade')({ body }, res);
  return rec;
}

const START = 1_800_000_000_000;

/** A ≤10-guest event: free, fully featured, nothing paid. The cheapest possible starting point,
 *  and the one where an unpriced upgrade does the most damage — every diff comes out ≤ 0. */
const freeEvent = (over: Partial<EventRow> = {}): EventRow => ({
  id: 'ev-1', joinCode: 'ABCD12', slug: 'party', organizerCode: 'org-secret',
  guestCap: FREE_ALL_GUESTS, maxPhotos: 12, videoSeconds: 0, retentionDays: 7,
  aspectRatios: '["1:1"]', startsAt: START, expiresAt: START + 4 * 3_600_000,
  amountPaidCents: 0, paid: true, brandingRemovalPaid: false, purgeAt: START + 11 * 86_400_000,
  ...over,
});

const auth = { joinCode: 'ABCD12', organizerCode: 'org-secret' };

/** A Stripe event, signed the way Stripe signs it, so the real constructEvent() verifies it. */
function stripeEvent(id: string, metadata: Record<string, string>, amountTotal = 1000) {
  const payload = JSON.stringify({
    id, object: 'event', type: 'checkout.session.completed', api_version: '2025-01-01',
    data: { object: { id: 'cs_' + id, object: 'checkout.session', payment_status: 'paid',
                      amount_total: amountTotal, payment_intent: 'pi_' + id, metadata } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return { body: Buffer.from(payload), get: (h: string) => (h === 'stripe-signature' ? `t=${ts},v1=${v1}` : undefined) };
}

const upgradeMeta = (over: Record<string, string> = {}) => ({
  eventId: 'ev-1', kind: 'upgrade', amountCents: '1000', guestCap: '60', maxPhotos: '24',
  videoSeconds: '0', retentionDays: '31', aspectRatios: '["1:1"]',
  expiresAt: String(START + 48 * 3_600_000), ...over,
});

async function deliver(evt: ReturnType<typeof stripeEvent>): Promise<Reply> {
  const { res, rec } = fakeRes();
  await routes.stripeWebhookHandler(evt as never, res as never);
  return rec;
}

beforeEach(() => {
  ops = [];
  claims = new Set();
  updatesBroken = false;
  eventRow = freeEvent();
});

// ── Finding 1, at the source: quote() answers with the rung, not the request ──

describe('quote() never hands back the number that was asked for', () => {
  const big = (over: Partial<Parameters<typeof quote>[0]> = {}) =>
    quote({ maxGuests: FREE_ALL_GUESTS + 1, maxPhotos: 12, aspectRatios: ['1:1'], videoSeconds: 0,
            durationHours: 4, retentionDays: 7, ...over });

  test('a million shots buys the top rung, not a million shots', () => {
    const q = big({ maxPhotos: 1_000_000 });
    assert.equal(q.maxPhotos, MAX_QUOTABLE_SHOTS);
    // And it is charged, so this is a clamp rather than a giveaway: the price was always the top
    // rung's — only the allowance was wrong.
    assert.equal(q.shotsCents, SHOTS_TIERS[SHOTS_TIERS.length - 1].amountCents);
  });

  test('and on a free event, where the shots cost nothing, it is still the top rung', () => {
    // The worst case of the two: shotsCents is 0 here, so the whole upgrade priced at $0.
    const q = big({ maxGuests: FREE_ALL_GUESTS, maxPhotos: 1_000_000 });
    assert.equal(q.tier, 'free');
    assert.equal(q.shotsCents, 0);
    assert.equal(q.maxPhotos, MAX_QUOTABLE_SHOTS);
  });

  test('the rungs the UI actually offers are untouched', () => {
    for (const t of SHOTS_TIERS) assert.equal(big({ maxPhotos: t.maxShots }).maxPhotos, t.maxShots);
  });
});

describe('a duration or retention no rung fits is refused, not priced at the top rung', () => {
  const at = (over: Partial<Parameters<typeof quote>[0]>) =>
    quote({ maxGuests: FREE_ALL_GUESTS + 1, maxPhotos: 12, aspectRatios: ['1:1'], videoSeconds: 0,
            durationHours: 4, retentionDays: 7, ...over });

  test('past the top duration rung the quote is custom and has no price at all', () => {
    const q = at({ durationHours: MAX_QUOTABLE_HOURS + 1 });
    assert.equal(q.tier, 'custom');
    assert.equal(q.customReason, 'duration');
    assert.equal(q.amountCents, 0);
    assert.equal(q.requiresPayment, false);
  });

  test('past the top retention rung, the same', () => {
    const q = at({ retentionDays: MAX_QUOTABLE_DAYS + 1 });
    assert.equal(q.tier, 'custom');
    assert.equal(q.customReason, 'retention');
    assert.equal(q.amountCents, 0);
  });

  test('a free event is not a way around either ladder', () => {
    // Duration and retention are charged independently of guest count, so ≤10 guests is exactly
    // where an off-the-ladder duration cost nothing and expired in 2037.
    assert.equal(at({ maxGuests: FREE_ALL_GUESTS, durationHours: 100_000 }).tier, 'custom');
    assert.equal(at({ maxGuests: FREE_ALL_GUESTS, retentionDays: 100_000 }).tier, 'custom');
  });

  test('the top rungs themselves still sell, priced', () => {
    const d = at({ durationHours: MAX_QUOTABLE_HOURS });
    assert.equal(d.tier, 'paid');
    assert.ok(d.durationCents > 0);
    const r = at({ retentionDays: MAX_QUOTABLE_DAYS });
    assert.equal(r.tier, 'paid');
    assert.ok(r.retentionCents > 0);
  });

  test('the refusal names the limit that was actually hit', () => {
    // Being told "events over 400 guests need a custom plan" when you asked for 100,000 hours
    // reads as our pricing being broken, and names nothing the host can change.
    assert.match(customPlanError(at({ durationHours: 100_000 })), /days/);
    assert.doesNotMatch(customPlanError(at({ durationHours: 100_000 })), new RegExp(`${MAX_QUOTABLE_GUESTS} guests`));
    assert.match(customPlanError(at({ maxGuests: MAX_QUOTABLE_GUESTS + 1 })), new RegExp(`${MAX_QUOTABLE_GUESTS} guests`));
  });
});

// ── Finding 1, where it was exploitable: POST /api/billing/upgrade ────────────

describe('POST /upgrade cannot be asked for an entitlement it will not charge for', () => {
  test('a million shots applies as the top rung', async () => {
    const r = await upgrade({ ...auth, maxPhotos: 1_000_000 });
    assert.equal(r.body?.applied, true);          // free delta on a ≤10-guest event: applied at once
    const written = opsOn('events', 'update').at(-1)?.set;
    assert.equal(written?.maxPhotos, MAX_QUOTABLE_SHOTS,
      'the event was entitled to the number the client asked for');
  });

  test('an eleven-year event is refused outright', async () => {
    const r = await upgrade({ ...auth, durationHours: 100_000 });
    assert.equal(r.code, 400);
    assert.match(String(r.body?.error), /custom plan/i);
    // The damage was never the price — it was expiresAt/purgeAt being written from the request, so
    // nothing may be written at all.
    assert.deepEqual(opsOn('events', 'update'), []);
    assert.equal(eventRow?.expiresAt, START + 4 * 3_600_000);
  });

  test('a decade of retention is refused outright', async () => {
    const r = await upgrade({ ...auth, retentionDays: 10_000 });
    assert.equal(r.code, 400);
    assert.match(String(r.body?.error), /custom plan/i);
    assert.deepEqual(opsOn('events', 'update'), []);
  });

  test('the top rung of every ladder is still a product', async () => {
    // The guard must not swallow the feature. Seeded as already paid past this configuration so
    // the delta is free and applies here: a test that needed a checkout session would be a test
    // that talks to Stripe.
    eventRow = freeEvent({ amountPaidCents: 10_000 });
    const r = await upgrade({ ...auth, maxPhotos: MAX_QUOTABLE_SHOTS,
      durationHours: MAX_QUOTABLE_HOURS, retentionDays: MAX_QUOTABLE_DAYS });
    assert.equal(r.code, 200);
    assert.equal(r.body?.applied, true);
    const set = opsOn('events', 'update').at(-1)?.set;
    assert.equal(set?.maxPhotos, MAX_QUOTABLE_SHOTS);
    assert.equal(set?.retentionDays, MAX_QUOTABLE_DAYS);
    assert.equal(set?.expiresAt, START + MAX_QUOTABLE_HOURS * 3_600_000);
  });

  test('an upgrade never walks an existing entitlement backwards', async () => {
    // A row above the cap (created while billing was off, or before the cap existed) keeps what it
    // has: an UPGRADE route must never be a downgrade.
    eventRow = freeEvent({ maxPhotos: 100 });
    await upgrade({ ...auth, maxPhotos: 24 });
    assert.equal(opsOn('events', 'update').at(-1)?.set?.maxPhotos, 100);
  });
});

// ── Finding 2: the webhook's upgrade branch ──────────────────────────────────

/** What an UPDATE's set-value ADDS to the column.
 *
 *  The read-then-write race on `amountPaidCents`/`extraPhotos` was fixed by making the write atomic
 *  — `sql\`amount_paid_cents + 1000\`` instead of a number computed from a prior SELECT — so the
 *  recording fake now receives a drizzle `SQL` object rather than a plain number. Its chunks are
 *  [StringChunk, column, " + ", Number, StringChunk], so the delta is the one numeric chunk. A test
 *  that asks "what did this delivery charge?" has to read it out; asserting on the object itself
 *  compares a query builder to an integer and fails for a reason that has nothing to do with money.
 */
const added = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  const chunks = (v as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  return chunks.find((c) => typeof c === 'number') as number | undefined;
};

/** Apply a set-map to the fake's row the way Postgres would, resolving an atomic increment against
 *  the value already there — otherwise the model stops matching the database after the first one. */
const applySet = (row: Record<string, unknown>, set: Record<string, unknown>): void => {
  for (const [k, v] of Object.entries(set)) {
    const d = typeof v === 'number' || v === null || typeof v === 'string' || typeof v === 'boolean'
      ? undefined : added(v);
    row[k] = d === undefined ? v : (Number(row[k] ?? 0) + d);
  }
};

describe('a replayed Stripe event is credited once', () => {
  test('the same event delivered twice adds the money once', async () => {
    const evt = stripeEvent('evt_upgrade_1', upgradeMeta(), 1000);

    const first = await deliver(evt);
    assert.equal(first.code, 200);
    assert.equal(added(opsOn('events', 'update').at(-1)?.set?.amountPaidCents), 1000);

    ops = [];
    const second = await deliver(evt);                    // Stripe retrying the identical delivery
    assert.equal(second.code, 200, 'a duplicate must still be acknowledged, or Stripe keeps retrying');
    assert.deepEqual(opsOn('events', 'update'), [],
      'the replay wrote to events again — amountPaidCents is cumulative, so that is double credit');
    assert.equal(eventRow?.amountPaidCents, 1000);
  });

  test('an inflated total is what made the next upgrade free, so the total is the assertion', async () => {
    const evt = stripeEvent('evt_upgrade_2', upgradeMeta(), 5900);
    await deliver(evt);
    await deliver(evt);
    await deliver(evt);
    assert.equal(eventRow?.amountPaidCents, 5900, 'three deliveries of one payment charged us twice over');
  });

  test('a genuinely different payment is still credited', async () => {
    // The guard must key on the delivery, not on "this event has been paid for once".
    await deliver(stripeEvent('evt_upgrade_3', upgradeMeta(), 1000));
    await deliver(stripeEvent('evt_upgrade_4', upgradeMeta(), 700));
    assert.equal(eventRow?.amountPaidCents, 1700);
  });

  test('a transient failure loses nothing — the retry is a first delivery again', async () => {
    // Claiming the event id BEFORE the work is what makes the guard atomic, and it is also how a
    // guard turns one failed webhook into a payment that is never credited at all. The claim has
    // to come back when the work fails.
    const evt = stripeEvent('evt_upgrade_5', upgradeMeta(), 1500);
    updatesBroken = true;
    const failed = await deliver(evt);
    assert.equal(failed.code, 500, 'Stripe only retries a non-2xx');
    assert.ok(opsOn('processed_stripe_events', 'delete').length > 0, 'the claim was not given back');

    updatesBroken = false;
    const retry = await deliver(evt);
    assert.equal(retry.code, 200);
    assert.equal(eventRow?.amountPaidCents, 1500, 'the retry was swallowed and the payment lost');
  });

  test('an event type we do not act on is not recorded', async () => {
    // Otherwise the table fills with deliveries that changed nothing, and its one job — "have we
    // acted on this?" — gets harder to read.
    ops = [];
    const other = (() => {
      const payload = JSON.stringify({ id: 'evt_other', object: 'event', type: 'payment_intent.created', data: { object: {} } });
      const ts = Math.floor(Date.now() / 1000);
      const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
      return { body: Buffer.from(payload), get: (h: string) => (h === 'stripe-signature' ? `t=${ts},v1=${v1}` : undefined) };
    })();
    const r = await deliver(other as never);
    assert.equal(r.code, 200);
    assert.deepEqual(opsOn('processed_stripe_events', 'insert'), []);
  });
});

// ── A price change must not become a bill for people who already bought ──────
//
// The upgrade used to charge `quote(newConfig) - event.amountPaidCents`: today's price measured
// against money taken at some past moment. Move any rung and the two disagree for every event
// already sold at the old one, so a host who had changed NOTHING was quoted the difference. It was
// found in the wild — raising the 36-shot rung by $1 added $1 to the next upgrade of every existing
// 36-shot event. It now charges the delta between two configurations, both priced today.
test('an upgrade that changes nothing costs nothing, whatever was paid', async () => {
  for (const paid of [0, 100, 3900, 999_999]) {
    const ev = freeEvent({ guestCap: 60, maxPhotos: 36, amountPaidCents: paid });
    eventRow = ev;
    const r = await upgrade({ ...auth, maxGuests: ev.guestCap, maxPhotos: ev.maxPhotos,
                              videoSeconds: ev.videoSeconds, retentionDays: ev.retentionDays,
                              durationHours: 4 });   // freeEvent() runs START .. START + 4h
    assert.equal((r.body as { applied?: boolean }).applied, true,
      `paid=${paid}: re-submitting the SAME config must apply free, not open a checkout — got ` +
      JSON.stringify(r.body).slice(0, 120));
  }
});

// The other half, asserted on the ARITHMETIC rather than through the route: a real upgrade has a
// positive delta, and the delta is only what was added. Going through /upgrade would open a Stripe
// checkout, which a unit test has no key for — the free case above is the one the route can answer
// on its own, and it is the one the bug was in.
test('the delta is what was ADDED, priced today — not the whole basket', () => {
  const base = { maxGuests: 60, aspectRatios: ['1:1'], videoSeconds: 0, durationHours: 4, retentionDays: 7 };
  const now  = quote({ ...base, maxPhotos: 36 }).amountCents;
  const then = quote({ ...base, maxPhotos: 48 }).amountCents;
  assert.ok(then > now, 'more shots must cost more');
  // 36 -> 48 is one rung: $6 -> $9 on the progressive ladder, so $3 and nothing else.
  assert.equal(then - now, 300, `expected the one rung, got ${then - now}c`);
  // And the pass itself is NOT re-charged, which is the whole point.
  assert.ok(then - now < quote({ ...base, maxPhotos: 48 }).baseCents,
    'the delta must be smaller than the event pass — otherwise the pass is being billed again');
});

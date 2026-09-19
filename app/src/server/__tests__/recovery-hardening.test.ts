// Hardening around email-only recovery on POST /api/participants.
//
// The matching itself is NOT under test here and must not change: an address alone identifies one
// roll per event, deliberately, so a returning guest on a new phone who types their name
// differently still finds their photos (testsuite/specs/97-participant-email.mjs pins that).
//
// What is under test is the two things wrapped around it, because both are invisible in normal use
// and neither has a client that would notice if it silently stopped working:
//   1. the per-(event, address) budget on the recovery path — NOT per IP, which is the whole point;
//   2. the operator alert on the one recovery shape that looks like a takeover.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { recoveryAllowed, recoveryKey } from '../routes/participants';
import { isRiskyRecovery, notifyRiskyRecovery } from '../ops-notify';
import { maskAddress } from '../unsubscribe';

const SERVER = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SERVER, p), 'utf8');
/** Source with comments stripped — same helper as release-hardening.test.ts, for the same reason:
 *  a comment SAYING the code does something must not satisfy an assertion that it does. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ── A stand-in for the recovery branch: the REAL gate, on a real request ──────
// Only the two lines the route itself runs (build the key, ask the gate). Anything more would be
// testing a copy of the handler instead of the thing the handler calls.
const app = express();
app.use(express.json());
app.set('trust proxy', true);            // so x-forwarded-for actually moves req.ip, as in prod
app.post('/recover', async (req, res) => {
  const okay = await recoveryAllowed(req, res, recoveryKey(String(req.body.eventId), String(req.body.email)));
  res.status(okay ? 200 : 429).json({ recovered: okay });
});

// Started on first use, not at module scope: this file compiles to CJS, where a top-level await
// is a transform error.
let srv: Server | null = null;
let base = '';
async function listening(): Promise<string> {
  if (base) return base;
  srv = app.listen(0);
  await once(srv, 'listening');
  srv.unref();
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return base;
}
after(() => { srv?.close(); });

const attempt = async (eventId: string, email: string, ip = '203.0.113.7') => {
  const r = await fetch(`${await listening()}/recover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ eventId, email }),
  });
  return r.status;
};
let n = 0;
const freshEvent = () => `ev-${process.pid}-${n++}`;

describe('email recovery is budgeted per (event, address) — never per IP', () => {
  test('five attempts on one address are allowed, the sixth is refused', async () => {
    const ev = freshEvent();
    const got: number[] = [];
    for (let i = 0; i < 6; i++) got.push(await attempt(ev, 'guest@example.com'));
    assert.deepEqual(got, [200, 200, 200, 200, 200, 429],
      'the default budget is 5 per 15 min per address; a returning guest makes one or two');
  });

  test('a DIFFERENT address at the same event still has its own budget', async () => {
    const ev = freshEvent();
    for (let i = 0; i < 6; i++) await attempt(ev, 'burned@example.com');
    assert.equal(await attempt(ev, 'someone.else@example.com'), 200,
      'one enumerated address must not lock the rest of the guest list out of recovery');
  });

  test('the same address at a different event has its own budget', async () => {
    const a = freshEvent(), b = freshEvent();
    for (let i = 0; i < 6; i++) await attempt(a, 'guest@example.com');
    assert.equal(await attempt(b, 'guest@example.com'), 200,
      'the key includes the event, so a guest at two parties is two budgets');
  });

  test('case and surrounding space are the same bucket', async () => {
    // Must agree with the recovery lookup and the UNIQUE index on (event_id, lower(email)):
    // otherwise shifting one letter to caps is a free extra budget.
    const ev = freshEvent();
    for (let i = 0; i < 5; i++) await attempt(ev, 'Guest@Example.com');
    assert.equal(await attempt(ev, '  GUEST@EXAMPLE.COM  '), 429);
  });

  test('exhausting an address from ONE ip refuses the NEXT ip too', async () => {
    // The negative control for the keyGenerator: if this limiter ever goes back to the default
    // req.ip key, a second address on a new IP is a brand new budget and this is a 200.
    const ev = freshEvent();
    for (let i = 0; i < 6; i++) await attempt(ev, 'guest@example.com', '198.51.100.1');
    assert.equal(await attempt(ev, 'guest@example.com', '198.51.100.99'), 429,
      'the budget follows the address, not the connection');
  });

  test('a whole venue on ONE ip is not throttled — different guests, same NAT', async () => {
    // The failure mode this project has already been bitten by (see the GUEST_READ note in
    // index.ts): every guest at a wedding shares one public address.
    const ev = freshEvent();
    for (let i = 0; i < 30; i++) {
      const status = await attempt(ev, `guest${i}@example.com`, '198.51.100.50');
      assert.equal(status, 200, `guest ${i} on the shared venue IP was refused`);
    }
  });

  test('the gate is not mounted on the join route as middleware', () => {
    // A limiter on POST /api/participants would throttle FIRST-TIME joins, which is the one thing
    // this must not touch — and at a venue that is the whole party arriving at once.
    const mounts = code('index.ts').split('\n').filter((l) => l.includes("'/api/participants"));
    assert.deepEqual(mounts.map((l) => l.trim()), ["app.use('/api/participants', participantsRoutes);"],
      'something other than the router is mounted on the join path — a limiter there would throttle first-time joins');
  });

  test('the keyGenerator does not read the IP', () => {
    const src = code('routes/participants.ts');
    const gen = src.slice(src.indexOf('keyGenerator'), src.indexOf('keyGenerator') + 160);
    assert.ok(gen.length > 0, 'no keyGenerator at all means the default, which IS req.ip');
    assert.equal(/req\.ip|ipKeyGenerator|x-forwarded-for/.test(gen), false, `keyGenerator reads the IP: ${gen}`);
  });

  test('the budget is spent before the session token is reissued', () => {
    // Order matters: a gate that ran after the UPDATE would have already handed the roll over.
    const src = code('routes/participants.ts');
    const gate = src.indexOf('recoveryAllowed(req, res');
    const handover = src.indexOf('.set({ sessionToken');
    assert.ok(gate > 0 && handover > 0, 'the recovery branch no longer looks like itself');
    assert.ok(gate < handover, 'the limiter runs after the roll has already been handed over');
  });
});

describe('a recovery that looks like a takeover is reported', () => {
  test('renaming a roll that already has photos is risky', () => {
    assert.equal(isRiskyRecovery({ name: 'Alex', photosTaken: 3 }, 'Mallory'), true);
  });
  test('the ordinary returning guest is not', () => {
    // Same name, or an empty roll: both are what recovery exists for.
    assert.equal(isRiskyRecovery({ name: 'Alex', photosTaken: 3 }, 'Alex'), false, 'same name on a shot roll');
    assert.equal(isRiskyRecovery({ name: 'Alex', photosTaken: 0 }, 'Mallory'), false, 'rename of an empty roll');
    assert.equal(isRiskyRecovery({ name: 'Alex', photosTaken: 0 }, 'Alex'), false, 'nothing changed at all');
  });

  test('the alert never writes the guest address out in full', async () => {
    // Same rule guest-delivery.ts and routes/guests.ts follow: log the mask, never the address.
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      await notifyRiskyRecovery({ name: 'Wedding', joinCode: 'ABCD1234' },
        { email: 'gillian.kieran@example.com', previousName: 'Alex', newName: 'Mallory', photosTaken: 4 });
    } finally { console.warn = warn; }
    assert.equal(lines.length, 1, 'the recovery should leave exactly one line behind');
    assert.equal(lines[0].includes('gillian.kieran@example.com'), false, `raw address in the log: ${lines[0]}`);
    assert.ok(lines[0].includes(maskAddress('gillian.kieran@example.com')), `not masked with the shared helper: ${lines[0]}`);
    assert.ok(/ABCD1234/.test(lines[0]) && /4 photo/.test(lines[0]),
      'the line has to say which event and how much was at stake to be worth having');
  });

  test('it reuses the existing ops channel rather than a second one', () => {
    const src = code('ops-notify.ts');
    // notifyRiskyRecovery must go through the same gated mail() helper as every other ops alert:
    // one OPS_NOTIFICATIONS switch, one SUPPORT_EMAIL, one suppression-exempt sender.
    const fn = src.slice(src.indexOf('export async function notifyRiskyRecovery'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    assert.ok(/await mail\(/.test(body), 'the alert does not use ops-notify.mail() — that is a second channel');
    assert.equal(/sendMail|fetch\(|ntfy/.test(body), false, 'the alert talks to a transport directly');
    assert.ok(/if \(!enabled\(\)\) return;/.test(body), 'the alert is not gated on OPS_NOTIFICATIONS');
  });

  test('every guest-supplied string in the alert mail is escaped', () => {
    // htmlEmail() interpolates raw (see notifyUnhappySurvey) and BOTH names here were typed by
    // whoever made the request — including, in the case this alert exists for, the attacker.
    const src = code('ops-notify.ts');
    const fn = src.slice(src.indexOf('export async function notifyRiskyRecovery'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    for (const field of ['r.previousName', 'r.newName', 'ev.joinCode']) {
      assert.ok(body.includes(`escapeHtml(${field})`), `${field} reaches the operator's inbox unescaped`);
    }
  });

  test('the route alerts only after the recovery actually happened', () => {
    const src = code('routes/participants.ts');
    const handover = src.indexOf('.set({ sessionToken');
    const alert = src.indexOf('notifyRiskyRecovery(');
    assert.ok(alert > handover, 'an alert fired before the write can report a recovery that never occurred');
    assert.ok(/isRiskyRecovery\(existing, newName\)/.test(src), 'the route no longer gates the alert on the risky shape');
    assert.ok(/\.catch\(/.test(src.slice(alert, alert + 400)), 'a failed alert must never take the join down with it');
  });
});

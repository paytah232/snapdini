// How one database refusal is told from another — the discriminator behind the catch blocks in
// routes/guests.ts.
//
// THE DEFECT THIS EXISTS FOR. `POST /:joinCode/guests` wrapped its insert in `catch { … 409 }` and
// its own comment said the unique index "is the only thing that can fail here". Migration 0054 made
// `email` NOT NULL, which is a SECOND failure mode, so a null address came back to the host as
// *"That email is already on this guest list"* — a host sent hunting for a duplicate that does not
// exist. cleanGuest() refuses a missing address first, so it is not reachable from the outside; a
// second line of defence that answers the WRONG thing is worth no more than one that answers
// nothing, and the time to fix that is before the first line ever slips.
//
// WHY THIS FILE IS NOT A ONE-LINER. The SQLSTATE is **not on the error you catch**. Drizzle wraps
// every driver failure in a `DrizzleQueryError` carrying the query and its params, and the
// node-postgres `DatabaseError` that actually holds `.code` is its `cause`. So the obvious
// `(e as { code?: string }).code === '23505'` reads `undefined` and is quietly false for ever —
// which would have swapped one wrong answer for a different wrong answer. A test that fed
// `pgErrorCode` a bare `{ code: '23505' }` would pass against that broken version, so the shapes
// below are the REAL ones, observed from drizzle-orm 0.45.2 over pg 8 against the dev database.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pgErrorCode, PG_NOT_NULL_VIOLATION, PG_UNIQUE_VIOLATION } from '../db';

/** A node-postgres `DatabaseError` as it actually arrives: an Error with the SQLSTATE on `.code`. */
function databaseError(code: string, message: string, constraint?: string): Error {
  const e = new Error(message) as Error & { code: string; constraint?: string };
  e.name = 'error';
  e.code = code;
  if (constraint) e.constraint = constraint;
  return e;
}

/** …and as Drizzle hands it to a route: wrapped, with the code one level down on `cause`. */
function drizzleWrapped(inner: Error): Error {
  const e = new Error('Failed query: insert into "event_guests" …') as Error & { cause: Error };
  e.name = 'DrizzleQueryError';
  e.cause = inner;
  return e;
}

describe('pgErrorCode — which refusal was it', () => {
  test('reads the code off a bare driver error', () => {
    assert.equal(pgErrorCode(databaseError('23505', 'duplicate key value')), '23505');
  });

  // THE ONE THAT MATTERS. This is the shape a route catches, and reaching for `.code` on it gets
  // `undefined`. If this test ever passes only because the helper was "simplified", the guest list
  // is back to answering every failure with the same sentence.
  test('finds it through the DrizzleQueryError wrapper, where a plain .code read sees nothing', () => {
    const wrapped = drizzleWrapped(databaseError('23505', 'duplicate key value violates unique constraint',
      'idx_event_guests_event_email'));
    assert.equal((wrapped as { code?: string }).code, undefined, 'the premise: the wrapper carries no code');
    assert.equal(pgErrorCode(wrapped), PG_UNIQUE_VIOLATION);
  });

  test('and tells a not-null violation apart from it — the two the guest list confused', () => {
    const notNull = drizzleWrapped(databaseError('23502',
      'null value in column "email" of relation "event_guests" violates not-null constraint'));
    assert.equal(pgErrorCode(notNull), PG_NOT_NULL_VIOLATION);
    assert.notEqual(PG_NOT_NULL_VIOLATION, PG_UNIQUE_VIOLATION);
  });

  test('the codes are the SQLSTATEs from the standard, not names of our own', () => {
    assert.equal(PG_UNIQUE_VIOLATION, '23505');
    assert.equal(PG_NOT_NULL_VIOLATION, '23502');
  });

  // Not speculative: a transaction helper or a driver swap is exactly the change that adds a layer,
  // and it must not silently turn every code back into null.
  test('survives another layer of wrapping', () => {
    assert.equal(pgErrorCode(drizzleWrapped(drizzleWrapped(databaseError('23505', 'dup')))), '23505');
  });

  test('a fault that is not the database refusing anything reads as null', () => {
    assert.equal(pgErrorCode(new TypeError('cannot read properties of undefined')), null);
    assert.equal(pgErrorCode(drizzleWrapped(new TypeError('boom'))), null);
    assert.equal(pgErrorCode(undefined), null);
    assert.equal(pgErrorCode(null), null);
    assert.equal(pgErrorCode('a string someone threw'), null);
  });

  // Node's own errors carry string codes too ('ECONNREFUSED' on a dead database). Returning it
  // rather than pretending it is a SQLSTATE is the honest answer: the caller compares against the
  // two codes it handles and rethrows everything else, so an unrecognised code becomes a 500 — a
  // fault, which is what a dead database is.
  test('a non-SQLSTATE code is returned as itself, so the caller rethrows it', () => {
    assert.equal(pgErrorCode(databaseError('ECONNREFUSED', 'connect ECONNREFUSED')), 'ECONNREFUSED');
  });

  test('a numeric or empty code is not mistaken for one', () => {
    const numeric = new Error('odd') as Error & { code: number };
    numeric.code = 23505;
    assert.equal(pgErrorCode(numeric), null);
    const blank = new Error('odd') as Error & { code: string };
    blank.code = '';
    assert.equal(pgErrorCode(blank), null);
  });

  // An empty-coded wrapper must not stop the walk before it reaches the real one.
  test('keeps walking past a layer that has no code of its own', () => {
    const outer = new Error('outer') as Error & { cause: unknown };
    outer.cause = drizzleWrapped(databaseError('23502', 'null value'));
    assert.equal(pgErrorCode(outer), '23502');
  });

  test('a self-referential cause terminates instead of hanging', () => {
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;
    assert.equal(pgErrorCode(loop), null);
  });
});

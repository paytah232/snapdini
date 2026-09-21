// A request with no body must still get the answer it used to get.
//
// WHAT CHANGED UNDERNEATH US. express 5 brings body-parser 2, and body-parser 2 sets
// `req.body = undefined` where 1.x left an empty object behind (lib/read.js: `if (!('body' in
// req)) req.body = undefined`). Nothing in the upgrade notes makes much of it, and nothing in
// this app's suite noticed, because every test that drives a handler hands it a body.
//
// WHAT IT COST. Around forty handlers across the routers read a field the way a handler
// naturally does — `const { theme } = req.body`, `(req.body as { set?: unknown }).set` — and
// every one of them now throws a TypeError on a request that arrives without one. express 5
// forwards a rejected handler promise to the error middleware by itself, so the TypeError lands
// there and comes back as 500 "Something went wrong". The endpoint had a perfectly good 400 for
// exactly this case; the 400 is now unreachable and the logs fill with a stack trace per probe.
// A POST with no Content-Type is not an exotic request: it is what every scanner, every
// hand-rolled curl and every fetch() that forgot its header sends.
//
// WHY THE FIX IS ONE MIDDLEWARE AND NOT FORTY `?? {}`s. Forty edits is forty chances to miss one
// — the audit that found this had itself only listed eight — and forty places for the next
// handler to be written without it. Restoring the property the whole codebase was written
// against, once, where the bodies are parsed, leaves every handler taking the branch and
// returning the status code it did under express 4.
//
// WHAT THIS FILE PINS. Not a handler: the handlers are the things that must NOT have to change,
// so there is nothing new in any of them to test. What is testable is the pipeline — the shape
// `req.body` really has after express.json() with and without the middleware, that a real body
// still reaches a handler untouched, that a parser mounted further down still gets to do its job
// — and that the entrypoint actually mounts the thing, which is the half that would otherwise be
// a correct middleware nobody runs.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import { bodyDefaultsToEmpty } from '../lib';

// ── Two apps, identical but for the one line under test ──────────────────────

/** The same three handlers on both, each one a faithful copy of a real shape from the routers.
 *
 *  Copies rather than the routers themselves, deliberately: mounting events.ts here would drag a
 *  database, an organizer gate and a rate limiter into a question that is entirely about what
 *  `req.body` is when the handler starts. The shapes are what matter and they are quoted
 *  verbatim — `const { theme } = req.body as { theme?: unknown }` is PUT /:joinCode/theme, line
 *  for line. */
function buildApp(fixed: boolean): express.Express {
  const app = express();
  app.use(express.json());
  if (fixed) app.use(bodyDefaultsToEmpty);

  // What the body IS, as the handler sees it. The mechanism, with nothing in between.
  app.post('/shape', (req: Request, res: Response) => {
    res.json({ shape: req.body === undefined ? 'undefined' : typeof req.body });
  });

  // events.ts, PUT /api/events/:joinCode/theme.
  app.post('/theme', (req: Request, res: Response) => {
    const { theme } = req.body as { theme?: unknown };
    if (!theme || typeof theme !== 'object') return res.status(400).json({ error: 'Invalid theme' });
    return res.json({ ok: true });
  });

  // /api/guest-unsubscribe: a parser mounted BELOW the middleware, which must still be allowed to
  // read the request and replace the placeholder with what it finds.
  app.post('/form', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const scope = (req.body as { scope?: unknown })?.scope;
    res.json({ scope: scope ?? null });
  });

  // index.ts's own last resort, which is where a TypeError from any of the above ends up.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error('(expected by this test)', (err as Error)?.message);
    return res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}

/** Started on first use, not at module scope: this file compiles to CJS, where a top-level await
 *  is a transform error. Same construction as recovery-hardening.test.ts. */
function server(app: express.Express): () => Promise<string> {
  let srv: Server | null = null;
  let base = '';
  const start = async (): Promise<string> => {
    if (base) return base;
    srv = app.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    srv.unref();
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    return base;
  };
  after(() => { srv?.close(); });
  return start;
}

const asShipped = server(buildApp(true));
const asBroken = server(buildApp(false));

interface Reply { status: number; body: Record<string, unknown> }

async function post(at: () => Promise<string>, route: string, init: RequestInit = {}): Promise<Reply> {
  const r = await fetch(`${await at()}${route}`, { method: 'POST', ...init });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

/** A POST with a body nobody parses — no Content-Type, so express.json() declines it and leaves
 *  the field as body-parser 2 left it. This is the request, and it is the ordinary one. */
const bodyless = { headers: { 'content-length': '0' } } as RequestInit;

describe('express 5 leaves req.body undefined, and the app is written against {}', () => {
  test('the mechanism itself: with no parser willing to touch it, the body is undefined', async () => {
    // THE PREMISE, pinned rather than assumed. If a future body-parser goes back to leaving an
    // empty object, this fails — and that is the right outcome: it is the notice that the
    // middleware below has become redundant, which is information nobody would otherwise get.
    assert.deepEqual((await post(asBroken, '/shape', bodyless)).body, { shape: 'undefined' });
  });

  test('a handler that destructures it therefore answers 500, not its own 400', async () => {
    const r = await post(asBroken, '/theme', bodyless);
    assert.equal(r.status, 500, 'this is the defect: a client mistake reported as a server fault');
    assert.deepEqual(r.body, { error: 'Something went wrong' });
  });

  test('with the middleware it gets the 400 the endpoint was written to give', async () => {
    assert.deepEqual((await post(asShipped, '/shape', bodyless)).body, { shape: 'object' });
    const r = await post(asShipped, '/theme', bodyless);
    assert.equal(r.status, 400, 'the handler is unchanged — it simply reaches its own guard again');
    assert.deepEqual(r.body, { error: 'Invalid theme' });
  });

  test('a real body is not touched on the way past', async () => {
    // GUARD. A middleware that overwrote rather than defaulted would empty every request in the
    // product and the suite above would still be green.
    const r = await post(asShipped, '/theme', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: { accent: '#ff0000' } }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });

  test('a parser mounted BELOW it still gets to read the request', async () => {
    // GUARD, and the one that justifies the placement. body-parser decides whether to parse from
    // the request STREAM, not from the value of req.body, so the placeholder does not close the
    // door on the urlencoded parser on /api/guest-unsubscribe or on multer for the uploads. If
    // that were ever to change, every form post and every photo upload would arrive empty.
    const r = await post(asShipped, '/form', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'scope=all',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { scope: 'all' });
  });
});

describe('the entrypoint actually mounts it', () => {
  // Source, with the comments stripped — same helper and same reason as release-hardening and
  // recovery-hardening: a comment SAYING the middleware is mounted must not satisfy an assertion
  // that it is. This codebase has been caught by that three times.
  const code = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  test('imported from lib and mounted, immediately after the global parser', () => {
    assert.match(code, /import\s*\{[^}]*\bbodyDefaultsToEmpty\b[^}]*\}\s*from\s*'\.\/lib';/,
      'the entrypoint does not import the middleware');
    const parser = code.indexOf('app.use(express.json());');
    const fix = code.indexOf('app.use(bodyDefaultsToEmpty);');
    assert.notEqual(parser, -1, 'the global JSON parser has moved; this test needs rewriting');
    assert.notEqual(fix, -1, 'the middleware is defined but never mounted — every handler is still exposed');
    assert.ok(fix > parser,
      'it has to run AFTER express.json(), or it would fill in a body the parser then overwrites ' +
      'anyway and, worse, would be reasoning about a request nobody has read yet');
  });

  test('and before every router that reads a body', () => {
    // The routers are the forty call sites. A mount that landed below them would be a middleware
    // that runs on nothing at all, which is the failure this pair of assertions exists to catch.
    const fix = code.indexOf('app.use(bodyDefaultsToEmpty);');
    // -1 would sit below everything and quietly satisfy every comparison below, so an unmounted
    // middleware would pass this test while failing the one above. Caught exactly that way.
    assert.notEqual(fix, -1, 'the middleware is not mounted at all');
    for (const router of ["app.use('/api/photos', photosRoutes);",
                          "app.use('/api/events', eventsRoutes);",
                          "app.use('/api/auth', authLimiter, authRoutes);"]) {
      const at = code.indexOf(router);
      assert.notEqual(at, -1, `${router} has moved; this test needs rewriting`);
      assert.ok(fix < at, `${router} is mounted above the middleware, so its handlers never see the fix`);
    }
  });
});

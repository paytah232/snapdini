// CSP violation reporting — and, more to the point, what it refuses to write down.
//
// A CSP report carries `document-uri` and `blocked-uri` in full. On this app those URLs hold join
// codes, share slugs and recovery tokens, so a handler that logs a report verbatim copies live
// credentials into a log file nobody treats as secret. That is the failure these tests exist for:
// the feature working is easy to notice, the leak is not.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
// Searched FROM the handler, not from the top of the file: `app.use('/api', apiBackstop)` also
// appears in a comment further up, so a plain indexOf finds that one and the slice runs backwards
// — producing an empty string that every assertion below then "fails" against for the wrong reason.
const START = SRC.indexOf("app.post('/api/csp-report'");
const handler = SRC.slice(START, SRC.indexOf("app.use('/api', apiBackstop)", START));
// If either marker ever moves, say so here rather than letting every test fail as a mystery.
if (START < 0 || !handler) throw new Error('csp-report handler not found in index.ts — update the markers');

describe('CSP reports', () => {
  test('logs the blocked ORIGIN, never the URL', () => {
    // originOf() is the whole guard: a full blocked-uri can carry a query string of its own.
    assert.match(handler, /blocked = originOf\(/);
    assert.ok(!/blockedURL\s*\)?\s*\}/.test(handler.replace(/originOf\([^)]*\)/g, '')),
      'blocked-uri must only ever reach the log through originOf');
  });

  test('logs the document PATH, never its query string', () => {
    // `new URL(...).pathname` drops ?token=… — the part that would be the actual leak.
    assert.match(handler, /new URL\(String\(r\.documentURL[^)]*\)\)\.pathname/);
    assert.ok(!handler.includes('documentURI}') && !handler.includes('${r.documentURL}'),
      'the document URL must never be interpolated whole');
  });

  test('accepts both report shapes, because browsers disagree', () => {
    // Old: {"csp-report": {...}} with hyphenated keys. Reporting API: [{ body: {...} }] camelCase.
    assert.match(handler, /Array\.isArray\(body\)/);
    assert.match(handler, /csp-report/);
    assert.match(handler, /r\?\.body/);
    assert.match(handler, /\['effective-directive'\]/);
  });

  test('is bounded in every direction an open endpoint can be pushed', () => {
    // Unauthenticated by necessity — browsers send it with no credentials — so the limits ARE the
    // security. A 16kb body, at most 5 reports read from one payload, and its own rate limiter.
    assert.match(handler, /limit: '64kb'/);
    // 64kb, not 16kb: the Reporting API BATCHES reports, and a batch carrying a script-sample each
    // is nothing like one report. Measured in production the day this shipped — one Chrome sent the
    // same oversized payload seven times in twenty minutes.
    //
    // And anything STILL over the cap gets 204, not 413. A 413 tells a browser to try again later,
    // so refusing an unreadable report bought a retry storm instead of quiet. This is the assertion
    // that matters: the cap can be tuned, the "never answer a report with a retryable error" cannot.
    assert.match(handler, /entity\.too\.large/);
    assert.match(handler, /entity\.too\.large.*\n?.*res\.status\(204\)\.end\(\)/);
    assert.match(handler, /reports\.slice\(0, 5\)/);
    assert.match(handler, /cspReportLimiter/);
    assert.match(SRC, /const cspReportLimiter = rateLimit\(/);
  });

  test('answers 204 and nothing else', () => {
    // No browser reads this response; a body would only be something to probe.
    assert.match(handler, /res\.status\(204\)\.end\(\)/);
  });
});

describe('the face-matching boot line', () => {
  test('says which state it is in, loudly, in BOTH states', () => {
    // The kill switch is sound; deployment is the risk, because devel HAS the variable set and one
    // copied env file turns the feature on in production without a word. Printing in both states is
    // deliberate: a line that only appears when something is wrong is a line nobody learns to look
    // for, and its absence then proves nothing.
    const boot = SRC.slice(SRC.indexOf("console.log(process.env.MACHINE_LEARNING_URL"), SRC.indexOf('const server = app.listen'));
    assert.match(boot, /FACE MATCHING IS LIVE/);
    assert.match(boot, /inert/);
    assert.match(boot, /PIA-face-matching\.md/);   // says where the obligation is written down
  });
});

// Can the server actually start.
//
// WHY THIS FILE EXISTS, and it is the sharpest lesson of the whole dependency upgrade.
//
// Moving to express 5 required deleting `express-async-errors`. Not as tidying — the shim
// deep-requires `express/lib/router/layer`, a path express 5 does not have, so merely importing it
// throws MODULE_NOT_FOUND. With it left in, the server would not have booted. At all. Not a
// degraded mode, not a failing endpoint: no process.
//
// The unit suite reported 1175 passing throughout. Every one of those tests imports a route module
// or a pure function directly, and NOTHING imports the entrypoint, so a total boot failure was
// invisible to the entire suite. That is not a gap in coverage of a feature; it is a gap in
// coverage of whether the product runs.
//
// The obvious fix — import index.ts here — is not available: it calls app.listen() and needs a
// database, so it would turn a unit suite into an integration harness and still not be a boot test.
// What IS available, and is what the failure was made of, is this: every third-party package the
// entrypoint pulls in must survive being LOADED, in a real Node process, against the versions
// actually installed.
//
// Note the distinction the express-async-errors failure turns on. `require.resolve()` on it
// SUCCEEDS — the package is present and its main field is fine. It throws only when executed,
// because the deep require runs at load time. So resolving is not enough; this has to run the
// module body, which is why each one is loaded in a child process rather than imported here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const APP_DIR = path.join(__dirname, '..', '..', '..');
const ENTRY = path.join(__dirname, '..', 'index.ts');

/** Every bare (non-relative) package the entrypoint imports. Read from the source rather than
 *  listed here, so a package added tomorrow is covered without anyone remembering this file. */
function entrypointPackages(): string[] {
  const src = fs.readFileSync(ENTRY, 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'".][^'"]*)['"]/gm)) {
    // Strip a subpath: we care whether the package loads, and its entry is what index.ts gets.
    const spec = m[1];
    found.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  }
  return [...found].sort();
}

describe('the entrypoint can actually be loaded', () => {
  test('it imports a plausible number of packages — this file is reading the real thing', () => {
    // A guard on the guard. If the regex ever stops matching (a refactor to `require`, a change of
    // quoting style), this file would quietly test nothing at all while still passing, which is
    // precisely the failure it was written about.
    const pkgs = entrypointPackages();
    assert.ok(pkgs.length >= 6, `only found ${pkgs.length} packages in index.ts — the scan has broken`);
    for (const must of ['express', 'helmet', 'multer', 'uuid', 'drizzle-orm']) {
      assert.ok(pkgs.includes(must), `expected the entrypoint to import ${must}; scan found: ${pkgs.join(', ')}`);
    }
  });

  test('every package it imports survives being loaded, not merely resolved', () => {
    // One child process for the lot: loading is the expensive part and a single failure names
    // itself in the output. `require` rather than import() because this app is CommonJS under tsx,
    // which is the same way it loads in production.
    const pkgs = entrypointPackages().filter((p) => !['path', 'fs'].includes(p));
    const script = pkgs.map((p) =>
      `try { require(${JSON.stringify(p)}); } catch (e) { fails.push(${JSON.stringify(p)} + ': ' + e.message); }`
    ).join('\n');
    const out = execFileSync(process.execPath, ['-e',
      `const fails = [];\n${script}\nprocess.stdout.write(fails.join('\\n'));`
    ], { cwd: APP_DIR, encoding: 'utf8' });
    assert.equal(out.trim(), '',
      `the entrypoint imports packages that throw when loaded — the server would not boot:\n${out}`);
  });

  test('nothing has crept back that express 5 cannot live with', () => {
    // express-async-errors by name, because this is the one that did it and the temptation to
    // re-add it is real: it is still the top answer everywhere for async error handling in express,
    // and it is now not only unnecessary but fatal. express 5 forwards a rejected promise from a
    // handler to the error middleware by itself — proven separately by the smoke test that renamed
    // a table out from under a live route and got the error handler's own 500 body back.
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.ok(!('express-async-errors' in deps),
      'express-async-errors deep-requires express/lib/router/layer, which express 5 removed — ' +
      'importing it throws MODULE_NOT_FOUND and the server does not start');
    // An IMPORT of it, not a mention. The entrypoint deliberately keeps a comment explaining why
    // the import is gone — which is worth having, and which the first version of this assertion
    // flagged as the bug itself. Matching prose instead of code is the exact failure this
    // codebase has now hit three times in source-shape tests; the fix is always to look for the
    // statement, never the name.
    const entry = fs.readFileSync(ENTRY, 'utf8');
    assert.doesNotMatch(entry, /^\s*(?:import\s[^\n]*['"]express-async-errors['"]|(?:const|let|var)\s[^\n]*require\(['"]express-async-errors['"]\))/m,
      'the entrypoint imports express-async-errors again');
    // And express really is 5, or the assertion above is guarding nothing.
    assert.match(String(deps.express), /^[\^~]?5\./, `expected express 5, found ${deps.express}`);
  });
});

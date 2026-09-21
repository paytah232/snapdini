// What this PUBLIC repository must not contain.
//
// Snapdini's repo is public and its docs are meant to be. One document is not: the internal privacy
// impact assessment for face matching is working notes for our own legal review — it has open
// questions in it and "Reviewed by: _pending_" at the bottom — and publishing an unreviewed legal
// assessment for a live business is a liability rather than transparency.
//
// It was removed once, in `3aed2c1`, with the reasoning written into the commit message. Thirteen
// days later it came back, added by an unrelated commit about security headers, and sat on the
// public remote until someone went looking. That is the failure this file exists for: a decision
// recorded only in a commit message has nothing holding it. The `.gitignore` rule is the mechanism;
// these tests are what notice if the mechanism goes away with it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** The repo root, found by PROBING for it rather than by counting `..` segments.
 *
 *  Counting is what made the first version of this file useless: it sat in a suite run inside a
 *  container that mounts only `app/src`, four levels up landed outside the mount, `docs/` did not
 *  exist there, and "the document is not in the tree" PASSED while the document was in the tree.
 *
 *  Throwing when the root cannot be found is the point. This suite is also run via `docker exec`,
 *  where it will throw — the same way `compose-env.test.ts` and `photo-rotate-route.test.ts`
 *  already do, and for the same reason. A guard that cannot see what it guards must fail. Run the
 *  app suite on the HOST. */
function repoRoot(): string {
  // All four, because `.gitignore` + `docs/` is NOT unique — `app/` has both, so a two-marker
  // probe stopped one directory early and the absence check passed against `app/docs` instead of
  // `docs`. Vacuous in exactly the way the counting version was. The monorepo root is the only
  // place that also holds README.md alongside both package directories.
  const markers = ['.gitignore', 'README.md', 'app', 'web'];
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (markers.every((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    `monorepo root (a dir holding ${markers.join(', ')}) not found above ${__dirname} — this guard ` +
    `cannot run, which is a failure and not a pass. Run the app suite on the host, not in the container.`);
}

const ROOT = repoRoot();

// Assembled rather than written out, so this file does not match its own search. The alternative is
// excluding this path from the walk, which then also blinds the walk to a real reference added here
// later. Splitting the needle costs one line and has no such hole.
const DOC = 'PIA-face' + '-matching.md';

describe('the internal privacy assessment stays out of the public repo', () => {
  test('is not in the working tree', () => {
    // Anchored to a root that has been PROVEN to be the right one: an absence check is only as good
    // as the directory it looked in, and looking in the wrong one is indistinguishable from a pass.
    assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'DEVELOPMENT.md')),
      `${ROOT}/docs does not look like the repo's docs/ — the absence check below would be vacuous`);
    assert.ok(!fs.existsSync(path.join(ROOT, 'docs', DOC)),
      `docs/${DOC} is an internal document and must not be committed — it belongs in ../private/`);
  });

  test('is kept out by .gitignore, so `git add -A` cannot sweep it back in', () => {
    // The removal is only durable if the rule is there too. This is the half that actually failed.
    const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
    assert.ok(lines.includes(`/docs/${DOC}`),
      `.gitignore must name /docs/${DOC} — without the rule the file returns on the next add -A`);
  });

  test('is not linked from any shipped source or doc', () => {
    // A link to a file we cannot publish is not guidance, and it is how the document comes back:
    // someone follows the reference, finds it missing, and "fixes" that by committing it.
    const roots = ['app/src', 'web/src', 'shared', 'docs', 'README.md', 'TESTING.md'];
    const skip = new Set(['node_modules', '.svelte-kit', 'build', 'test-results']);
    const hits: string[] = [];

    const walk = (abs: string, rel: string): void => {
      if (fs.statSync(abs).isDirectory()) {
        if (skip.has(path.basename(abs))) return;
        for (const e of fs.readdirSync(abs)) walk(path.join(abs, e), `${rel}/${e}`);
        return;
      }
      if (!/\.(ts|js|svelte|sql|md)$/.test(abs)) return;
      fs.readFileSync(abs, 'utf8').split('\n').forEach((line: string, i: number) => {
        if (line.includes(DOC)) hits.push(`${rel}:${i + 1}`);
      });
    };

    for (const r of roots) {
      const abs = path.join(ROOT, r);
      if (fs.existsSync(abs)) walk(abs, r);
    }

    // Checked so the walk itself cannot be the thing that is broken: if it scanned nothing, the
    // empty result below would be meaningless.
    assert.ok(fs.existsSync(path.join(ROOT, 'README.md')), 'the walk found no README — it scanned nothing');
    assert.deepEqual(hits, [],
      `these link the internal assessment; state the guidance inline instead:\n  ${hits.join('\n  ')}`);
  });
});

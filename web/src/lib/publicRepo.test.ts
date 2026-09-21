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
//
// It lives in the WEB suite because that is the only suite that runs against the whole tree. The
// app suite runs inside a container with just `app/src` mounted, so the same tests there passed
// while the document sat in `docs/` two directories above anything they could see.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** The repo root, found by PROBING for it rather than by counting `..` segments.
 *
 *  Counting is what made the first version of this file useless: four levels up landed outside the
 *  container's mount, `docs/` did not exist there, and "the document is not in the tree" passed
 *  while the document was in the tree. A guard that cannot find what it guards must FAIL. */
function repoRoot(): string {
	let dir = process.cwd();
	for (let i = 0; i < 8; i++) {
		if (fs.existsSync(path.join(dir, '.gitignore')) && fs.existsSync(path.join(dir, 'docs'))) return dir;
		const up = path.dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	throw new Error(`repo root (a dir with .gitignore and docs/) not found above ${process.cwd()} — this guard cannot run, which is a failure and not a pass`);
}

const ROOT = repoRoot();

// Assembled rather than written out, so this file does not match its own search. The alternative is
// excluding this path from the walk, which then also blinds the walk to a real reference added here
// later. Splitting the needle costs one line and has no such hole.
const DOC = 'PIA-face' + '-matching.md';

describe('the internal privacy assessment stays out of the public repo', () => {
	it('is not in the working tree', () => {
		expect(fs.existsSync(path.join(ROOT, 'docs', DOC)),
			`docs/${DOC} is an internal document and must not be committed — it belongs in ../private/`
		).toBe(false);
	});

	it('is kept out by .gitignore, so `git add -A` cannot sweep it back in', () => {
		// The removal is only durable if the rule is there too. This is the half that actually failed.
		const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
		expect(ignore.split('\n').map((l) => l.trim())).toContain(`/docs/${DOC}`);
	});

	it('is not linked from any shipped source or doc', () => {
		// A link to a file we cannot publish is not guidance, and it is how the document comes back:
		// someone follows the reference, finds it missing, and "fixes" that by committing it.
		const roots = ['app/src', 'web/src', 'shared', 'docs', 'README.md', 'TESTING.md'];
		const skip = new Set(['node_modules', '.svelte-kit', 'build', 'test-results']);
		const hits: string[] = [];

		const walk = (abs: string, rel: string) => {
			if (fs.statSync(abs).isDirectory()) {
				if (skip.has(path.basename(abs))) return;
				for (const e of fs.readdirSync(abs)) walk(path.join(abs, e), `${rel}/${e}`);
				return;
			}
			if (!/\.(ts|js|svelte|sql|md)$/.test(abs)) return;
			fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
				if (line.includes(DOC)) hits.push(`${rel}:${i + 1}`);
			});
		};

		for (const r of roots) {
			const abs = path.join(ROOT, r);
			if (fs.existsSync(abs)) walk(abs, r);
		}

		// Checked so the walk itself cannot be the thing that is broken: if it scanned nothing, the
		// empty result below would be meaningless.
		expect(fs.existsSync(path.join(ROOT, 'README.md'))).toBe(true);
		expect(hits, 'state the guidance inline instead of linking the assessment').toEqual([]);
	});
});

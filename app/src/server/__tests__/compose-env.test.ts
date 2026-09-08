// Every setting the server reads must be passed EXPLICITLY in docker-compose.yml.
//
// Compose does not forward the host environment: a variable in .env that is not listed under the
// service's `environment:` never reaches the container. Nothing warns — the feature is simply,
// silently inert. That has bitten this project at least five times (Turnstile, HOST_REWARD_*,
// LIFECYCLE_EMAILS/OPS_*, GUEST_EMAIL_*, FACE_SELFIE_MIN_SCORE), which is why it is a test and
// not a note in UPGRADING.md.
//
// It covers BOTH services. The app reads process.env directly; the web (SvelteKit) service reads
// $env/dynamic/private, which is the same trap wearing a different hat — and was uncovered here
// until the ad-platform vars (GTAG_ID, MSUET_ID, …) made the gap obvious.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Walk up for the compose file rather than using import.meta.dirname, which this tsconfig's
// module setting rejects. Works from the app dir or the repo root.
function findRoot(): string {
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, 'docker-compose.yml')) && fs.existsSync(path.join(d, 'src', 'server'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  // repo root: the app lives one level down
  const app = path.join(process.cwd(), 'app');
  if (fs.existsSync(path.join(app, 'docker-compose.yml'))) return app;
  throw new Error('could not locate the app directory from ' + process.cwd());
}
const ROOT = findRoot();
const SERVER = path.join(ROOT, 'src', 'server');
// The SvelteKit app is a sibling of the app dir.
const WEB = path.join(path.dirname(ROOT), 'web', 'src');

// Read at boot by the process manager or the runtime itself, not by our code.
const NOT_OURS = new Set(['NODE_ENV', 'PORT', 'npm_package_version', 'TZ']);

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p, exts, out); }
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// The app service: process.env.FOO
const readVars = new Set<string>();
for (const f of walk(SERVER, ['.ts'])) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) readVars.add(m[1]);
}

// The web service: `env.FOO` where env came from $env/dynamic/private. Only files that actually
// import it are scanned, so an unrelated local named `env` can't produce a phantom requirement.
const webVars = new Set<string>();
if (fs.existsSync(WEB)) {
  for (const f of walk(WEB, ['.ts', '.js', '.svelte'])) {
    const text = fs.readFileSync(f, 'utf8');
    if (!/from\s+'\$env\/dynamic\/private'/.test(text)) continue;
    for (const m of text.matchAll(/\benv\.([A-Z0-9_]+)/g)) webVars.add(m[1]);
  }
}

const composeVars = (file: string) => {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return new Set([...text.matchAll(/^\s+-\s+([A-Z0-9_]+)=/gm)].map((m) => m[1]));
};

describe('docker-compose passes every setting the server reads', () => {
  for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
    test(file, () => {
      const passed = composeVars(file);
      const missing = [...readVars].filter((v) => !NOT_OURS.has(v) && !passed.has(v)).sort();
      assert.deepEqual(missing, [],
        `${file} does not pass: ${missing.join(', ')} — add them to the app service's environment: list`);
    });
  }
});

describe('docker-compose passes every setting the WEB service reads', () => {
  test('the scan found the web vars at all (guards against a silently empty check)', () => {
    assert.ok(webVars.size >= 3, `expected several $env/dynamic/private reads, found ${webVars.size}`);
  });
  for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
    test(file, () => {
      const passed = composeVars(file);
      const missing = [...webVars].filter((v) => !NOT_OURS.has(v) && !passed.has(v)).sort();
      assert.deepEqual(missing, [],
        `${file} does not pass: ${missing.join(', ')} — add them to the web service's environment: list`);
    });
  }
});

describe('both ad platforms ship OFF by default', () => {
  for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
    test(file, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      // No tag id ⇒ no third-party script is loaded at all. That promise is in the README, so it
      // is asserted rather than trusted.
      for (const v of ['GTAG_ID', 'MSUET_ID']) {
        assert.match(text, new RegExp(`${v}=\\$\\{${v}:-\\}`),
          `${v} must default to empty in ${file} so a fresh deploy ships zero tracking`);
      }
    });
  }
});

describe('the face-matching kill switch is documented as a switch', () => {
  test('MACHINE_LEARNING_URL defaults to empty in the shipped compose', () => {
    const text = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    assert.match(text, /MACHINE_LEARNING_URL=\$\{MACHINE_LEARNING_URL:-\}/,
      'the shipped default must be empty, so face matching is off unless a self-hoster opts in');
  });
});

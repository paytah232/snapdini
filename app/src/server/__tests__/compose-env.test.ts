// Every setting the server reads must be passed EXPLICITLY in docker-compose.yml.
//
// Compose does not forward the host environment: a variable in .env that is not listed under the
// service's `environment:` never reaches the container. Nothing warns — the feature is simply,
// silently inert. That has bitten this project at least five times (Turnstile, HOST_REWARD_*,
// LIFECYCLE_EMAILS/OPS_*, GUEST_EMAIL_*, FACE_SELFIE_MIN_SCORE), which is why it is a test and
// not a note in UPGRADING.md.
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

// Read at boot by the process manager or the runtime itself, not by our code.
const NOT_OURS = new Set(['NODE_ENV', 'PORT', 'npm_package_version', 'TZ']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p, out); }
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const readVars = new Set<string>();
for (const f of walk(SERVER)) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) readVars.add(m[1]);
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

describe('the face-matching kill switch is documented as a switch', () => {
  test('MACHINE_LEARNING_URL defaults to empty in the shipped compose', () => {
    const text = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    assert.match(text, /MACHINE_LEARNING_URL=\$\{MACHINE_LEARNING_URL:-\}/,
      'the shipped default must be empty, so face matching is off unless a self-hoster opts in');
  });
});

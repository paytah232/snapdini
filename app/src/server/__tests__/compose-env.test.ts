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

// Per SERVICE, not per file. Reading the whole file made this check nearly worthless: a variable
// listed under `web:` satisfied the app's requirement and vice versa, so it only ever proved the
// name appeared SOMEWHERE. That is exactly how ANALYTICS_EXCLUDE_EMAILS — read by the app's
// lifecycle sweep, listed only under web — passed this test while being absent from the container
// that needed it, leaving internal accounts un-excluded from the lifecycle emails in production.
const composeVars = (file: string, service: string) => {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const out = new Set<string>();
  let inService = false;
  for (const line of lines) {
    const svc = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (svc) { inService = svc[1] === service; continue; }
    if (!inService) continue;
    const v = /^\s+-\s+([A-Z0-9_]+)=/.exec(line);
    if (v) out.add(v[1]);
  }
  return out;
};

describe('docker-compose passes every setting the server reads', () => {
  for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
    test(file, () => {
      const passed = composeVars(file, 'app');
      const missing = [...readVars].filter((v) => !NOT_OURS.has(v) && !passed.has(v)).sort();
      assert.deepEqual(missing, [],
        `${file} does not pass to the APP service: ${missing.join(', ')} — a var under another service does not count`);
    });
  }
});

describe('docker-compose passes every setting the WEB service reads', () => {
  test('the scan found the web vars at all (guards against a silently empty check)', () => {
    assert.ok(webVars.size >= 3, `expected several $env/dynamic/private reads, found ${webVars.size}`);
  });
  for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
    test(file, () => {
      const passed = composeVars(file, 'web');
      const missing = [...webVars].filter((v) => !NOT_OURS.has(v) && !passed.has(v)).sort();
      assert.deepEqual(missing, [],
        `${file} does not pass to the WEB service: ${missing.join(', ')} — a var under another service does not count`);
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

describe('every container rotates its logs', () => {
  // The dev compose file had NO logging: block at all, so every dev container was an unrotated
  // json-file log growing until the disk noticed. It matters more there than it sounds: dev is the
  // stack that holds the Mailgun webhook signing key, so /api/webhooks/mailgun is live on it, and
  // that handler logs a line for every POST — from an endpoint that is unauthenticated and
  // unrate-limited. An append-only file fed by a public endpoint needs a cap.
  //
  // Asserted per SERVICE, not per file: a `logging:` block that exists but is attached to three of
  // four services is the same defect wearing a hat.
  for (const file of ['docker-compose.yml', 'docker-compose.dev.yml']) {
    test(file, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.match(text, /max-size:\s*"50m"/, `${file} must cap each log file`);
      assert.match(text, /max-file:\s*"5"/, `${file} must cap how many it keeps`);

      // The services block, sliced out so `default:` under networks: is not counted as a service.
      const start = text.indexOf('\nservices:\n');
      assert.ok(start >= 0, `${file} has no services block`);
      const rest = text.slice(start + '\nservices:\n'.length);
      const end = rest.search(/\n[a-z]/);
      const block = end >= 0 ? rest.slice(0, end) : rest;

      const services = [...block.matchAll(/^  ([a-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
      assert.ok(services.length >= 4, `only found ${services.length} services in ${file}`);
      const rotated = (block.match(/^    logging: \*default-logging$/gm) ?? []).length;
      assert.equal(rotated, services.length,
        `${file}: ${services.length} services (${services.join(', ')}) but ${rotated} rotate their logs`);
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

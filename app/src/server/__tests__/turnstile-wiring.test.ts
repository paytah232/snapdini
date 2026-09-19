// A bot check nobody renders is decorative.
//
// This is the defect this file exists to prevent recurring, and it ran in production for months:
// `index.ts` mounted requireTurnstile on POST /api/auth/register and POST /api/auth/login, the
// verifier was hardened and well tested — and NEITHER page rendered the widget. No token was ever
// produced, so every real registration and every real login was decided by TURNSTILE_FAIL_OPEN,
// which is set on production. A bot simply omitted the field and was waved through with a
// console.warn. Both halves were individually correct and the pair was inert; nothing was red.
//
// So the two halves are asserted AGAINST EACH OTHER, the way shared/guest-reminder.ts is (see
// DEVELOPMENT.md): the guarded actions are read out of the server, the rendered actions are read
// out of the forms, and the two sets must be equal. Adding a guard without a widget fails here, as
// does adding a widget for an action no route checks, as does a rename of either.
//
// Source-level by necessity: exercising it needs a browser, Cloudflare reachable, and a solved
// challenge — none of which a unit test has.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Walk up to the app dir, then hop to its sibling web/ — same approach as compose-env.test.ts,
// which cannot use import.meta.dirname under this tsconfig either.
function findApp(): string {
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, 'src', 'server', 'index.ts'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const app = path.join(process.cwd(), 'app');
  if (fs.existsSync(path.join(app, 'src', 'server', 'index.ts'))) return app;
  throw new Error('could not locate the app directory from ' + process.cwd());
}
const APP = findApp();
const WEB = path.join(path.dirname(APP), 'web', 'src');
const read = (p: string) => fs.readFileSync(p, 'utf8');

/** Every `requireTurnstile('x')` call site anywhere in the server. */
function guardedActions(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'drizzle') walk(f); continue; }
      if (!e.name.endsWith('.ts') || e.name === 'turnstile.ts') continue;
      for (const m of read(f).matchAll(/requireTurnstile\('([a-z-]+)'\)/g)) out.add(m[1]);
    }
  };
  walk(path.join(APP, 'src', 'server'));
  return out;
}

/** Every `<Turnstile … action="x" …>` tag in the web app, with the file it lives in. */
function renderedWidgets(): { file: string; tag: string; action: string }[] {
  const out: { file: string; tag: string; action: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.name.endsWith('.svelte') || e.name === 'Turnstile.svelte') continue;
      const src = read(f);
      for (const m of src.matchAll(/<Turnstile\b[^>]*>/g)) {
        const action = /action="([a-z-]+)"/.exec(m[0])?.[1] ?? '';
        out.push({ file: path.relative(WEB, f), tag: m[0], action });
      }
    }
  };
  walk(WEB);
  return out;
}

const GUARDED = guardedActions();
const WIDGETS = renderedWidgets();

describe('the bot check is actually rendered where it is enforced', () => {
  test('the guard is still mounted on register and login', () => {
    // If this fails the enforcement was removed, and every assertion below would pass vacuously.
    const index = read(path.join(APP, 'src', 'server', 'index.ts'));
    assert.match(index, /app\.use\('\/api\/auth\/register', onPost\(requireTurnstile\('register'\)\)\)/);
    assert.match(index, /app\.use\('\/api\/auth\/login', onPost\(requireTurnstile\('login'\)\)\)/);
    for (const a of ['register', 'login', 'contact']) assert.ok(GUARDED.has(a), `${a} is no longer guarded`);
  });

  test('every guarded action has a form that renders the widget for it', () => {
    const rendered = new Set(WIDGETS.map((w) => w.action));
    for (const action of GUARDED) {
      assert.ok(rendered.has(action),
        `requireTurnstile('${action}') is enforced but no form renders a widget with action="${action}" — `
        + 'the check cannot ever be satisfied, so it protects nobody');
    }
  });

  test('no form mints a token for an action nothing checks', () => {
    for (const w of WIDGETS) {
      assert.ok(w.action, `${w.file}: <Turnstile> with no action — a token minted here is replayable elsewhere`);
      assert.ok(GUARDED.has(w.action), `${w.file}: action="${w.action}" matches no requireTurnstile() on the server`);
    }
  });

  test('the sign-up and sign-in pages each render exactly one, with the server’s own action', () => {
    for (const [file, action] of [['routes/signup/+page.svelte', 'register'], ['routes/login/+page.svelte', 'login']]) {
      const here = WIDGETS.filter((w) => w.file === file);
      assert.equal(here.length, 1, `${file} should render one widget, found ${here.length}`);
      assert.equal(here[0].action, action);
      // Two-way binding: the token must reach the submit, and the page must be able to reset it.
      assert.match(here[0].tag, /bind:token=\{/, `${file}: no bind:token — the token is minted and dropped`);
      assert.match(here[0].tag, /bind:this=\{/, `${file}: no bind:this — nothing can reset the widget`);
    }
  });

  test('every form holding a widget posts the token and resets it afterwards', () => {
    for (const file of new Set(WIDGETS.map((w) => w.file))) {
      const src = read(path.join(WEB, file));
      assert.match(src, /'cf-turnstile-response'/,
        `${file}: renders a widget but never sends cf-turnstile-response — the server sees no token`);
      // Tokens are single-use. A form that can be submitted twice (a refused login, a retried
      // message) must reset, or the SECOND attempt fails for a reason that has nothing to do with
      // what the person typed.
      assert.match(src, /[Tt]urnstile\??\.reset\(\)/, `${file}: never resets — a retry fails on a stale token`);
    }
  });
});

// The reserved height is a CSS rule, and vitest does not apply a component's scoped styles, so it
// is asserted where it is written. The trap is specific: hanging min-height off the bare
// `.turnstile` class would reserve 65px in the sign-up form of every SELF-HOSTED stack too, where
// the component is meant to be completely absent — a mystery gap with nothing in it.
describe('the widget reserves space for itself, but only where it exists', () => {
  const styles = (() => {
    const src = read(path.join(WEB, 'lib', 'components', 'Turnstile.svelte'));
    return src.slice(src.indexOf('<style>'));
  })();

  test('height is reserved on .live only, never on the bare class', () => {
    assert.match(styles, /\.turnstile\.live\s*\{[^}]*min-height:/);
    assert.doesNotMatch(styles, /\.turnstile\s*\{[^}]*min-height:/);
    assert.doesNotMatch(styles, /\.turnstile\s*\{[^}]*margin:/);
  });

  test('the narrow-screen scale skips the notice, which would only shrink the words', () => {
    assert.match(styles, /\.turnstile\.live:not\(\.blocked\)\s*\{[^}]*transform: scale/);
  });
});

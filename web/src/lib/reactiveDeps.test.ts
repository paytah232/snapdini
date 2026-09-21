/** @vitest-environment node */
// esbuild (inside vitePreprocess) needs a real Node realm: under jsdom its TextEncoder returns a
// Uint8Array from another realm and esbuild refuses to start. Nothing here touches the DOM.
/// <reference types="vite/client" />
// Do the reactive statements actually depend on what they say they depend on?
//
// Every other poster suite reads the component's source as text. That is the right tool for most
// of what they assert — but it cannot see this class of bug at all, because the bug happens BETWEEN
// the source and Svelte. `svelte.config.js` preprocesses with `vitePreprocess()`, which used to
// strip TypeScript using esbuild, and esbuild deletes expression statements it can prove have no
// effect. `void x` on a plain `let` binding is exactly that, so a dozen hand-written dependency
// declarations were removed before Svelte ever parsed the file. Two whole reactive statements were
// left with no dependencies at all and got hoisted out of the update function: they ran once at
// init and never again. The source said one thing and the build did another, and 427 source-text
// assertions agreed with the source.
//
// That particular hole has since closed twice over — vitePreprocess() no longer preprocesses
// <script> at all (Svelte 5 strips its own types) and the current esbuild keeps the reference
// anyway — but the gap it lived in has not. Everything a `$:` statement re-runs on is still
// decided after the source is read, by a compiler, out of what it can see syntactically.
//
// So this suite runs the project's OWN preprocessor, compiles the result, and reads the dependency
// list out of the thunk Svelte emitted — the thing that actually decides whether a statement
// re-runs. See $lib/reactive for the idiom and why it is a call.
import { describe, it, expect } from 'vitest';
import { preprocess, compile } from 'svelte/compiler';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** Every component, as source text. Also the corpus for the recurrence guard at the bottom. */
const RAW = import.meta.glob('/src/**/*.svelte', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

/** Compile through the real pipeline: vitePreprocess() first, exactly as a build would. */
const built = new Map<string, string>();
async function compiled(file: string): Promise<string> {
  const hit = built.get(file);
  if (hit) return hit;
  const src = RAW[file];
  if (!src) throw new Error(`no such component: ${file}`);
  const pp = await preprocess(src, vitePreprocess(), { filename: file });
  const js = compile(pp.code, { filename: file, generate: 'client', dev: false }).js.code;
  built.set(file, js);
  return js;
}

/** One `$:` statement, as Svelte 5 emitted it.
 *
 *  Svelte 4 put every reactive statement inside `$$self.$$.update`, each behind a bitmask whose
 *  source names it wrote into a comment — and HOISTED the ones it found no dependencies for, so
 *  they ran once at init and never again. Svelte 5 emits one call per statement instead:
 *
 *      $.legacy_pre_effect(() => ($.get(bounds), $.get(decorRects)), () => { …the statement… });
 *
 *  The first thunk IS the dependency list, by name, and `() => {}` says exactly what a missing
 *  bitmask used to say: this statement has no dependencies and will never re-run. Same question,
 *  same answer, read out of the thing that actually decides it. */
type Effect = { deps: string[]; body: string };

/** Split `$.legacy_pre_effect(deps, body)` into its two halves.
 *
 *  Only the FIRST argument is parsed by counting brackets, and that argument can hold nothing but
 *  identifiers, `$.get(x)`, `x()` and commas — no strings, no comments, nothing that could fool a
 *  bracket count. The second is handed back as text, which is all the caller searches. */
function splitEffect(block: string): Effect {
  let i = block.indexOf('=>') + 2;
  while (/\s/.test(block[i])) i += 1;
  // `() => {}` — Svelte found nothing for this statement to depend on.
  if (block[i] === '{') return { deps: [], body: block.slice(block.indexOf('}', i) + 1) };

  let depth = 0;
  let close = i;
  for (; close < block.length; close += 1) {
    if (block[close] === '(') depth += 1;
    else if (block[close] === ')' && (depth -= 1) === 0) break;
  }

  const terms: string[] = [];
  let d = 0;
  let start = i + 1;
  for (let k = i + 1; k < close; k += 1) {
    if (block[k] === '(') d += 1;
    else if (block[k] === ')') d -= 1;
    else if (block[k] === ',' && d === 0) { terms.push(block.slice(start, k)); start = k + 1; }
  }
  terms.push(block.slice(start, close));

  const deps = new Set<string>();
  for (const t of terms) {
    // `$.get(zoom)` for a `let`, `aspectW()` for a prop, `$.deep_read_state(theme())` for one
    // read through its own shape, a bare name for anything hoisted.
    const stripped = t.trim().replace(/^(?:\$\.\w+\()+/, '');
    const m = /^[A-Za-z_$][\w$]*/.exec(stripped);
    if (m) {
      // A BLIND SPOT, MADE LOUD. The strip above only removes `$.`-prefixed wrappers, so a read
      // reaching a dependency through any other call — `helper(x)` — would extract `helper` and
      // never see `x`. That is the worst shape an extractor can fail in: it records a dependency
      // that does not exist and misses one that does, and every assertion downstream goes on
      // agreeing with itself.
      //
      // Nothing compiles to that shape today, which is exactly why it needs a guard rather than a
      // fix: there is no failing case to write a fix against, and guessing at one risks the 22
      // dependency lists below, whose values are verified byte-for-byte against the Svelte 4
      // output. So this throws the first time it ever happens, naming what to do.
      //
      // Empty parentheses are not that: `aspectW()` is how a prop reads and `aspectW` IS the
      // dependency. Arguments are the tell.
      const after = stripped.slice(m[0].length).trim();
      if (/^\(\s*[^)\s]/.test(after)) {
        throw new Error(
          `reactiveDeps: a dependency is being read through ${m[0]}(…), and this extractor only ` +
          `unwraps $.-prefixed calls — it would record "${m[0]}" and miss the real dependency ` +
          `inside. Extend the unwrapping before trusting any list in this file. Term: ${t.trim()}`
        );
      }
      deps.add(m[0]);
    }
  }
  return { deps: [...deps], body: block.slice(close + 1) };
}

/** Every reactive statement in a compiled component. Svelte pretty-prints one statement per line
 *  at the component's own indent, so the call ends at the first `);` or `});` sitting at one tab. */
function preEffects(js: string): Effect[] {
  const CALL = '$.legacy_pre_effect(';
  const out: Effect[] = [];
  for (let i = js.indexOf(CALL); i !== -1; i = js.indexOf(CALL, i + 1)) {
    const ends = ['\n\t});', '\n\t);'].map((t) => js.indexOf(t, i)).filter((n) => n !== -1);
    out.push(splitEffect(js.slice(i + CALL.length, ends.length ? Math.min(...ends) : js.length)));
  }
  return out;
}

type Found = { deps: string[]; guard: string };

/** The dependency list of the statement that contains `snippet`, as the names Svelte wrote into
 *  the thunk it re-checks on every change. */
function maskFor(js: string, snippet: string): Found | null {
  const hits = preEffects(js).filter((e) => e.body.includes(snippet));
  if (hits.length > 1) throw new Error(`snippet is not unique: ${snippet}`);
  if (hits.length === 0) return null;
  const [hit] = hits;
  if (hit.body.indexOf(snippet) !== hit.body.lastIndexOf(snippet)) {
    throw new Error(`snippet is not unique: ${snippet}`);
  }
  // No dependencies is the Svelte 5 spelling of "hoisted out of $$self.$$.update": it runs at
  // init and never again. Null, exactly as it was when there was no dirty mask to find.
  if (hit.deps.length === 0) return null;
  return { deps: hit.deps, guard: `() => (${hit.deps.join(', ')})` };
}

/** One reactive statement, located by a fragment of its own compiled body. */
type Case = { what: string; find: string; deps: string[] };

const PM = '/src/lib/components/PosterModal.svelte';
const EIE = '/src/lib/components/EventImageEditor.svelte';
const SITEADMIN = '/src/routes/siteadmin/+page.svelte';
const ADMIN = '/src/routes/admin/[code]/+page.svelte';

const CASES: Record<string, Case[]> = {
  [PM]: [
    // Lost `bounds`: after dragging a fixture the control cluster and the inline editor anchored to
    // where it used to be, and stayed there. Dragging a motif or a host's line was fine, because
    // decorRects/textRects are `$:`-declared and survived — which is why it read as intermittent.
    { what: 'allRects', find: 'posterRects()', deps: ['bounds', 'decorRects', 'textRects'] },
    // Lost all three inputs: themeDefaults() applied once at init, so a cream paper never moved the
    // body ink to dark. readableOn() kept text legible at draw time, so only the swatches and the
    // saved cfg were wrong — silently, and in production.
    { what: 'theme default colours', find: 'themeDefaults()',
      deps: ['bgMode', 'cBg', 'theme', 'colorsLocked'] },
    // Lost its only dependency, so the whole statement was hoisted: the reset confirm never
    // disarmed when the tab changed under it.
    { what: 'reset confirm disarms', find: '$.set(resetArmed, false)', deps: ['view'] },
    // Same: the bin confirm stayed armed across a change of selection or of tab.
    { what: 'bin confirm disarms', find: '$.set(binArmed, null)',
      deps: ['selectedKey', 'cardSelectedKey', 'view'] },
    // Lost `customBgUrl`: cropping a SECOND custom background while bgMode was already 'custom'
    // changed nothing in cfg, so the preview kept the old photo — and an export at that moment
    // shipped it. Also in production.
    { what: 'redraw + persist', find: 'persist()', deps: ['cfg', 'customBgUrl', 'mounted'] },
    // Lost `textItems`: with the inline editor open, undo reverted the canvas but not the textarea,
    // and the next keystroke wrote the stale string back over it.
    { what: 'inline editor spec', find: 'editSpecOf($.get(editingKey))', deps: ['textItems', 'editingKey'] },
    // `cleanUrl` is a genuine source-level gap, not a build one: footerBounds() measures the printed
    // URL and loadPosterQr() swaps the canonical one in after mount.
    { what: 'poster bounds', find: 'measureBounds()',
      deps: ['cleanUrl', 'fontsReady', 'layout', 'headline', 'message', 'stepsText', 'codeDisplay',
             'showFooterUrl', 'names', 'qrPanel', 'typeSetKey', 'mounted'] },
    // Lost `fontsReady` — the exact failure the comment beside it was written to prevent: a saved
    // design's host-added lines kept Arial-measured drag rects until the next edit.
    { what: 'host line rects', find: 'measureCtx()', deps: ['fontsReady', 'textItems', 'typeSetKey'] },
    { what: 'selected element cluster', find: 'binActionFor(k), !!editSpecOf(k), rot)',
      deps: ['allRects', 'textItems', 'decorItems', 'elements', 'layout', 'selectedKey'] },
    { what: 'card element cluster', find: 'cardBinActionFor(k), false)',
      deps: ['cardRects', 'cardElements', 'cardGeomBox', 'cardSelectedKey'] },
    // fontsReady here is the card's twin of the poster gap above.
    { what: 'card measure signature', find: '$.set(cardMeasure, JSON.stringify([',
      deps: ['cardOpts', 'cardSheet', 'activeSheet', 'mounted', 'fontsReady'] },
    { what: 'card geometry box', find: 'cardBoxAt(0, 0, $.get(cardSheet))', deps: ['cardMeasure'] },
    { what: 'card bounds', find: 'measureCardBounds())', deps: ['cardMeasure'] },
    { what: 'card drag rects', find: 'cardSurface.rects()', deps: ['cardBounds', 'cardGeomBox'] },
    // Anchored on the row's KEY, not its label: "Trick list" is also the name of the list element
    // on the card stage, and an anchor that matches two statements cannot say which one it checked.
    { what: 'card colour rows', find: `key: 'cardBody'`, deps: ['cardDesign'] }
  ],
  [EIE]: [
    // Lost `zoom`, so the crop never re-clamped as it was zoomed.
    { what: 're-clamp on zoom', find: 'clamp()', deps: ['zoom', 'loaded'] }
  ],
  [SITEADMIN]: [
    { what: 'events back to page 1', find: '$.set(evPage, 1)', deps: ['evQuery', 'evShowInactive'] },
    { what: 'messages back to page 1', find: '$.set(msgPage, 1)', deps: ['msgQuery', 'msgShowDone'] },
    { what: 'errors back to page 1', find: '$.set(errPage, 1)', deps: ['errQuery', 'errShowDone'] }
  ],
  [ADMIN]: [
    { what: 'a new search starts from the top', find: '$.set(partLimit, PART_PAGE)', deps: ['partQuery'] }
  ]
};

describe('reactive dependencies survive the build', () => {
  for (const [file, cases] of Object.entries(CASES)) {
    describe(file.replace('/src/', ''), () => {
      for (const c of cases) {
        it(`${c.what} depends on ${c.deps.join(', ')}`, async () => {
          const found = maskFor(await compiled(file), c.find);
          // null means the statement is not under a dirty mask at all: Svelte found it had no
          // dependencies and hoisted it, so it runs once at init and never again.
          expect(found, `"${c.what}" has no dependencies in its $.legacy_pre_effect thunk — it ` +
            'runs once at init and never again. Every dependency it named was thrown away before ' +
            'Svelte saw the file.').not.toBeNull();
          for (const d of c.deps) {
            expect(found!.deps, `"${c.what}" does not re-run when ${d} changes. ` +
              `Svelte's dependency thunk says: ${found!.deps.join(', ')}`).toContain(d);
          }
        });
      }
    });
  }
});

describe('the dependency idiom itself', () => {
  const wrap = (body: string) => `<script lang="ts">\n${body}\n</script>\n<p>{out}</p>\n`;
  const pp = async (body: string) =>
    (await preprocess(wrap(body), vitePreprocess(), { filename: 'Probe.svelte' })).code;

  it('carries `void x` on a plain binding all the way into the dependency thunk', async () => {
    // Not a hypothetical, and the reason this suite exists: `vitePreprocess()` used to run the
    // script through esbuild, and esbuild deletes expression statements it can prove have no
    // effect. `void x` on a plain `let` is exactly that, so a dozen hand-written dependency
    // declarations were erased before Svelte ever parsed PosterModal — two reactive statements
    // were left with none at all and ran once at init.
    //
    // Both halves of that have since gone: vitePreprocess() no longer touches <script> (Svelte 5
    // strips its own types), and the current esbuild keeps the reference even when it is asked
    // to. So what is pinned is the property the erasure broke, end to end — a reference written
    // in the source reaches the thunk Svelte re-checks — rather than the erasure itself, which
    // no longer happens and can no longer be observed.
    const src = '<script lang="ts">\n  let a: number = 1;\n  let out = 0;\n  $: out = (void a, 2);\n' +
      '</script>\n<p>{out}</p><button on:click={() => (a += 1)}>bump</button>\n';
    const code = (await preprocess(src, vitePreprocess(), { filename: 'Probe.svelte' })).code;
    expect(code).toMatch(/void a\b/);        // the preprocessor left the reference alone
    const js = compile(code, { filename: 'Probe.svelte', generate: 'client', dev: false }).js.code;
    const [effect] = preEffects(js);
    expect(effect.deps, 'the declared dependency did not survive the build').toContain('a');
  });

  it('keeps dep(x), because esbuild cannot prove a call is pure', async () => {
    const code = await pp("  import { dep } from '$lib/reactive';\n  let a = 1;\n  let out = 0;\n" +
      '  $: out = (dep(a), 2);\n  $: { dep(a); out = 3; }');
    expect([...code.matchAll(/dep\(a\)/g)]).toHaveLength(2);
  });

  it('is the only idiom in use — no component declares a dependency with `void x`', () => {
    // `void someCall()` is a deliberate discard of a promise and is left alone; this matches only a
    // bare identifier reference, which is never anything but a dependency declaration.
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(RAW)) {
      for (const m of src.matchAll(/\bvoid\s+([A-Za-z_$][\w$]*)\s*[;,)]/g)) {
        offenders.push(`${file}: void ${m[1]}`);
      }
    }
    expect(offenders, 'esbuild deletes these before Svelte parses the file; use dep() from ' +
      '$lib/reactive instead').toEqual([]);
  });
});

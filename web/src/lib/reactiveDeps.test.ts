/** @vitest-environment node */
// esbuild (inside vitePreprocess) needs a real Node realm: under jsdom its TextEncoder returns a
// Uint8Array from another realm and esbuild refuses to start. Nothing here touches the DOM.
/// <reference types="vite/client" />
// Do the reactive statements actually depend on what they say they depend on?
//
// Every other poster suite reads the component's source as text. That is the right tool for most
// of what they assert — but it cannot see this class of bug at all, because the bug happens BETWEEN
// the source and Svelte. `svelte.config.js` preprocesses with `vitePreprocess()`, which strips
// TypeScript using esbuild, and esbuild deletes expression statements it can prove have no effect.
// `void x` on a plain `let` binding is exactly that, so a dozen hand-written dependency
// declarations were removed before Svelte ever parsed the file. Two whole reactive statements were
// left with no dependencies at all and got hoisted out of the update function: they ran once at
// init and never again. The source said one thing and the build did another, and 427 source-text
// assertions agreed with the source.
//
// So this suite runs the project's OWN preprocessor, compiles the result, and reads the dependency
// list out of the dirty mask Svelte emitted — the thing that actually decides whether a statement
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
  const js = compile(pp.code, { filename: file, generate: 'dom', dev: false }).js.code;
  built.set(file, js);
  return js;
}

/** The body of `$$self.$$.update`. Statements Svelte hoisted (no dependencies) are NOT in here —
 *  they sit after it, and run exactly once. The arrow closes at one tab; its contents are deeper. */
function updateBody(js: string): string {
  const i = js.indexOf('$$self.$$.update = () => {');
  if (i < 0) return '';
  const end = js.indexOf('\n\t};', i);
  return js.slice(i, end < 0 ? js.length : end);
}

type Found = { deps: string[]; guard: string };

/** The dirty mask guarding the statement that contains `snippet`, as the names Svelte wrote into
 *  it: `if ($$self.$$.dirty[0] & /*bounds, decorRects* / 3)`. */
function maskFor(js: string, snippet: string): Found | null {
  const body = updateBody(js);
  const at = body.indexOf(snippet);
  if (at < 0) return null;
  if (body.indexOf(snippet, at + 1) !== -1) throw new Error(`snippet is not unique: ${snippet}`);
  const g = body.lastIndexOf('if ($$self.$$.dirty', at);
  if (g < 0) return null;
  const guard = body.slice(g, body.indexOf(') {', g));
  const deps = new Set<string>();
  for (const m of guard.matchAll(/\/\*([^*]+)\*\//g)) for (const d of m[1].split(',')) deps.add(d.trim());
  return { deps: [...deps], guard };
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
    { what: 'allRects', find: 'posterRects())', deps: ['bounds', 'decorRects', 'textRects'] },
    // Lost all three inputs: themeDefaults() applied once at init, so a cream paper never moved the
    // body ink to dark. readableOn() kept text legible at draw time, so only the swatches and the
    // saved cfg were wrong — silently, and in production.
    { what: 'theme default colours', find: 'cSteps, cCode, cFooter } = themeDefaults',
      deps: ['bgMode', 'cBg', 'theme', 'colorsLocked'] },
    // Lost its only dependency, so the whole statement was hoisted: the reset confirm never
    // disarmed when the tab changed under it.
    { what: 'reset confirm disarms', find: 'resetArmed = false)', deps: ['view'] },
    // Same: the bin confirm stayed armed across a change of selection or of tab.
    { what: 'bin confirm disarms', find: 'binArmed = null)',
      deps: ['selectedKey', 'cardSelectedKey', 'view'] },
    // Lost `customBgUrl`: cropping a SECOND custom background while bgMode was already 'custom'
    // changed nothing in cfg, so the preview kept the old photo — and an export at that moment
    // shipped it. Also in production.
    { what: 'redraw + persist', find: 'persist()', deps: ['cfg', 'customBgUrl', 'mounted'] },
    // Lost `textItems`: with the inline editor open, undo reverted the canvas but not the textarea,
    // and the next keystroke wrote the stale string back over it.
    { what: 'inline editor spec', find: 'editSpecOf(editingKey)', deps: ['textItems', 'editingKey'] },
    // `cleanUrl` is a genuine source-level gap, not a build one: footerBounds() measures the printed
    // URL and loadPosterQr() swaps the canonical one in after mount.
    { what: 'poster bounds', find: 'measureBounds())',
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
    { what: 'card measure signature', find: 'JSON.stringify([cardOpts',
      deps: ['cardOpts', 'cardSheet', 'activeSheet', 'mounted', 'fontsReady'] },
    { what: 'card geometry box', find: 'cardBoxAt(0, 0, cardSheet))', deps: ['cardMeasure'] },
    { what: 'card bounds', find: 'measureCardBounds())', deps: ['cardMeasure'] },
    { what: 'card drag rects', find: 'cardSurface.rects()', deps: ['cardBounds', 'cardGeomBox'] },
    // Anchored on the row's KEY, not its label: "Trick list" is also the name of the list element
    // on the card stage, and an anchor that matches two statements cannot say which one it checked.
    { what: 'card colour rows', find: 'key: "cardBody"', deps: ['cardDesign'] }
  ],
  [EIE]: [
    // Lost `zoom`, so the crop never re-clamped as it was zoomed.
    { what: 're-clamp on zoom', find: 'clamp()', deps: ['zoom', 'loaded'] }
  ],
  [SITEADMIN]: [
    { what: 'events back to page 1', find: 'evPage = 1)', deps: ['evQuery', 'evShowInactive'] },
    { what: 'messages back to page 1', find: 'msgPage = 1)', deps: ['msgQuery', 'msgShowDone'] },
    { what: 'errors back to page 1', find: 'errPage = 1)', deps: ['errQuery', 'errShowDone'] }
  ],
  [ADMIN]: [
    { what: 'a new search starts from the top', find: 'partLimit = PART_PAGE)', deps: ['partQuery'] }
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
          expect(found, `"${c.what}" is not in $$self.$$.update — it runs once at init and never ` +
            'again. Every dependency it named was thrown away before Svelte saw the file.').not.toBeNull();
          for (const d of c.deps) {
            expect(found!.deps, `"${c.what}" does not re-run when ${d} changes. ` +
              `Svelte's dirty mask says: ${found!.deps.join(', ')}`).toContain(d);
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

  it('drops `void x` on a plain binding — which is why this suite exists', async () => {
    // Not a hypothetical. This is the transform that erased a dozen declarations in PosterModal.
    const code = await pp('  let a = 1;\n  let out = 0;\n  $: out = (void a, 2);\n  $: { void a; out = 3; }');
    expect(code).toContain('void 0');       // the reference is gone; only the discard is left
    expect(code).not.toMatch(/void a\b/);
    expect(code).not.toMatch(/\bvoid a;/);  // the whole statement went with it
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

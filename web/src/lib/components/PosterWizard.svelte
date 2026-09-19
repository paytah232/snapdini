<script lang="ts">
  // The starting point for a poster — a gallery of finished designs to pick from, or a blank canvas.
  //
  // NOT a step-through. The product owner was explicit about the difference: presets "rendered on a
  // card list for them, and they can select from there to further customise the template they like,
  // or, they get the option to do it from scratch". A linear walkthrough taxes the host who already
  // knows what they want; a gallery rescues the one staring at a blank canvas and costs the other
  // one tap. So "Start from scratch" is a visible choice on the same screen, never a skip link
  // hidden at the bottom.
  //
  // THE THUMBNAILS ARE REAL. Each tile is drawn by drawPoster() — the exact function the designer
  // uses — with the event's own name, message and QR, scaled down by a ctx transform. That is why
  // the renderer was pulled out of PosterModal into $lib/posterRender first: a gallery that mocked
  // up approximations would be showing the host something they are not going to get, and they are
  // choosing based on it.
  import { onMount, createEventDispatcher } from 'svelte';
  import { modalFocus } from '$lib/ui';
  import { presetsForEventType, presetForEventType, type PosterPreset } from '$lib/posterPresets';
  import { drawPoster, DEFAULT_POSTER_LAYOUT, PAGE_W, PAGE_H, type PosterInk } from '$lib/posterRender';
  import { shouldDismissBackdrop } from '$lib/posterFlow';

  export let eventName: string;
  export let blurb = '';
  export let joinUrl: string;
  export let joinCode: string;
  export let qrDataUrl: string;
  /** True when a design already exists — the wording changes from "start" to "replace", because
   *  picking a preset overwrites work the host has already done and should say so. */
  export let hasDesign = false;
  /** What kind of event this is — the same value the mission packs and card decorations already key
   *  off. Used ONLY to order the gallery and mark one tile, never to skip it or pre-pick for the
   *  host: the point of a gallery is that they choose. */
  export let eventType: string | null = null;

  // Resolved once, not per render. The tile canvases are bound by INDEX, so a list that reorders
  // underneath them would paint each design onto its neighbour's tile.
  const presets = presetsForEventType(eventType);
  const suggested = presetForEventType(eventType)?.key ?? null;

  const dispatch = createEventDispatcher<{ pick: PosterPreset; scratch: void; close: void }>();

  // The attribute size is only a starting shape — the real backing store is worked out per tile in
  // paint(), from the width the tile ACTUALLY occupies times the device pixel ratio.
  //
  // It used to be a flat 270px upscaled by CSS, which is fine on a desktop where a tile is about
  // 270px wide and the ratio is 1. On a phone the gallery is one column, so a tile is ~340 CSS px
  // on a 3× screen — a 270px image stretched across roughly 1000 device pixels. The designs it is
  // asking someone to choose between differ in their TYPE, which is the first thing to turn to mush.
  const TILE_W = 270;
  const TILE_H = Math.round((TILE_W / PAGE_W) * PAGE_H);

  const cleanUrl = joinUrl.replace(/^https?:\/\//, '');

  let tiles: HTMLCanvasElement[] = [];
  let failed = false;

  async function paint() {
    // Capped at 3: past that the file grows faster than anyone can see the difference. Capped at the
    // page itself too — 1080px IS the poster, and asking for more would be upscaling our own source.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (let i = 0; i < presets.length; i++) {
      const el = tiles[i];
      const p = presets[i];
      if (!el) continue;
      const ctx = el.getContext('2d');
      if (!ctx) continue;
      const c = p.cfg as Record<string, string>;
      const ink: PosterInk = {
        headline: c.cHeadline, message: c.cMessage, steps: c.cSteps,
        footer: c.cFooter, code: c.cCode,
      };
      // clientWidth, not the attribute: the CSS (`width: 100%`) is what decides how big this tile
      // really is, and that changes with the column count and the screen.
      const rw = Math.min(PAGE_W, Math.round((el.clientWidth || TILE_W) * dpr));
      const scale = rw / PAGE_W;
      el.width = rw; el.height = Math.round((rw / PAGE_W) * PAGE_H);
      ctx.save();
      ctx.scale(scale, scale);
      try {
        await drawPoster(ctx, {
          // The host's OWN words, not lorem — the whole point of the tile is to show them their
          // poster in that style, and a long event name behaves very differently from a short one.
          headline: eventName || 'Our Event',
          message: blurb,
          stepsText: '①  Scan to join     ②  Snap your roll     ③  Revealed when it ends',
          cleanUrl, joinCode,
          codeDisplay: 'url', showFooterUrl: true,
          layout: DEFAULT_POSTER_LAYOUT,
          ink,
          // The preset's typography, or the tile lies about the biggest thing the preset changes.
          typeSet: c.typeSetKey as never, titleFace: c.titleFace as never,
          decorKind: c.decorKind as never, decorPos: c.decorPos as never,
          decorScale: Number(c.decorScale) || 1, decorColour: c.decorColour,
          qrSrc: qrDataUrl,
          bgSrc: null,
          plainBg: c.cBg,
        });
      } catch {
        // One tile failing must not take the gallery with it — the host can still pick another, or
        // start from scratch, which needs no rendering at all.
        failed = true;
      }
      ctx.restore();
    }
  }

  onMount(paint);

  // Escape closes it, and so does the backdrop. Neither did before, which on a phone made this a
  // room with no door: eight tiles stack to one column well over 3000px tall, the only ✕ lives INSIDE that
  // scroll, and by the time you reach "Start from scratch" the close button is nearly 2000px above
  // the viewport. ui.ts's own note says to pair modalFocus with Escape-to-close; this never did.
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') dispatch('close'); }

  // The same rule the designer's backdrop runs on, for the same reason: `|self` alone passes for a
  // gesture that merely ENDED out here. Drag a tile and release past the grid — or drag-select the
  // blurb text under one — and the click's target is the backdrop, so the gallery closed on a
  // gesture that never asked it to.
  let downOnBack = false;
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="back" role="dialog" aria-modal="true" aria-label="Choose a poster design" use:modalFocus
     on:pointerdown={(e) => (downOnBack = e.target === e.currentTarget)}
     on:click={(e) => { if (shouldDismissBackdrop({ downOnBackdrop: downOnBack, clickOnBackdrop: e.target === e.currentTarget })) dispatch('close'); }}>
  <div class="sheet">
    <div class="head sticky">
      <div>
        <h2>{hasDesign ? 'Start again from a design' : 'Pick a starting point'}</h2>
        <p class="sub">
          <!-- Says that it themes the APP too, because it does. A host who finds that out
               afterwards experiences it as the event repainting itself. -->
          {#if hasDesign}
            Choosing one replaces your current design and your event's colours. Everything stays
            editable afterwards.
          {:else}
            Each one styles your poster, your trick cards <em>and</em> the app your guests see — all
            editable afterwards. They just save you the blank page.
          {/if}
        </p>
      </div>
      <button class="x" on:click={() => dispatch('close')} aria-label="Close">✕</button>
    </div>

    {#if failed}
      <p class="warn">Some previews couldn't be drawn. The designs themselves are fine — pick one and it will open properly.</p>
    {/if}

    <div class="grid">
      {#each presets as p, i (p.key)}
        <button class="tile" class:suggested={p.key === suggested} on:click={() => dispatch('pick', p)}>
          <canvas bind:this={tiles[i]} width={TILE_W} height={TILE_H} aria-hidden="true"></canvas>
          <span class="t-name">{p.label}{#if p.key === suggested}<span class="t-sugg">suggested</span>{/if}</span>
          <span class="t-blurb">{p.blurb}</span>
        </button>
      {/each}

      <!-- A tile of its own, in the same grid, at the same size. Made to look like one of the
           choices because it IS one — the owner asked for it as a visible option, not an escape
           hatch in small print under the gallery. -->
      <button class="tile scratch" on:click={() => dispatch('scratch')}>
        <span class="s-mark" aria-hidden="true">✎</span>
        <span class="t-name">Start from scratch</span>
        <span class="t-blurb">A blank poster with your event's colours.</span>
      </button>
    </div>
  </div>
</div>

<style>
  .back {
    position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
  }
  .sheet {
    width: 100%; max-width: 960px; max-height: 92dvh; overflow-y: auto;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 18px;
  }
  /* Pinned, because the sheet scrolls and the close control must not leave with it. */
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .head.sticky {
    position: sticky; top: -18px; z-index: 1;
    /* Cancels the sheet's own padding so the bar spans edge to edge as it sticks, and paints an
       opaque ground — tiles scrolling visibly under half-transparent text is worse than no bar. */
    margin: -18px -18px 14px; padding: 18px;
    background: var(--surface); border-bottom: 1px solid var(--border);
  }
  /* Accent, not body text. This heading sits directly above a wall of poster thumbnails, each a
     full-bleed design of its own, and in plain ink it simply lost — the eye went to the posters and
     the one line telling you what to do with them never got read. --accent and not --accent-fill
     because this is TEXT: the fill is the brand yellow for sitting behind something, while --accent
     is the same yellow pulled down far enough to stay legible as strokes on a light surface. It
     follows the event's theme too, so the heading is the host's own colour. */
  .head h2 { margin: 0; font-size: 1.1rem; color: var(--accent); }
  .sub { margin: 4px 0 0; color: var(--text-muted); font-size: 0.82rem; line-height: 1.45; max-width: 56ch; }
  /* 44px, the HIG minimum. It was 25x28 — a close control is the one button that must never be
     fiddly, because it is what someone reaches for when they are already lost. */
  .x { border: 0; background: none; color: var(--text-muted); font-size: 1.1rem; cursor: pointer;
       flex: none; width: 44px; height: 44px; margin: -8px -8px 0 0; border-radius: var(--radius-sm); }
  .x:hover { color: var(--text); }
  .warn { margin: 0 0 12px; font-size: 0.8rem; color: var(--danger); }

  /* auto-fill rather than a fixed count: the same rule gives one column on a phone and four on a
     laptop without a breakpoint per size. */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 14px; }

  .tile {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 10px; cursor: pointer; text-align: center;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text); font: inherit;
  }
  .tile:hover { border-color: var(--accent); }
  .tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tile canvas {
    width: 100%; height: auto; display: block; border-radius: 4px;
    /* The poster's own paper provides the colour; this only stops a white design vanishing into a
       white card in light mode. */
    box-shadow: 0 1px 6px rgb(0 0 0 / 0.28);
  }
  .t-name { font-weight: 700; font-size: 0.86rem; margin-top: 6px; }
  .t-blurb { font-size: 0.78rem; color: var(--text-muted); line-height: 1.35; }

  .scratch { justify-content: center; border-style: dashed; }
  .s-mark { font-size: 1.8rem; opacity: 0.5; }
  @media (min-width: 520px) { .scratch { min-height: 240px; } }
  /* Marked, not moved to the front and left to be guessed at. The tile is already first; this says
     WHY it is first, which is the difference between a helpful order and an arbitrary one. */
  .tile.suggested { border-color: var(--accent); }
  .t-sugg {
    margin-left: 6px; padding: 1px 6px; border-radius: 999px; vertical-align: middle;
    background: var(--accent-fill); color: var(--accent-ink, #111);
    font-size: 0.6rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  }
</style>

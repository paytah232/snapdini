<script lang="ts">
  // ── The image swatch strip ──────────────────────────────────────────────────
  //
  // Six colours pulled out of the background image, applied to whichever colour control the host
  // last aimed at. It used to live inside the poster's flat "Text colours" list and nowhere else,
  // which is the reason that list could not simply be deleted: the strip only worked because every
  // row in it pointed `activeTarget` at itself on focus. The contextual dots do that now, and this
  // is the one copy of the strip — used from the two poster steps that own colours, and from the
  // cards tab — so it can never be rendered twice on one screen.
  //
  // Deliberately dumb: it holds no state and decides nothing. `label` names the control the colours
  // will land on, and a blank one means this screen has nothing to colour — in which case a strip
  // of swatches is a control for nothing, and does not render at all.
  export let palette: string[] = [];
  export let label = '';
  /** Applies one swatch to whatever is currently aimed at. A callback rather than an event, so the
   *  caller's own applySwatch() stays the single implementation of "what does a colour do". */
  export let pick: (hex: string) => void;
</script>

{#if palette.length && label}
  <div class="pal">
    <span class="pal-h">From your image → {label}:</span>
    <div class="swatches">{#each palette as p}<button class="sw" style="background:{p}" title={p} aria-label={`Use ${p}`} on:click={() => pick(p)}></button>{/each}</div>
  </div>
{/if}

<style>
  .pal { margin-top: 10px; }
  .pal-h { font-size: 0.74rem; color: var(--text-muted); }
  .swatches { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .sw { width: 30px; height: 30px; border-radius: 7px; border: 1px solid var(--border); cursor: pointer; }
</style>

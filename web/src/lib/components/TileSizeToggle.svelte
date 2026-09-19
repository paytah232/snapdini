<!--
  Card size, as a three-stop control in the bar.

  A segmented control rather than a single button that cycles: cycling hides how many stops there
  are and which one you are on, and this is a preference people set once and forget — the state has
  to be readable at a glance, not discovered by pressing.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { TILE_SIZES, sizesFor, effectiveSize, type TileSize } from '$lib/tileSize';

  export let size: TileSize = 'small';
  const dispatch = createEventDispatcher<{ change: TileSize }>();

  /* Only the stops that draw something different here — on a phone the grid is a fixed column
     count, so two of the three are the same picture (see sizesFor). Starts at the desktop width so
     the server-rendered markup is the full control and the phone drops one on hydration, rather
     than the other way round: adding a segment is a smaller flinch than removing one. */
  let vw = 1024;
  $: offered = TILE_SIZES.filter((t) => sizesFor(vw).includes(t.key));
  // What is really on screen, which is not always what is saved — see effectiveSize.
  $: shown = effectiveSize(size, vw);

  function pick(next: TileSize) {
    if (next === shown) return;
    size = next;
    dispatch('change', next);
  }
</script>

<svelte:window bind:innerWidth={vw} />

<!-- One stop left is not a choice, so there is nothing to show. -->
{#if offered.length > 1}
<div class="tsize" role="group" aria-label="Card size">
  {#each offered as t}
    <button type="button" class="tbtn" class:on={shown === t.key}
            aria-pressed={shown === t.key}
            title={`${t.label} cards`}
            on:click={() => pick(t.key)}>
      <!-- The mark is the thing it does: one, two or four blocks. A word for each would not fit the
           bar on a phone, and the sizes have no natural names anyway. -->
      <span class="mark m-{t.key}" aria-hidden="true"></span>
      <span class="vh">{t.label} cards</span>
    </button>
  {/each}
</div>
{/if}

<style>
  .tsize { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm);
    overflow: hidden; flex: none; }
  .tbtn { display: flex; align-items: center; justify-content: center; min-width: 34px;
    min-height: 34px; padding: 0 8px; border: 0; background: transparent; cursor: pointer;
    color: var(--text-muted); }
  .tbtn + .tbtn { border-left: 1px solid var(--border); }
  .tbtn:hover { color: var(--text); }
  .tbtn.on { background: var(--accent-fill); color: var(--accent-ink, #111); }
  /* Drawn with a grid of blocks rather than an icon font or an SVG each: three marks that differ
     only in how many cells they hold say "more, smaller" better than three unrelated glyphs. */
  .mark { display: grid; gap: 2px; width: 14px; height: 14px; }
  .mark::before, .mark::after { content: ''; display: block; background: currentColor; border-radius: 1px; }
  .m-large { grid-template-columns: 1fr; grid-template-rows: 1fr; }
  .m-large::after { display: none; }
  .m-medium { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
  .m-small { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
  /* The 2×2 needs four cells; ::before and ::after give two, so the element's own background paints
     the rest via a repeating pattern instead of two more empty elements. */
  .m-small { background:
      linear-gradient(currentColor 0 0) 100% 0 / 6px 6px no-repeat,
      linear-gradient(currentColor 0 0) 0 100% / 6px 6px no-repeat; }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%);
    white-space: nowrap; }
</style>

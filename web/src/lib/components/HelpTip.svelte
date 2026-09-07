<script lang="ts">
  // A small "?" badge that reveals an explanation on hover or focus (works on touch via focus).
  //
  // The bubble is positioned FIXED and measured on open rather than absolutely inside the badge.
  // Absolute positioning put it inside whatever card it sat in, so a tip near a card's edge was
  // clipped by that card's `overflow: hidden` and one near the screen edge ran off entirely —
  // exactly the cases where the explanation is hardest to guess.
  import { tick } from 'svelte';

  export let text: string;

  const GAP = 6;      // space between badge and bubble
  const EDGE = 8;     // keep this far from the viewport edge

  let btn: HTMLButtonElement;
  let bubble: HTMLSpanElement | undefined;
  let open = false;
  let x = 0, y = 0;

  async function show() {
    open = true;
    await tick();
    if (!btn || !bubble) return;
    const b = btn.getBoundingClientRect();
    const w = bubble.offsetWidth, h = bubble.offsetHeight;
    // Clamp horizontally so it can never leave the screen, wherever the badge sits.
    x = Math.min(Math.max(EDGE, b.left + b.width / 2 - w / 2), window.innerWidth - w - EDGE);
    // Prefer above; flip below when there is not room, so it is never half off the top.
    y = b.top - h - GAP >= EDGE ? b.top - h - GAP : b.bottom + GAP;
  }
  const hide = () => { open = false; };
</script>

<!-- Any scroll or resize invalidates a fixed position, so close rather than let it drift. -->
<svelte:window on:scroll={hide} on:resize={hide} />

<button type="button" class="tip" bind:this={btn} aria-label={text}
        on:mouseenter={show} on:mouseleave={hide} on:focus={show} on:blur={hide}
        on:click|preventDefault={() => (open ? hide() : show())}>?</button>
{#if open}
  <span class="bubble" bind:this={bubble} style="left:{x}px; top:{y}px" role="tooltip">{text}</span>
{/if}

<style>
  .tip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; padding: 0; border-radius: 50%; border: 1px solid var(--border);
    background: transparent; color: var(--text-muted); font-size: 0.62rem; font-weight: 700; cursor: help;
    vertical-align: middle; margin-left: 4px; flex: none;
  }
  .bubble {
    position: fixed; width: max-content; max-width: min(260px, calc(100vw - 16px));
    background: var(--surface-2); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px;
    font-size: 0.72rem; font-weight: 400; line-height: 1.4; text-align: left; white-space: normal;
    box-shadow: 0 6px 20px rgba(0,0,0,0.3); z-index: 200; pointer-events: none;
  }
</style>

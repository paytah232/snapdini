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

  // ── Why one tap used to do nothing ──
  // A tap on a touch screen synthesises a whole mouse interaction afterwards. Measured in Chromium
  // on a phone profile, one tap on this button fires:
  //
  //   pointerdown → touchstart → mouseenter → mouseenter → mousedown → focus → mouseup → click
  //                → mouseleave → mouseleave
  //
  // mouseenter opened the bubble and then **mouseleave closed it again**, a few milliseconds later,
  // as the tail of the same tap. Nothing had gone wrong by the time of the click — the pointer
  // simply "left" a button it had never really been hovering. (Note there is no blur in that list:
  // the tip would have stayed open otherwise.)
  //
  // So hover is driven by POINTER events and acted on only for a real mouse. pointerType is the one
  // thing that distinguishes the genuine article from the replay, and it costs nothing to check.
  const onEnter = (e: PointerEvent) => { if (e.pointerType === 'mouse') show(); };
  const onLeave = (e: PointerEvent) => { if (e.pointerType === 'mouse') hide(); };

  // With hover out of the way the click is a plain toggle again — but it still has to survive the
  // focus that lands just before it on a tap. Decide what the click means at pointerdown, while
  // `open` still reflects what the user was looking at when they reached for it.
  let openingGesture = false;
  const onPointerDown = () => { openingGesture = !open; };
  function onClick() {
    if (openingGesture) { openingGesture = false; show(); return; }
    hide();
  }
</script>

<!-- Any scroll or resize invalidates a fixed position, so close rather than let it drift. -->
<svelte:window on:scroll={hide} on:resize={hide} />

<button type="button" class="tip" bind:this={btn} aria-label={text}
        on:pointerenter={onEnter} on:pointerleave={onLeave} on:focus={show} on:blur={hide}
        on:pointerdown={onPointerDown} on:click|preventDefault={onClick}>?</button>
{#if open}
  <span class="bubble" bind:this={bubble} style="left:{x}px; top:{y}px" role="tooltip">{text}</span>
{/if}

<style>
  /* The dot stays 15px; the TARGET is 34px.
     A 15x15 button is unhittable with a thumb, but growing the visible mark would make a help dot
     shout louder than the label it belongs to. So the ring keeps its size and the button carries
     transparent padding around it — negative margins keep the layout identical, so nothing moves. */
  .tip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; margin: -10px -10px -10px -6px; padding: 0;
    background: transparent; border: 0; color: var(--text-muted); cursor: help;
    vertical-align: middle; flex: none;
  }
  .tip::before {
    content: '?';
    display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; border-radius: 50%; border: 1px solid var(--border);
    font-size: 0.62rem; font-weight: 700; line-height: 1;
  }
  /* The glyph now comes from ::before, so the element's own text must not double it up. */
  .tip { font-size: 0; }
  .bubble {
    position: fixed; width: max-content; max-width: min(260px, calc(100vw - 16px));
    background: var(--surface-2); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px;
    font-size: 0.72rem; font-weight: 400; line-height: 1.4; text-align: left; white-space: normal;
    box-shadow: 0 6px 20px rgba(0,0,0,0.3); z-index: 200; pointer-events: none;
  }
</style>

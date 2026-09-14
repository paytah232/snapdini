<!--
  A native time input that lands on the 15-minute grid.

  The control is the browser's own on purpose: it is the one people already know, and on a phone it
  is a wheel your thumb is used to. A <select> of 96 options guarantees the grid and is a far worse
  thing to use.

  What the native input cannot do is enforce the grid. `step="900"` is a VALIDATION rule — an
  off-grid value is still accepted into the field, it merely fails checkValidity(), which nothing
  surfaces — and it has no say over the picker a browser decides to draw, so Chrome's list and
  Android's dial offer five-minute options whatever step says. So the value is snapped after the
  change, and the host is TOLD, because a field that silently rewrites what you typed is worse than
  one that takes a value it cannot honour.
-->
<script lang="ts">
  import { REVEAL_TICK_MS } from '$lib/events';
  import { snapDown, snapUp, isOnGrid, parseHhmm, TICK_MIN } from '$lib/timeGrid';

  export let value = '';
  export let id: string | undefined = undefined;
  export let disabled = false;
  /** Earliest selectable time, passed straight through (used with a date's `min`). */
  export let min: string | undefined = undefined;
  /** Which way an off-grid time is moved. 'down' opens the doors a little early, which costs
   *  nothing; 'up' is for anything that must not happen BEFORE the moment that was typed — a reveal
   *  or a guest send, where early is the mistake with no undo. */
  export let snap: 'down' | 'up' = 'down';

  let moved = '';

  const fmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const spoken = (hhmm: string) => {
    const mins = parseHhmm(hhmm);
    return mins === null ? hhmm : fmt.format(new Date(2000, 0, 1, Math.floor(mins / 60), mins % 60));
  };

  // on:change, not on:input: mid-typing, "09:0" and "09:05" are both on their way to 09:05, and
  // snapping every keystroke would fight the person entering it.
  function settle(e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    if (isOnGrid(raw)) { moved = ''; return; }
    const snapped = snap === 'up' ? snapUp(raw) : snapDown(raw);
    value = snapped;
    moved = `Times run in ${TICK_MIN}-minute steps — set to ${spoken(snapped)}.`;
  }
</script>

<input
  type="time"
  {id}
  {disabled}
  {min}
  step={REVEAL_TICK_MS / 1000}
  bind:value
  on:change={settle}
/>
{#if moved}
  <!-- aria-live so it reaches somebody who cannot see the field change under them. -->
  <p class="tf-moved" aria-live="polite">{moved}</p>
{/if}

<style>
  /* The input lives in here now, and Svelte scopes styles to their own component — so the pages'
     `input { … }` rules no longer reach it and it would render as a raw browser control beside
     styled neighbours. Same tokens, so it still follows the theme. */
  input {
    width: 100%;
    padding: 11px 13px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.95rem;
    font-family: var(--font);
    /* Date and time are the two controls most likely to be poked one-handed on a phone, and iOS in
       particular renders them below a comfortable tap target. */
    min-height: 44px;
  }
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  input:disabled { opacity: 0.55; cursor: not-allowed; }

  .tf-moved {
    margin: 6px 0 0;
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--text-muted);
  }
</style>

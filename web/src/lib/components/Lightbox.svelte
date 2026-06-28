<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { mediaMeta, type Photo } from '$lib/events';

  export let photos: Photo[] = [];
  export let index = 0;

  const dispatch = createEventDispatcher<{ close: void }>();
  $: photo = photos[index];

  // Move focus into the dialog on open and restore it to the trigger on close.
  let lbEl: HTMLElement;
  let prevFocus: HTMLElement | null = null;
  onMount(() => { prevFocus = document.activeElement as HTMLElement; lbEl?.focus(); });
  onDestroy(() => prevFocus?.focus?.());

  function prev() { if (index > 0) index--; }
  function next() { if (index < photos.length - 1) index++; }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') dispatch('close');
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'ArrowRight') next();
  }
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="lb" bind:this={lbEl} on:click|self={() => dispatch('close')} role="dialog" aria-modal="true" aria-label="Photo viewer" tabindex="-1">
  <button class="close" on:click={() => dispatch('close')} aria-label="Close">✕</button>
  {#if photo}
    {#if photo.mediaType === 'video'}
      <!-- svelte-ignore a11y-media-has-caption -->
      <video src={photo.url} controls autoplay playsinline></video>
    {:else}
      <img src={photo.url} alt="Photo by {photo.participantName}" decoding="async" />
    {/if}
    <div class="cap">{photo.participantName} · {new Date(photo.takenAt).toLocaleString()}{#if mediaMeta(photo)} · {mediaMeta(photo)}{/if} · {index + 1}/{photos.length}</div>
  {/if}
  {#if index > 0}<button class="nav l" on:click={prev} aria-label="Previous">‹</button>{/if}
  {#if index < photos.length - 1}<button class="nav r" on:click={next} aria-label="Next">›</button>{/if}
</div>

<style>
  .lb { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.92); z-index: 300;
    display: flex; align-items: center; justify-content: center; padding: 24px; }
  img, video { max-width: 100%; max-height: 86vh; border-radius: 8px; }
  .close { position: absolute; top: 16px; right: 16px; background: rgba(0,0,0,0.5); color: #fff;
    border: none; width: 40px; height: 40px; border-radius: 50%; font-size: 1.2rem; cursor: pointer; }
  .cap { position: absolute; bottom: 18px; left: 0; right: 0; text-align: center; color: #fff;
    font-size: 0.82rem; text-shadow: 0 1px 3px #000; }
  .nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.4);
    color: #fff; border: none; width: 44px; height: 64px; font-size: 2rem; cursor: pointer; }
  .nav.l { left: 8px; border-radius: 0 8px 8px 0; } .nav.r { right: 8px; border-radius: 8px 0 0 8px; }
</style>

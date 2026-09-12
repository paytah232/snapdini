<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { mediaMeta, type Photo } from '$lib/events';

  export let photos: Photo[] = [];
  export let index = 0;

  /** Who may caption from in here. 'own' = only the viewer's own shots (the guest's roll), 'any' =
   *  every photo (the host, in Review), 'none' = the read-only galleries. Opening the same editor
   *  the grid uses, rather than a second one, is the whole point: a caption written full-screen and
   *  a caption written on a tile have to behave identically. */
  export let captionMode: 'none' | 'own' | 'any' = 'none';
  $: canCaption = captionMode === 'any' || (captionMode === 'own' && !!photo?.isOwn);

  const dispatch = createEventDispatcher<{ close: void; caption: Photo }>();
  $: photo = photos[index];

  // Move focus into the dialog on open and restore it to the trigger on close.
  let lbEl: HTMLElement;
  let prevFocus: HTMLElement | null = null;
  onMount(() => { prevFocus = document.activeElement as HTMLElement; lbEl?.focus(); });
  onDestroy(() => prevFocus?.focus?.());

  function prev() { if (index > 0) index--; }
  function next() { if (index < photos.length - 1) index++; }
  function onKey(e: KeyboardEvent) {
    // Someone typing has the keyboard, not the viewer. Without this, writing a caption over the
    // lightbox pages the album out from under the half-typed text, and Escape closes the photo
    // instead of the editor — arrow keys in a textarea are how you move the cursor.
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'Escape') dispatch('close');
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'ArrowRight') next();
  }
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="lb" bind:this={lbEl} on:click|self={() => dispatch('close')} role="dialog" aria-modal="true" aria-label="Photo viewer" tabindex="-1">
  <button class="close" on:click={() => dispatch('close')} aria-label="Close">✕</button>
  {#if canCaption}
    <!-- Looking at a photo full-screen is when someone actually thinks of what to say about it;
         making them close it and find the tile again is the wrong way round. -->
    <button class="lb-cap" on:click|stopPropagation={() => dispatch('caption', photo)}
            aria-label={photo.caption ? 'Edit this caption' : 'Add a caption'}>
      💬 {photo.caption ? 'Edit caption' : 'Add a caption'}
    </button>
  {/if}
  {#if photo}
    {#if photo.mediaType === 'video'}
      <!-- svelte-ignore a11y-media-has-caption -->
      <!-- playUrl when it exists: the original may be VP8/WebM, which stutters on phones and does
           not play at all in Safari. Downloads still take the original. -->
      <video src={photo.playUrl ?? photo.url} controls autoplay playsinline></video>
    {:else}
      <img src={photo.url} alt="Photo by {photo.participantName}" decoding="async" />
    {/if}
    <!-- Whatever the grid captioned this with must not vanish on the way into the photo. The
         written caption leads; the mission follows it, demoted, so a captioned trick shot still
         says which trick it was. -->
    <div class="cap">{#if photo.caption}<span class="written">{photo.caption}</span> · {/if}{#if photo.challenge}<span class="mission" class:secondary={!!photo.caption}>{photo.challenge}</span> · {/if}{photo.participantName} · {new Date(photo.takenAt).toLocaleString()}{#if mediaMeta(photo)} · {mediaMeta(photo)}{/if} · {index + 1}/{photos.length}</div>
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
  .cap .written { font-weight: 700; }
  .cap .mission { font-weight: 700; }
  .lb-cap { position: absolute; left: 12px; top: 12px; z-index: 3; padding: 8px 12px; border-radius: 999px;
    border: 1px solid rgba(255,255,255,.28); background: rgba(0,0,0,.5); color: #fff; font: inherit;
    font-size: .82rem; cursor: pointer; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .lb-cap:hover { border-color: rgba(255,255,255,.5); }
  /* Demoted, not dropped: with a caption present the mission is attribution, not the headline. */
  .cap .mission.secondary { font-weight: 400; opacity: .75; }
  .nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.4);
    color: #fff; border: none; width: 44px; height: 64px; font-size: 2rem; cursor: pointer; }
  .nav.l { left: 8px; border-radius: 0 8px 8px 0; } .nav.r { right: 8px; border-radius: 8px 0 0 8px; }
</style>

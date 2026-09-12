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

  /** When it was taken, said the way a person would. Seconds are noise on a photo, and so is the
   *  date when it was this afternoon. */
  function shotAt(ts: number): string {
    const d = new Date(ts);
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return time;
    const sameYear = d.getFullYear() === today.getFullYear();
    return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })}, ${time}`;
  }

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
    <!-- Three tiers, not one run. Everything used to be the same size on one full-width line, so
         the words somebody wrote sat level with the pixel dimensions and the caption was bold at
         0.82rem — small AND bold, which is the least legible pairing there is. -->
    <div class="cap">
      {#if photo.caption}<p class="cap-written">{photo.caption}</p>{/if}
      {#if photo.challenge}<p class="cap-mission" class:secondary={!!photo.caption}>{photo.challenge}</p>{/if}
      <p class="cap-meta">
        <span class="who">{photo.participantName}</span>
        <span class="sep" aria-hidden="true">·</span>{shotAt(photo.takenAt)}
        {#if mediaMeta(photo)}<span class="sep" aria-hidden="true">·</span>{mediaMeta(photo)}{/if}
        <span class="sep" aria-hidden="true">·</span>{index + 1} of {photos.length}
      </p>
    </div>
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
  /* Held to a readable measure and kept clear of the nav arrows, rather than run edge to edge. The
     scrim does the legibility work a text-shadow was being asked to do alone over a bright photo. */
  .cap { position: absolute; bottom: 0; left: 0; right: 0; padding: 48px 64px 18px; color: #fff;
    text-align: center; pointer-events: none;
    background: linear-gradient(to top, rgba(0,0,0,.72) 0%, rgba(0,0,0,.45) 45%, transparent 100%); }
  .cap > * { max-width: 56ch; margin: 0 auto; }
  .cap-written { font-size: 1rem; line-height: 1.45; font-weight: 500; overflow-wrap: anywhere; }
  .cap-mission { margin-top: 4px; font-size: .84rem; line-height: 1.4; font-weight: 700; }
  .cap-meta { margin-top: 7px; font-size: .74rem; line-height: 1.5; color: rgba(255,255,255,.72);
    display: flex; flex-wrap: wrap; align-items: baseline; justify-content: center; gap: 0 6px; }
  .cap-meta .who { font-weight: 600; color: rgba(255,255,255,.9); }
  .cap-meta .sep { opacity: .45; }
  .lb-cap { position: absolute; left: 12px; top: 12px; z-index: 3; padding: 8px 12px; border-radius: 999px;
    border: 1px solid rgba(255,255,255,.28); background: rgba(0,0,0,.5); color: #fff; font: inherit;
    font-size: .82rem; cursor: pointer; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .lb-cap:hover { border-color: rgba(255,255,255,.5); }
  /* Demoted, not dropped: with a caption present the mission is attribution, not the headline. */
  .cap-mission.secondary { font-weight: 400; opacity: .78; }
  .nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.4);
    color: #fff; border: none; width: 44px; height: 64px; font-size: 2rem; cursor: pointer; }
  .nav.l { left: 8px; border-radius: 0 8px 8px 0; } .nav.r { right: 8px; border-radius: 8px 0 0 8px; }
</style>

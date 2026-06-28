<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { getEvent, getGalleryPhotos, type Photo, type PublicEvent } from '$lib/events';
  import { applyEventTheme } from '$lib/theme';
  import { showToast } from '$lib/toast';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import OgHead from '$lib/components/OgHead.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import { imgFallback, hidePoster } from '$lib/ui';
  import type { PageData } from './$types';

  export let data: PageData;
  const code = $page.params.code ?? '';

  let loading = true;
  let error = '';
  let event: PublicEvent | null = null;

  let revealed = false;
  let revealMode = '';
  let revealAt: number | null = null;
  let photoCount = 0;

  let photos: Photo[] = [];
  let hasHighlights = false;
  let highlightsOnly = false;
  let allowDownloads = true;

  let lbOpen = false;
  let lbIndex = 0;

  // Live countdown
  let now = Date.now();
  let tick: ReturnType<typeof setInterval> | undefined;

  $: remaining = revealAt ? Math.max(0, revealAt - now) : 0;
  $: countdown = formatCountdown(remaining);

  function formatCountdown(ms: number): string {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }

  async function loadPhotos() {
    const data = await getGalleryPhotos(code, highlightsOnly);
    revealed = data.revealed;
    revealMode = data.revealMode ?? '';
    revealAt = data.revealAt ?? null;
    photoCount = data.photoCount ?? 0;
    hasHighlights = data.hasHighlights ?? false;
    allowDownloads = data.allowDownloads !== false;
    photos = data.photos ?? [];
  }

  onMount(async () => {
    try {
      event = await getEvent(code);
      document.title = `${event.name} — Snapdini`;
      applyEventTheme(event.theme);
      await loadPhotos();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Event not found';
    } finally {
      loading = false;
    }
    tick = setInterval(() => (now = Date.now()), 1000);
  });

  onDestroy(() => clearInterval(tick));

  async function toggleHighlights() {
    highlightsOnly = !highlightsOnly;
    try {
      await loadPhotos();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not load photos', true);
    }
  }

  function openLightbox(i: number) {
    lbIndex = i;
    lbOpen = true;
  }

  function fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Selection + zip download (server streams a single max-compression .zip of originals).
  let selecting = false;
  let selected = new Set<string>();

  function toggleSelecting() {
    selecting = !selecting;
    selected = new Set();
  }

  function onThumb(p: Photo, i: number) {
    if (selecting) {
      const next = new Set(selected);
      next.has(p.id) ? next.delete(p.id) : next.add(p.id);
      selected = next;
    } else {
      openLightbox(i);
    }
  }

  function zipHref(ids?: string[]): string {
    const q = ids && ids.length ? `?ids=${ids.join(',')}` : '';
    return `/api/photos/${code}/download${q}`;
  }
  function downloadAll() {
    if (!allowDownloads) { showToast('Downloads are disabled for this event', true); return; }
    showToast('Preparing your download…');
    location.href = zipHref();
  }
  function downloadSelected() {
    if (!selected.size) return;
    showToast('Preparing your download…');
    location.href = zipHref([...selected]);
  }

  const modeText = (mode: string) =>
    mode === 'manual'
      ? 'The host will reveal the photos soon'
      : mode === 'at_end'
        ? 'Photos unlock when the event ends'
        : 'Refresh to see photos';
</script>

<OgHead og={data.og} />

<nav>
  <a class="brand" href="/"><Logo /></a>
  <div class="nav-right">
    {#if revealed && hasHighlights}
      <button class="btn ghost" on:click={toggleHighlights}>
        {highlightsOnly ? '📷 All photos' : '⭐ Highlights'}
      </button>
    {/if}
    {#if revealed && allowDownloads && photos.length}
      <button class="btn ghost" on:click={toggleSelecting}>{selecting ? 'Cancel' : 'Select'}</button>
      {#if selecting}
        <button class="btn primary" on:click={downloadSelected} disabled={!selected.size}>⬇ Download{selected.size ? ` ${selected.size}` : ''}</button>
      {:else}
        <button class="btn ghost" on:click={downloadAll}>⬇ Download all</button>
      {/if}
    {/if}
  </div>
</nav>

{#if event?.theme?.headerImage}
  <!-- Event image as a full-bleed hero background (cover) with the title over a gradient — scales
       cleanly for any aspect, unlike the old fixed-width banner. -->
  <header class="hero" style="background-image:url('{event.theme.headerImage}')">
    <div class="hero-inner">
      <h1>{event?.name ?? 'Gallery'}</h1>
      {#if revealed && photos.length}
        <p class="meta">{photos.length} photo{photos.length === 1 ? '' : 's'}{highlightsOnly ? ' · highlights' : ''}</p>
      {/if}
    </div>
  </header>
{:else}
  <header class="event-head">
    <h1>{event?.name ?? 'Gallery'}</h1>
    {#if revealed && photos.length}
      <p class="meta">{photos.length} photo{photos.length === 1 ? '' : 's'}{highlightsOnly ? ' · highlights' : ''}</p>
    {/if}
  </header>
{/if}

<main>
  {#if loading}
    <div class="state">Loading…</div>
  {:else if error}
    <div class="state err">{error}</div>
  {:else if !revealed}
    <div class="reveal-wall">
      <span class="lock" aria-hidden="true">🔒</span>
      <p class="msg">{modeText(revealMode)}</p>
      {#if revealMode === 'at_end' && revealAt}
        <div class="countdown" aria-live="polite">{countdown}</div>
      {/if}
      <p class="count">{photoCount} photo{photoCount === 1 ? '' : 's'} so far</p>
    </div>
  {:else if !photos.length}
    <div class="state">No photos yet</div>
  {:else}
    <div class="grid">
      {#each photos as p, i (p.id)}
        <button class="thumb" class:selected={selecting && selected.has(p.id)} on:click={() => onThumb(p, i)}
          aria-label={selecting ? `Select photo by ${p.participantName}` : `Open photo by ${p.participantName}`}>
          {#if p.mediaType === 'video'}
            <img src={p.thumbUrl} alt="" loading="lazy" on:error={hidePoster} />
            <span class="play" aria-hidden="true">▶</span>
          {:else}
            <img src={p.thumbUrl ?? p.url} alt="" loading="lazy" on:error={(e) => imgFallback(e, p.url)} />
          {/if}
          {#if p.isHighlighted}<span class="star" aria-hidden="true">⭐</span>{/if}
          {#if selecting}<span class="check" class:on={selected.has(p.id)} aria-hidden="true">{selected.has(p.id) ? '✓' : ''}</span>{/if}
          <span class="cap">{p.participantName} · {fmtTime(p.takenAt)}</span>
        </button>
      {/each}
    </div>
  {/if}
</main>

{#if lbOpen}
  <Lightbox {photos} index={lbIndex} on:close={() => (lbOpen = false)} />
{/if}

<style>
  nav {
    position: sticky; top: 0; z-index: 50; display: flex; align-items: center; justify-content: space-between;
    height: 62px; padding: 0 16px; gap: 12px;
    backdrop-filter: blur(10px); background: color-mix(in srgb, var(--bg) 78%, transparent);
    border-bottom: 1px solid var(--border);
  }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; text-decoration: none; color: var(--text); }
  .nav-right { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 7px 14px; font-size: .82rem;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; }
  .ghost { border-color: var(--border); color: var(--text); background: transparent; }
  .ghost:hover { border-color: var(--accent); }

  .hero { position: relative; width: 100%; min-height: clamp(200px, 36vw, 360px); display: flex; align-items: flex-end;
    background-size: cover; background-position: center; }
  .hero::after { content: ''; position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,.72), rgba(0,0,0,.1) 55%, rgba(0,0,0,.3)); }
  .hero-inner { position: relative; z-index: 1; width: 100%; max-width: 1080px; margin: 0 auto; padding: 24px 16px 18px; color: #fff; }
  .hero-inner h1 { font-size: clamp(1.6rem, 5vw, 2.4rem); font-weight: 850; letter-spacing: -.02em; text-shadow: 0 2px 14px rgba(0,0,0,.55); }
  .hero-inner .meta { color: rgba(255,255,255,.88); font-size: .85rem; margin-top: 6px; text-shadow: 0 1px 6px rgba(0,0,0,.5); }

  .event-head { max-width: 1080px; margin: 0 auto; padding: 28px 16px 8px; }
  .event-head h1 { font-size: clamp(1.6rem, 5vw, 2.4rem); font-weight: 850; letter-spacing: -.02em; }
  .meta { color: var(--text-muted); font-size: .85rem; margin-top: 6px; }

  main { max-width: 1080px; margin: 0 auto; padding: 16px; min-height: 50dvh; }
  .state { text-align: center; padding: 60px 16px; color: var(--text-muted); }
  .state.err { color: var(--danger); }

  .reveal-wall {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; gap: 14px; padding: 64px 16px; min-height: 50dvh;
  }
  .reveal-wall .lock { font-size: 3rem; }
  .reveal-wall .msg { font-size: 1.15rem; font-weight: 700; max-width: 28ch; }
  .reveal-wall .count { color: var(--text-muted); font-size: .9rem; }
  .countdown {
    font-family: var(--font-mono); font-size: clamp(1.6rem, 8vw, 2.6rem); font-weight: 800;
    color: var(--accent); letter-spacing: .04em;
  }

  .grid {
    display: grid; gap: 6px;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  }
  .thumb {
    position: relative; aspect-ratio: 1; overflow: hidden; border-radius: 6px;
    padding: 0; border: none; cursor: pointer; background: var(--surface); display: block;
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb.selected { outline: 3px solid var(--accent); outline-offset: -3px; }
  .check { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800;
    background: rgba(0,0,0,.45); color: #fff; border: 2px solid #fff; }
  .check.on { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  .play {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 2rem; color: #fff; text-shadow: 0 2px 8px rgba(0,0,0,.6); pointer-events: none;
  }
  .star { position: absolute; top: 6px; left: 6px; font-size: .9rem; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
  .cap {
    position: absolute; left: 0; right: 0; bottom: 0; padding: 12px 6px 5px;
    font-size: .68rem; color: #fff; text-align: left;
    background: linear-gradient(transparent, rgba(0,0,0,.72));
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  @media (min-width: 640px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  }
</style>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { getShare, type Photo } from '$lib/events';
  import { applyEventTheme } from '$lib/theme';
  import { showToast } from '$lib/toast';
  import { tileAspect } from '$lib/ui';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import PhotoCard from '$lib/components/PhotoCard.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import OgHead from '$lib/components/OgHead.svelte';
  import StartYourOwn from '$lib/components/StartYourOwn.svelte';
  import { referralLink } from '$lib/referral';
  import type { PageData } from './$types';

  export let data: PageData;
  const token = ($page.params as Record<string, string>).token ?? '';
  let loading = true;
  let error = '';
  let eventName = '';
  let photos: Photo[] = [];
  let lbOpen = false;
  let lbIndex = 0;

  // Reveal state (a share opened before the event's reveal shows a countdown, not the photos).
  let revealed = true;
  let revealMode = '';
  let revealAt: number | null = null;
  let photoCount = 0;
  let allowDownloads = true;
  // The event's frame setting, so the grid is ONE shape. Defaulted rather than required: an older
  // API (or a cached response) simply doesn't send it and the tiles stay square, which is what
  // this page always drew.
  let aspectRatios: string[] = ['1:1'];

  // Selection + download
  let selecting = false;
  let selected = new Set<string>();

  // Live countdown
  let now = Date.now();
  let tick: ReturnType<typeof setInterval> | undefined;
  $: remaining = revealAt ? Math.max(0, revealAt - now) : 0;
  $: countdown = formatCountdown(remaining);

  function formatCountdown(ms: number): string {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }
  const modeText = (mode: string) =>
    mode === 'manual' ? 'The host will reveal the photos soon'
      : mode === 'at_end' ? 'Photos unlock when the event ends'
      : 'Photos aren’t available yet';

  async function load() {
    const s = await getShare(token);
    eventName = s.event.name;
    applyEventTheme(s.event.theme);
    allowDownloads = s.event.allowDownloads !== false;
    if (s.event.aspectRatios?.length) aspectRatios = s.event.aspectRatios;
    revealed = s.revealed;
    revealMode = s.revealMode ?? '';
    revealAt = s.revealAt ?? null;
    photoCount = s.photoCount ?? 0;
    photos = s.photos;
    document.title = `${eventName} — Shared photos`;
  }

  onMount(async () => {
    try { await load(); }
    catch (e) { error = e instanceof Error ? e.message : 'This share link is invalid or has expired'; }
    finally { loading = false; }
    tick = setInterval(() => (now = Date.now()), 1000);
  });
  onDestroy(() => clearInterval(tick));

  function toggleSelecting() { selecting = !selecting; selected = new Set(); }
  function onThumb(p: Photo, i: number) {
    if (selecting) {
      const next = new Set(selected);
      next.has(p.id) ? next.delete(p.id) : next.add(p.id);
      selected = next;
    } else { lbIndex = i; lbOpen = true; }
  }
  function dlHref(ids?: string[]): string {
    return `/api/shares/${token}/download${ids && ids.length ? `?ids=${ids.join(',')}` : ''}`;
  }
  // Referral surface 3: someone who just downloaded these photos has got real value out of the
  // product, so that is when the "start your own" card earns its emphasis.
  let downloaded = false;
  function downloadAll() { downloaded = true; showToast('Preparing your download…'); location.href = dlHref(); }
  function downloadSelected() { if (!selected.size) return; downloaded = true; showToast('Preparing your download…'); location.href = dlHref([...selected]); }
</script>

<svelte:head><title>Shared photos — Snapdini</title></svelte:head>
<OgHead og={data?.og} />

<main>
  <header>
    <a class="brand" href="/"><Logo /></a>
    {#if eventName}<h1>{eventName}</h1>{/if}
    {#if revealed && allowDownloads && photos.length}
      <div class="actions">
        <button class="btn ghost" on:click={toggleSelecting}>{selecting ? 'Cancel' : 'Select'}</button>
        {#if selecting}
          <button class="btn primary" on:click={downloadSelected} disabled={!selected.size}>⬇ Download{selected.size ? ` ${selected.size}` : ''}</button>
        {:else}
          <button class="btn ghost" on:click={downloadAll}>⬇ Download all</button>
        {/if}
      </div>
    {/if}
  </header>

  {#if loading}
    <p class="state">Loading…</p>
  {:else if error}
    <div class="state"><span class="big">🔗</span><p>{error}</p></div>
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
    <div class="state"><span class="big">📷</span><p>No photos in this share.</p></div>
  {:else}
    <!-- A share is the copy that leaves the event, so the words under a photo travel with it: the
         written caption leads and the mission is demoted underneath when a shot has the two. Same
         card as everywhere else — see PhotoCard.svelte. -->
    <div class="pgrid"
         style={`--tile-ar:${tileAspect(aspectRatios)}`}>
      {#each photos as p, i (p.id)}
        <PhotoCard photo={p} selected={selecting && selected.has(p.id)}
                   tileLabel={`Photo by ${p.participantName}`}
                   on:open={() => onThumb(p, i)}>
          <svelte:fragment slot="tile">
            {#if p.isHighlighted}<span class="star" aria-label="Favourite">★</span>{/if}
            {#if selecting}<span class="check" class:on={selected.has(p.id)}>{selected.has(p.id) ? '✓' : ''}</span>{/if}
          </svelte:fragment>
        </PhotoCard>
      {/each}
    </div>
  {/if}

  <!-- `s:` source rather than the join code: a share is a view-only surface and must not hand out
       the code that lets someone join the event and shoot. Resolved server-side in referrals.ts. -->
  {#if !loading && !error && revealed}
    <StartYourOwn sourceJoinCode={`s:${token}`} emphasis={downloaded} />
  {/if}
  <footer>© 2026 Snapdini · <a href={referralLink(`s:${token}`)}>Make your own event →</a></footer>
</main>

{#if lbOpen}<Lightbox photos={photos} index={lbIndex} allowSave={allowDownloads} on:close={() => (lbOpen = false)} />{/if}

<style>
  main { min-height: 100dvh; background: var(--bg); color: var(--text); }
  header { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; text-decoration: none; color: var(--text); }
  h1 { font-size: 1.05rem; margin: 0; overflow-wrap: anywhere; }
  .actions { margin-left: auto; display: flex; gap: 8px; }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 7px 14px; font-size: .82rem;
    border: 1px solid transparent; cursor: pointer; }
  .btn.ghost { border-color: var(--border); color: var(--text); background: transparent; }
  .btn.ghost:hover { border-color: var(--accent); }
  .btn.primary { background: var(--accent); color: var(--accent-ink, #111); }
  .btn:disabled { opacity: .6; cursor: default; }
  .state { text-align: center; padding: 60px 18px; color: var(--text-muted); }
  .state .big { font-size: 44px; display: block; margin-bottom: 10px; }
  .reveal-wall { display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; gap: 14px; padding: 64px 18px; min-height: 50dvh; }
  .reveal-wall .lock { font-size: 3rem; }
  .reveal-wall .msg { font-size: 1.15rem; font-weight: 700; max-width: 28ch; }
  .reveal-wall .count { color: var(--text-muted); font-size: .9rem; }
  .countdown { font-family: var(--font-mono); font-size: clamp(1.6rem, 8vw, 2.6rem); font-weight: 800; color: var(--accent); letter-spacing: .04em; }
  /* The grid and the card itself are PhotoCard's (.pgrid / .pcell-wrap). All that belongs to this
     page is what it overlays on the tile. */
  /* Favourite marker — same dark-chip + gold-★ as the favourite button; top-left to clear the
     select checkbox (top-right), and a shadow/chip so it clearly sits on the photo. */
  .star { position: absolute; top: 6px; left: 6px; width: 24px; height: 24px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 0.82rem; line-height: 1;
    color: var(--accent); background: rgba(0,0,0,0.5); box-shadow: 0 1px 4px rgba(0,0,0,0.45); }
  .check { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800;
    background: rgba(0,0,0,.45); color: #fff; border: 2px solid #fff; line-height: 1; }
  .check.on { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  footer { text-align: center; font-size: 0.78rem; color: var(--text-muted); padding: 28px 18px; }
  footer a { color: var(--text-muted); }
  footer a:hover { color: var(--accent); }
</style>

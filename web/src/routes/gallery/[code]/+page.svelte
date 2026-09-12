<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { getEvent, getGalleryPhotos, getMe, type Photo, type PublicEvent } from '$lib/events';
  import { getSession } from '$lib/session';
  import FaceFinder from '$lib/components/FaceFinder.svelte';
  import GuestFeedback from '$lib/components/GuestFeedback.svelte';
  import { applyEventTheme } from '$lib/theme';
  import { showToast } from '$lib/toast';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import OgHead from '$lib/components/OgHead.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import PhotoCard from '$lib/components/PhotoCard.svelte';
  import { tileAspect } from '$lib/ui';
  import { demoLinks } from '$lib/demo';
  import StartYourOwn from '$lib/components/StartYourOwn.svelte';
  import { trackGalleryView, trackPhotos } from '$lib/referral';
  import type { PageData } from './$types';

  export let data: PageData;
  const code = $page.params.code ?? '';

  let loading = true;
  let error = '';
  let event: PublicEvent | null = null;

  let revealed = false;
  let revealMode = '';
  let revealAt: number | null = null;
  // "Just revealed" = within 48h of the gallery unlocking. That window is the reveal moment for an
  // at_end/manual event, when guests come back and see everything at once.
  $: justRevealed = revealed && !!revealAt && Date.now() - revealAt < 48 * 3600 * 1000;
  let photoCount = 0;

  let photos: Photo[] = [];
  let hasHighlights = false;
  let highlightsOnly = false;
  let allowDownloads = true;

  let lbOpen = false;
  let lbIndex = 0;

  // "Find the photos I'm in" belongs HERE, on the shared gallery, and not in a guest's own roll —
  // searching your own shots for yourself is pointless. This page is public, so the control is
  // offered only to someone holding a participant session for THIS event (same localStorage key
  // the camera writes); a stranger with the link gets nothing to enrol into.
  let guestToken = '';
  // Feedback is offered here too. This is where a guest arrives after the event ends, which is a
  // better moment to ask than mid-party — and because the control needs a participant session, a
  // stranger who was sent the gallery link is never asked at all.
  let feedbackDone = false;
  let faceMatching = false;
  let faceEnrolled = false;
  let facePhotoIds: string[] = [];
  let meOnly = false;
  $: shownPhotos = meOnly ? photos.filter((p) => facePhotoIds.includes(p.id)) : photos;
  $: if (!faceEnrolled) meOnly = false;

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
    // Engagement: the ids this viewer actually received. Batched and fire-and-forget — a counter
    // must never delay or break the gallery.
    trackPhotos(code, photos.map((p) => p.id), 'view');
  }

  onMount(async () => {
    trackGalleryView(code);
    try {
      event = await getEvent(code);
      document.title = `${event.name} — Snapdini`;
      applyEventTheme(event.theme);
      await loadPhotos();
      guestToken = getSession(code) ?? '';
      if (guestToken) {
        try {
          const me = await getMe(guestToken);
          faceMatching = !!me.faceMatching;
          faceEnrolled = !!me.faceEnrolled;
          feedbackDone = !!me.feedbackGiven;
        } catch { guestToken = ''; }   // stale session — just don't offer it
      }
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
    // Counted here, not in zipHref: that builder can be evaluated during render, which would
    // record downloads that never happened.
    trackPhotos(code, photos.map((p) => p.id), 'download');
    showToast('Preparing your download…');
    location.href = zipHref();
  }
  // "All" means everything currently on screen, not everything in the event — otherwise the button
  // quietly contradicts whatever filter the viewer is looking through.
  $: allShownSelected = shownPhotos.length > 0 && shownPhotos.every((p) => selected.has(p.id));
  function toggleSelectAll() {
    selected = allShownSelected ? new Set() : new Set(shownPhotos.map((p) => p.id));
  }

  function downloadSelected() {
    if (!selected.size) return;
    trackPhotos(code, [...selected], 'download');
    showToast('Preparing your download…');
    location.href = zipHref([...selected]);
  }

  // Recomputed when the event loads, because localStorage is only readable in the browser and the
  // organizer code is not in the page payload — it is put there by the landing page that made the
  // demo, which is the only place it is ever handed out.
  $: dlinks = demoLinks(event?.joinCode ?? code, event?.organizerCode);

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
    <!-- The demo's own navigation. Arriving here from the demo camera used to be a one-way door:
         the camera carries these links, this page did not, so there was no way to the host's view
         and no way out but the back button. Same order as the camera's — see the room, then the
         host's side of it, and only then the exit. -->
    {#if event?.isDemo}
      <a class="btn ghost demo" href={dlinks.camera}>📷 Camera</a>
      {#if dlinks.host}<a class="btn ghost demo" href={dlinks.host}>🎛 Host view</a>{/if}
      <!-- No "Exit demo" here: the Snapdini logo to the left of this row already goes home, and on
           a revealed gallery this bar can hold Highlights, Select and Download all as well. A
           third pill that duplicates the logo is the one that pushes it over. -->
    {/if}
    {#if revealed && hasHighlights}
      <button class="btn ghost" on:click={toggleHighlights}>
        {highlightsOnly ? '📷 All photos' : '⭐ Highlights'}
      </button>
    {/if}
    {#if revealed && allowDownloads && photos.length}
      <button class="btn ghost" on:click={toggleSelecting}>{selecting ? 'Cancel' : 'Select'}</button>
      {#if !selecting}
        <button class="btn ghost" on:click={downloadAll}>⬇ Download all</button>
      {/if}
    {/if}
  </div>
</nav>

{#if selecting}
  <!-- Its own bar rather than more buttons in the nav: on a phone the nav is a fixed 62px and the
       extra controls wrapped straight out of view. This also has room to say how many are picked. -->
  <div class="selbar">
    <span class="selcount">{selected.size} selected</span>
    <div class="selactions">
      <button class="btn ghost" on:click={toggleSelectAll}>
        {allShownSelected ? 'Clear' : `Select all${shownPhotos.length ? ` (${shownPhotos.length})` : ''}`}
      </button>
      <button class="btn primary" on:click={downloadSelected} disabled={!selected.size}>
        ⬇ Download{selected.size ? ` ${selected.size}` : ''}
      </button>
    </div>
  </div>
{/if}

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
    {#if guestToken && (faceMatching || faceEnrolled)}
      <FaceFinder sessionToken={guestToken} bind:enrolled={faceEnrolled}
                  onMatched={(ids) => { facePhotoIds = ids; meOnly = ids.length > 0; }} />
    {/if}
    {#if faceEnrolled}
      <div class="gfilter" role="tablist" aria-label="Filter photos">
        <button class="gchip" class:on={!meOnly} on:click={() => (meOnly = false)}>All <span class="n">{photos.length}</span></button>
        <button class="gchip" class:on={meOnly} on:click={() => (meOnly = true)}>Me <span class="n">{facePhotoIds.length}</span></button>
      </div>
    {/if}
    {#if meOnly && !shownPhotos.length}
      <div class="state">You weren't matched in any of these photos.</div>
    {/if}
    <!-- The same card as the guest's roll, the share links and the host's review screen — see
         PhotoCard.svelte. The words used to sit in a gradient over the bottom of the photo, where
         a caption of any length fought the picture and then ran off it. --tile-ar is the event's
         frame setting, so the whole grid is one shape rather than one shape per file. -->
    <div class="pgrid"
         style={`--tile-ar:${tileAspect(event?.aspectRatios)}`}>
      {#each shownPhotos as p, i (p.id)}
        <PhotoCard photo={p} selected={selecting && selected.has(p.id)}
                   meta={`${p.participantName} · ${fmtTime(p.takenAt)}`}
                   tileLabel={selecting ? `Select photo by ${p.participantName}` : `Open photo by ${p.participantName}`}
                   on:open={() => onThumb(p, i)}>
          <svelte:fragment slot="tile">
            {#if p.isHighlighted}<span class="star" aria-hidden="true">⭐</span>{/if}
            {#if selecting}<span class="check" class:on={selected.has(p.id)} aria-hidden="true">{selected.has(p.id) ? '✓' : ''}</span>{/if}
          </svelte:fragment>
        </PhotoCard>
      {/each}
    </div>
  {/if}
  <!-- Surface 1 of 3: every guest lands here, and no email address is required to reach them.
       Only shown once photos are actually visible — pitching before the reveal is noise. -->
  {#if revealed && photos.length}
    <StartYourOwn sourceJoinCode={code} emphasis={justRevealed}
                  footer={!!guestToken && !feedbackDone}>
      <svelte:fragment slot="foot">
        <GuestFeedback sessionToken={guestToken} bind:done={feedbackDone} />
      </svelte:fragment>
    </StartYourOwn>
  {/if}
</main>

{#if lbOpen}
  <Lightbox photos={shownPhotos} index={lbIndex} on:close={() => (lbOpen = false)} />
{/if}

<style>
  nav {
    position: sticky; top: 0; z-index: 50; display: flex; align-items: center; justify-content: space-between;
    /* min-height, not height: .nav-right wraps, and a fixed 62px meant the second row spilled out
       of the bar instead of making it taller. On a revealed demo gallery this row can hold five
       controls, which is exactly when it wraps. */
    min-height: 62px; padding: 9px 16px; gap: 12px; flex-wrap: wrap;
    backdrop-filter: blur(10px); background: color-mix(in srgb, var(--bg) 78%, transparent);
    border-bottom: 1px solid var(--border);
  }
  .gfilter { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin: 0 0 16px; }
  .gchip {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--surface); color: var(--text);
    font-size: .85rem; font-weight: 600; cursor: pointer;
  }
  .gchip.on { border-color: var(--accent); background: var(--accent); color: var(--accent-ink, #111); }
  .gchip .n { opacity: .7; font-variant-numeric: tabular-nums; }
  .selbar {
    position: sticky; top: 62px; z-index: 49; display: flex; align-items: center;
    justify-content: space-between; gap: 10px; flex-wrap: wrap;
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(10px);
  }
  .selcount { font-size: .85rem; font-weight: 700; color: var(--text-muted); }
  .selactions { display: flex; gap: 8px; flex-wrap: wrap; }
  @media (max-width: 480px) {
    .selbar { justify-content: stretch; }
    .selactions { flex: 1; }
    .selactions .btn { flex: 1; }
  }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; text-decoration: none; color: var(--text); }
  .nav-right { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 7px 14px; font-size: .82rem;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; }
  .ghost { border-color: var(--border); color: var(--text); background: transparent; }
  /* The exit is the one link here that is not part of the tour, so it recedes — same reasoning as
     the camera's .home-btn.quiet. */
  /* The tour's links are context, not the point of this page — the gallery's own actions lead. */
  .demo { opacity: .85; }
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

  /* The grid and the card itself are PhotoCard's (.pgrid / .pcell-wrap). All that belongs to this
     page is what it overlays on the tile. */
  .check { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800;
    background: rgba(0,0,0,.45); color: #fff; border: 2px solid #fff; }
  .check.on { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  .star { position: absolute; top: 6px; left: 6px; font-size: .9rem; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
</style>

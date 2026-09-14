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
  import { saveMany, prefersFiles, isIOS, filesLimit, type SaveManyProgress, savePhotoByUrl } from '$lib/saveImage';
  import { savedSet, markSaved } from '$lib/saved';
  import ShareScope from '$lib/components/ShareScope.svelte';
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
    saved = savedSet(code);
    downloadPref = readDownloadPref();
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

  // Which photos this device already has. Per-browser and deliberately not server state — see
  // lib/saved.ts. Only readable in the browser, so it starts empty and fills on mount.
  let saved: Set<string> = new Set();
  // Which single photo is mid-save, so its own button can say so. One at a time on purpose: the
  // button is a per-card control and two in flight would leave the second's outcome landing on a
  // card the guest has already scrolled past.
  let savingOne: string | null = null;
  async function saveOne(p: { id: string; url: string; takenAt: number; mediaType?: string }) {
    if (savingOne) return;
    savingOne = p.id;
    try {
      const stamp = new Date(p.takenAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const out = await savePhotoByUrl(p.url, `snapdini-${stamp}.${p.mediaType === 'video' ? 'mp4' : 'jpg'}`);
      // Only an outcome that actually reached the device marks the card. A cancelled share is the
      // guest's decision and says nothing; a failure must not claim they have it.
      if (out === 'shared' || out === 'downloaded') { saved = markSaved(code, [p.id]); trackPhotos(code, [p.id], 'download'); }
      else if (out === 'failed') showToast('Could not save that one', true);
    } finally { savingOne = null; }
  }

  function zipHref(ids?: string[]): string {
    const q = ids && ids.length ? `?ids=${ids.join(',')}` : '';
    return `/api/photos/${code}/download${q}`;
  }
  // Files on a phone, a zip on a desktop.
  //
  // A zip is one tidy file on a laptop and close to a dead end on a phone: you need an extractor,
  // and what comes out sits in a folder rather than the camera roll, which is where the photos were
  // wanted. So a touch device gets the actual files — shared on iOS, where that is the only route
  // into Photos, and downloaded on Android, where the gallery picks them up by itself.
  //
  // How many is too many depends on the platform, not on the number — see filesLimit().
  let bulkSaving = false;
  let bulkProgress = '';
  let bulkDone = '';
  async function saveAsFiles(list: typeof photos) {
    bulkSaving = true; bulkProgress = `0/${list.length}`;
    try {
      const items = list.map((p) => ({
        id: p.id,
        url: p.url,
        filename: `snapdini-${new Date(p.takenAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${p.id.slice(0, 6)}.${p.mediaType === 'video' ? 'mp4' : 'jpg'}`,
      }));
      const r = await saveMany(items, (pr: SaveManyProgress) => (bulkProgress = `${pr.done}/${pr.total}`));
      // Only what actually got through — a cancelled share sheet returns the batches before it,
      // not the whole list.
      if (r.savedIds.length) saved = markSaved(code, r.savedIds);
      if (r.cancelled) { showToast(r.saved ? `Stopped — ${r.saved} saved` : 'Stopped'); bulkDone = ''; }
      else {
        showToast(`${r.saved} photo${r.saved === 1 ? '' : 's'} saved`);
        // Batched saving is slow, and the toast is long gone by the time the last batch lands. The
        // button holds the answer to "did that finish?" for a few seconds.
        bulkDone = `✓ Saved ${r.saved}`;
        setTimeout(() => (bulkDone = ''), 4000);
      }
    } catch { showToast('Could not save those', true); }
    finally { bulkSaving = false; bulkProgress = ''; }
  }

  // Files or a zip: the guest's call, remembered.
  //
  // This started as a silent rule and the rule kept being wrong, because browsers do not agree on
  // what saving a file even looks like. Chrome on Android downloads a whole roll without asking.
  // Opera prompts for EVERY file, so fifty files is fifty prompts. iOS has no downloads folder at
  // all and needs the share sheet, one batch at a time. Safari, Firefox and the in-app browsers
  // each differ again. No amount of sniffing gets this right, and every wrong guess looks like the
  // button being broken.
  //
  // So we guess once, to pick which option is offered first, and then stop guessing: the choice is
  // remembered per device and the ⚙ beside the button changes it. filesLimit() still decides
  // whether to ASK before saving a big roll as files, which is a different question — on iOS that
  // is a real cost per batch, elsewhere it is not.
  //
  // zipIds undefined means "the whole event": the server then streams everything it holds rather
  // than only the page's loaded set.
  type DownloadPref = 'files' | 'zip';
  const DL_PREF = 'snap_dlmode';
  let downloadPref: DownloadPref | null = null;

  function readDownloadPref(): DownloadPref | null {
    try {
      const v = localStorage.getItem(DL_PREF);
      return v === 'files' || v === 'zip' ? v : null;
    } catch { return null; }
  }
  function writeDownloadPref(v: DownloadPref) {
    downloadPref = v;
    try { localStorage.setItem(DL_PREF, v); } catch { /* the choice just will not stick */ }
  }

  let choosing: { list: typeof photos; zipIds?: string[] } | null = null;

  function offerDownload(list: typeof photos, zipIds?: string[]) {
    // A stated preference wins outright — including "files" on a desktop, where someone may well
    // want the actual photos rather than an archive to unpack.
    if (downloadPref === 'zip') { startZip(zipIds); return; }
    if (downloadPref === 'files') {
      if (list.length <= filesLimit()) { void saveAsFiles(list); return; }
      choosing = { list, zipIds };   // still worth a word before N share sheets on iOS
      return;
    }
    // Nothing chosen yet. On a desktop a zip is right often enough to just do it; on a phone the
    // answer genuinely depends on the browser, so ask — and remember the answer.
    if (!prefersFiles()) { startZip(zipIds); return; }
    choosing = { list, zipIds };
  }
  function startZip(zipIds?: string[]) {
    choosing = null;
    showToast('Preparing your download…');
    location.href = zipHref(zipIds);
  }
  // The two chooser branches. They record the choice; startZip/saveAsFiles do not, so the code
  // paths that reach them with a preference already set do not rewrite it.
  function chooseZip() {
    const ids = choosing?.zipIds;
    writeDownloadPref('zip');
    startZip(ids);
  }
  function chooseFiles() {
    const list = choosing?.list ?? [];
    writeDownloadPref('files');
    choosing = null;
    void saveAsFiles(list);
  }
  /** Reopen the chooser deliberately, from the ⚙. Targets the same set the button would. */
  function changeDownloadMode() {
    choosing = { list: selecting && selected.size ? photos.filter((p) => selected.has(p.id)) : photos,
                 zipIds: selecting && selected.size ? [...selected] : undefined };
  }

  // ── What to download ────────────────────────────────────────────────────────
  // The same question, and the same three answers, as sharing. "Download all" meant everything on
  // screen, which quietly depends on whether Highlights happens to be toggled — so the button's
  // meaning changed with a filter elsewhere on the page. Asking is both clearer and one tap shorter
  // than finding the filter first.
  let dlScopeOpen = false;
  $: dlVideos = photos.filter((p) => p.mediaType === 'video').length;
  $: dlFavourites = photos.filter((p) => p.isHighlighted).length;

  function startDownload(list: typeof photos, ids?: string[]) {
    if (!list.length) return;
    // Counted here, not in zipHref: that builder can be evaluated during render, which would
    // record downloads that never happened.
    trackPhotos(code, list.map((p) => p.id), 'download');
    offerDownload(list, ids);
  }
  function pickDownloadScope(scope: 'all' | 'favourites' | 'select') {
    dlScopeOpen = false;
    if (scope === 'select') {
      if (!selecting) toggleSelecting();
      showToast('Pick your photos, then Download from the bar at the bottom');
      return;
    }
    startDownload(scope === 'favourites' ? photos.filter((p) => p.isHighlighted) : photos);
  }
  function downloadAll() {
    if (!allowDownloads) { showToast('Downloads are disabled for this event', true); return; }
    // Straight to it when there is nothing to choose between — a chooser whose answers are all the
    // same set is a tap that teaches nothing.
    if (!dlFavourites) { startDownload(photos); return; }
    dlScopeOpen = true;
  }
  // "All" means everything currently on screen, not everything in the event — otherwise the button
  // quietly contradicts whatever filter the viewer is looking through.
  $: allShownSelected = shownPhotos.length > 0 && shownPhotos.every((p) => selected.has(p.id));
  function toggleSelectAll() {
    selected = allShownSelected ? new Set() : new Set(shownPhotos.map((p) => p.id));
  }

  function downloadSelected() {
    if (!selected.size) return;
    startDownload(photos.filter((p) => selected.has(p.id)), [...selected]);
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
    <!-- A guest who is IN this event needs the way back, and there wasn't one. Worse, a spent roll
         is sent here with replaceState, so the browser's own Back button does not go back either —
         they were simply stranded in the album. Shown only to someone with a session for THIS
         event: a stranger opening a shared gallery link has no camera to return to. -->
    {#if guestToken && !event?.isDemo}
      <a class="btn ghost back-ev" href={`/join/${code}`}>← Back to the event</a>
    {/if}
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
        <button class="btn ghost" on:click={downloadAll} disabled={bulkSaving}>
          {bulkSaving ? `Saving ${bulkProgress}…` : bulkDone || '⬇ Download'}
        </button>
        <!-- Only once a choice has been made. Before that the chooser opens by itself, so a
             control to reopen it would be offering the thing that is about to happen anyway. -->
        {#if downloadPref}
          <button class="btn ghost dlpref" on:click={changeDownloadMode} disabled={bulkSaving}
                  title="Files or zip?" aria-label="Change how photos are downloaded">⚙</button>
        {/if}
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
      <button class="btn primary" on:click={downloadSelected} disabled={!selected.size || bulkSaving}>
        ⬇ Download{selected.size ? ` ${selected.size}` : ''}
      </button>
    </div>
  </div>
{/if}

{#if choosing}
  <!-- Deliberately not a toast: this is a fork in the road, and the person has to pick a branch
       before anything downloads. -->
  <div
    class="chooser"
    role="button"
    tabindex="-1"
    on:click|self={() => (choosing = null)}
    on:keydown={(e) => e.key === 'Escape' && (choosing = null)}
  >
    <div class="chooser-card" role="dialog" aria-modal="true" aria-labelledby="chooser-title">
      <h3 id="chooser-title">Save {choosing.list.length} photos</h3>
      <p class="chooser-sub">
        Browsers handle this differently — some save quietly, some ask about every file. Pick
        whichever works on yours; we'll remember it.
      </p>
      <button class="chooser-opt" on:click={chooseFiles}>
        <span class="chooser-opt-t">📷 Save to this device</span>
        <span class="chooser-opt-d">
          {#if isIOS()}Goes into Photos, a batch at a time — tap Save on each{:else}Lands in your
          downloads and your gallery picks them up. {choosing.list.length} separate files.{/if}
        </span>
      </button>
      <button class="chooser-opt" on:click={chooseZip}>
        <span class="chooser-opt-t">🗜 Download one zip</span>
        <span class="chooser-opt-d">A single file — quick, but you'll need an app to open it, and
          the photos won't land in your gallery.</span>
      </button>
      <button class="chooser-cancel" on:click={() => (choosing = null)}>Cancel</button>
      {#if downloadPref}
        <p class="chooser-foot">Currently set to {downloadPref === 'zip' ? 'one zip' : 'individual files'}.</p>
      {/if}
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
                   saved={saved.has(p.id)}
                   canDownload={revealed && allowDownloads && !selecting}
                   saving={savingOne === p.id}
                   tileAr={tileAspect(event?.aspectRatios)}
                   meta={`${p.participantName} · ${fmtTime(p.takenAt)}`}
                   tileLabel={selecting ? `Select photo by ${p.participantName}` : `Open photo by ${p.participantName}`}
                   on:open={() => onThumb(p, i)}
                   on:download={() => saveOne(p)}>
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

{#if dlScopeOpen}
  <ShareScope action="download" approvedCount={photos.length} favouriteCount={dlFavourites}
              videoCount={dlVideos} canSelect={true}
              on:pick={(e) => pickDownloadScope(e.detail)} on:close={() => (dlScopeOpen = false)} />
{/if}

{#if lbOpen}
  <!-- Only when the host has allowed downloads: this is everyone's album, not the guest's own roll. -->
  <Lightbox photos={shownPhotos} index={lbIndex} allowSave={allowDownloads}
            on:saved={(e) => (saved = markSaved(code, [e.detail]))}
            on:close={() => (lbOpen = false)} />
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
  /* The way back is the one thing here a stranded guest is looking for, so it does not recede. */
  .back-ev { border-color: var(--accent); color: var(--accent); }
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
  /* ── Save-or-zip chooser ── */
  .chooser {
    position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-end;
    justify-content: center; padding: 16px;
    background: color-mix(in srgb, #000 62%, transparent);
    backdrop-filter: blur(4px);
    /* It is a click-catching backdrop, not a control: no cursor or focus affordance. */
    cursor: default;
  }
  .chooser-card {
    width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px 16px 14px;
    display: flex; flex-direction: column; gap: 10px;
    /* Clear of the home bar on a phone, where the sheet sits against the bottom edge. */
    margin-bottom: env(safe-area-inset-bottom, 0);
    box-shadow: 0 -8px 40px rgb(0 0 0 / 0.5);
  }
  .chooser-card h3 { margin: 0; font-size: 1.05rem; }
  .chooser-sub { margin: 0 0 2px; color: var(--text-muted); font-size: 0.85rem; line-height: 1.4; }
  .chooser-opt {
    display: flex; flex-direction: column; gap: 3px; text-align: left; width: 100%;
    padding: 12px 14px; border-radius: var(--radius-sm); cursor: pointer;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
    font: inherit;
  }
  .chooser-opt:hover { border-color: var(--accent); }
  .chooser-opt-t { font-weight: 600; font-size: 0.95rem; }
  .chooser-opt-d { color: var(--text-muted); font-size: 0.8rem; line-height: 1.35; }
  .chooser-foot { margin: 0; text-align: center; color: var(--text-muted); font-size: 0.72rem; }
  /* Square, so it reads as an adjunct to the button beside it rather than a third action. */
  .dlpref { padding-left: 10px; padding-right: 10px; }
  .chooser-cancel {
    background: none; border: 0; color: var(--text-muted); font: inherit; padding: 8px;
    cursor: pointer;
  }
  @media (min-width: 560px) { .chooser { align-items: center; } }
  @media (prefers-reduced-motion: no-preference) {
    .chooser-card { animation: chooser-in 0.18s ease-out; }
    @keyframes chooser-in { from { transform: translateY(12px); opacity: 0; } }
  }
</style>

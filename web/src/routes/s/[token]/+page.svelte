<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { getShare, shareVisitorJoin, shareHeart, type Photo } from '$lib/events';
  import Loading from '$lib/components/Loading.svelte';
  import { applyEventTheme } from '$lib/theme';
  import { showToast } from '$lib/toast';
  import { isTransient, writeFailed } from '$lib/api';
  import { tileAspect } from '$lib/ui';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import PhotoCard from '$lib/components/PhotoCard.svelte';
  import StarIcon from '$lib/components/StarIcon.svelte';
  import DownloadIcon from '$lib/components/DownloadIcon.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import OgHead from '$lib/components/OgHead.svelte';
  import StartYourOwn from '$lib/components/StartYourOwn.svelte';
  import ShareScope from '$lib/components/ShareScope.svelte';
  import TileSizeToggle from '$lib/components/TileSizeToggle.svelte';
  import { loadTileSize, saveTileSize, tileVars, type TileSize } from '$lib/tileSize';
  import DownloadFormat from '$lib/components/DownloadFormat.svelte';
  import { saveMany, type SaveManyProgress } from '$lib/saveImage';
  import { downloadFilename, heartedPhotos, favouritesUnion, type DownloadScope } from '$lib/download';
  import { referralLink } from '$lib/referral';
  import { createRevealWatch, galleryPollBaseMs, galleryPollDelayMs, shouldPollGallery } from '$lib/revealWatch';
  import type { PageData } from './$types';

  export let data: PageData;
  const token = ($page.params as Record<string, string>).token ?? '';
  let loading = true;
  let error = '';
  let eventName = '';
  /** What the HOST called this link. A curated share is a selection with a name on it — "For the
   *  family", "Work lot" — and that name is the first thing that tells a guest which collection
   *  they have been sent. The event name still shows, underneath, because a link arriving on its own
   *  in a message needs to say which event it belongs to as well. */
  let shareLabel = '';
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

  // ── Reacting with nothing but the link ──────────────────────────────────────
  //
  // Hearts and comments are per LINK, not per event: the host decides, for this link, whether the
  // people it reaches can react at all. Both arrive false on an older API, which is the safe read.
  //
  // A visitor is deliberately not a participant — no join code, no roll, no seat against the guest
  // cap — so all we hold is a name and a token scoped to this one link. It lives in localStorage so
  // coming back to the link is coming back as yourself.
  let reactions = { hearts: false, comments: false };
  let visitorName = '';
  let visitorToken: string | null = null;
  let heartCounts: Record<string, number> = {};
  let commentCounts: Record<string, number> = {};
  let heartMine = new Set<string>();
  const VKEY = `snapdini.share.visitor.${token}`;

  // How big the cards are. Per device, not per event — see lib/tileSize.ts.
  let tileSize: TileSize = 'small';

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
    const s = await getShare(token, visitorToken);
    eventName = s.event.name;
    shareLabel = (s.label ?? '').trim();
    applyEventTheme(s.event.theme);
    allowDownloads = s.event.allowDownloads !== false;
    if (s.event.aspectRatios?.length) aspectRatios = s.event.aspectRatios;
    revealed = s.revealed;
    revealMode = s.revealMode ?? '';
    revealAt = s.revealAt ?? null;
    photoCount = s.photoCount ?? 0;
    photos = s.photos;
    reactions = s.reactions ?? { hearts: false, comments: false };
    if (s.visitor) visitorName = s.visitor.name;
    heartCounts = s.hearts ?? {};
    commentCounts = s.comments ?? {};
    heartMine = new Set(s.myHearts ?? []);
    document.title = shareLabel ? `${shareLabel} — ${eventName}` : `${eventName} — Shared photos`;
    schedulePoll();
  }

  // ── Unlocking without a reload ──────────────────────────────────────────────
  //
  // Same two mechanisms as the event gallery, and for the same reason: this page had an identical
  // display-only countdown that pinned at 00:00:00 and left the lock wall up until someone thought
  // to reload. A share carries a fixed set of photos, so there is no moderation case here — only
  // "is it open yet". See lib/revealWatch.ts for the skew pad and the retry cap.
  const revealWatch = createRevealWatch({
    attempt: async () => {
      try { await load(); } catch { return false; }
      return revealed;
    },
  });

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  function schedulePoll() {
    if (typeof document === 'undefined') return;
    clearTimeout(pollTimer);
    pollTimer = undefined;
    // No moderation arm here: a share carries a fixed, already-chosen set, so an empty revealed
    // share is empty on purpose and waiting will not change it. Only the locked state is worth
    // asking about again.
    if (!shouldPollGallery({ revealed, photoCount: photos.length })) return;
    if (document.hidden) return;   // never poll a backgrounded tab
    pollTimer = setTimeout(() => { load().catch(() => schedulePoll()); }, galleryPollDelayMs(Math.random(), galleryPollBaseMs({ revealed, revealAt, now: Date.now() })));
  }

  function onVisibility() {
    if (document.hidden) { clearTimeout(pollTimer); pollTimer = undefined; return; }
    if (!revealed) load().catch(() => schedulePoll());
  }

  // ── Who's looking ───────────────────────────────────────────────────────────
  //
  // The name is asked for at the moment it is first needed — the first heart, the first comment —
  // and never as a gate on the door. Somebody who only wants to look at the photos should never be
  // asked who they are.
  let askName = false;
  let nameDraft = '';
  let nameBusy = false;
  let nameResolve: ((t: string | null) => void) | null = null;

  /** A token, silently. Nothing shows who hearted a photo, so the only thing a name would buy on
   *  that path is nothing at all — and being asked to introduce yourself before you may tap a heart
   *  is a toll gate on the smallest gesture in the product. */
  async function ensureVisitor(): Promise<string | null> {
    if (visitorToken) return visitorToken;
    try {
      const r = await shareVisitorJoin(token, '');
      visitorToken = r.token;
      try { localStorage.setItem(VKEY, r.token); } catch { /* private mode: this session only */ }
      return r.token;
    } catch { showToast('Could not save that', true); return null; }
  }

  /** A token AND a name. Words go under a name, so this is the path that asks — at the moment it is
   *  needed, never on arrival. Resolves null if they back out, and the caller drops what it was
   *  doing. */
  function ensureNamed(): Promise<string | null> {
    if (visitorToken && visitorName) return Promise.resolve(visitorToken);
    nameDraft = visitorName;
    askName = true;
    return new Promise((resolve) => { nameResolve = resolve; });
  }

  async function submitName() {
    const name = nameDraft.trim().slice(0, 40);
    if (!name || nameBusy) return;
    nameBusy = true;
    try {
      const r = await shareVisitorJoin(token, name, visitorToken);
      visitorToken = r.token;
      visitorName = r.name;
      try { localStorage.setItem(VKEY, r.token); } catch { /* private mode: this session only */ }
      askName = false;
      nameResolve?.(r.token); nameResolve = null;
    } catch (e) { showToast(writeFailed(e, 'Could not save that name'), true); }
    finally { nameBusy = false; }
  }

  function cancelName() {
    askName = false;
    nameResolve?.(null); nameResolve = null;
  }

  async function toggleHeart(p: Photo, want: boolean) {
    const vt = visitorToken ?? await ensureVisitor();
    if (!vt) return;
    // Optimistic, because a heart has to feel instant — but only the COUNT DELTA is guessed, and the
    // server's own total replaces it the moment it answers. Guessing the total is what drifts when
    // two people press at once.
    const before = heartCounts[p.id] ?? 0;
    heartCounts = { ...heartCounts, [p.id]: Math.max(0, before + (want ? 1 : -1)) };
    const mine = new Set(heartMine);
    want ? mine.add(p.id) : mine.delete(p.id);
    heartMine = mine;
    try {
      const r = await shareHeart(token, p.id, vt, want);
      heartCounts = { ...heartCounts, [p.id]: r.hearts };
    } catch (e) {
      heartCounts = { ...heartCounts, [p.id]: before };   // put it back; nothing happened
      const undo = new Set(heartMine);
      want ? undo.delete(p.id) : undo.add(p.id);
      heartMine = undo;
      showToast(writeFailed(e, 'Could not save that'), true);
    }
  }

  /** Keep the tile's count in step with the thread just changed, rather than refetching the share. */
  function bumpComments(id: string, delta: number) {
    commentCounts = { ...commentCounts, [id]: Math.max(0, (commentCounts[id] ?? 0) + delta) };
  }


  /** A 502 during a deploy is not "this gallery is gone".
   *
   *  The load used to drop straight to a dead error page on any failure, so restarting the server
   *  left every open gallery showing a terminal message about a gallery that was fine. Transient
   *  failures now keep the loading state and retry in the background, so the page comes back on its
   *  own the moment the server does. A 404 or 403 still fails immediately — retrying a settled
   *  answer is asking the same question louder.
   *
   *  Backs off 1s, 2s, 4s… to 15s and keeps going: there is no number of attempts after which the
   *  right move is to give up on a page nobody has navigated away from.
   */
  let retrying = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryWait = 1000;
  function scheduleRetry(run: () => Promise<void>) {
    retrying = true;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { void run(); }, retryWait);
    retryWait = Math.min(retryWait * 2, 15_000);
  }

  async function firstLoad() {
    try {
      await load();
      retrying = false; retryWait = 1000; error = '';
      loading = false;
    } catch (e) {
      if (isTransient(e)) { scheduleRetry(firstLoad); return; }   // stay on the spinner
      error = e instanceof Error ? e.message : 'This share link is invalid or has expired';
      loading = false;
    }
  }

  onMount(async () => {
    // Before the first load, so the reply can come back with this visitor's own hearts already on.
    try { visitorToken = localStorage.getItem(VKEY); } catch { /* private mode */ }
    tileSize = loadTileSize();
    await firstLoad();
    document.addEventListener('visibilitychange', onVisibility);
    tick = setInterval(() => {
      now = Date.now();
      if (!revealed) revealWatch.tick(revealAt);
    }, 1000);
  });
  onDestroy(() => {
    clearInterval(tick);
    clearTimeout(pollTimer);
    revealWatch.stop();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  });

  function toggleSelecting() { selecting = !selecting; selected = new Set(); }
  $: allShownSelected = photos.length > 0 && photos.every((p) => selected.has(p.id));
  function toggleSelectAll() {
    selected = allShownSelected ? new Set() : new Set(photos.map((p) => p.id));
  }
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

  // ── What to download, then how ──────────────────────────────────────────────
  //
  // The same two questions the event gallery asks, through the same two components. This page had
  // its own smaller version: a Select button beside a Download-all button, which is two doors into
  // one room, and a download that started with no format question at all — so on a phone it either
  // dumped a zip nobody could open or opened a share sheet nobody expected, depending on the
  // browser. See lib/download.ts for why the format is asked every time.
  let dlScopeOpen = false;
  let choosing: { list: Photo[]; zipIds?: string[] } | null = null;
  $: dlVideos = photos.filter((p) => p.mediaType === 'video').length;
  $: dlFavourites = photos.filter((p) => p.isHighlighted);
  // A share carries the photo's real heart totals, so the two guest-favourite scopes mean something
  // here too — but only where the host opened this link to hearts at all.
  $: dlHearts = reactions.hearts ? heartCounts : {};
  $: dlHearted = heartedPhotos(photos, dlHearts);
  $: dlBoth = favouritesUnion(photos, dlHearts);

  function offerDownload(list: Photo[], zipIds?: string[]) {
    if (!list.length) return;
    downloaded = true;
    choosing = { list, zipIds };
  }
  function chooseZip() {
    const ids = choosing?.zipIds;
    choosing = null;
    showToast('Preparing your download…');
    location.href = dlHref(ids);
  }
  function chooseFiles() {
    const list = choosing?.list ?? [];
    choosing = null;
    void saveAsFiles(list);
  }

  // Files on a phone, a zip on a desktop — the same split the event gallery makes, and for the same
  // reason: a zip is one tidy file on a laptop and close to a dead end on a phone, where what you
  // wanted was the photos in the camera roll.
  let bulkSaving = false;
  let bulkProgress = '';
  let bulkDone = '';
  async function saveAsFiles(list: Photo[]) {
    bulkSaving = true; bulkProgress = `0/${list.length}`;
    try {
      const items = list.map((p) => ({ id: p.id, url: p.url, filename: downloadFilename(p) }));
      const r = await saveMany(items, (pr: SaveManyProgress) => (bulkProgress = `${pr.done}/${pr.total}`));
      if (r.cancelled) { showToast(r.saved ? `Stopped — ${r.saved} downloaded` : 'Stopped'); bulkDone = ''; }
      else {
        showToast(`${r.saved} photo${r.saved === 1 ? '' : 's'} downloaded`);
        // Batched saving is slow and the toast is long gone by the last batch; the button holds the
        // answer to "did that finish?" for a few seconds.
        bulkDone = `✓ Downloaded ${r.saved}`;
        setTimeout(() => (bulkDone = ''), 4000);
      }
    } catch { showToast('Could not save those', true); }
    finally { bulkSaving = false; bulkProgress = ''; }
  }

  function downloadAll() {
    if (!allowDownloads) { showToast('Downloads are disabled for this share', true); return; }
    // Nothing to choose between with a single photo — a chooser whose answers are all the same set
    // is a tap that teaches nothing.
    if (photos.length <= 1) { offerDownload(photos); return; }
    dlScopeOpen = true;
  }
  function pickDownloadScope(scope: DownloadScope) {
    dlScopeOpen = false;
    if (scope === 'select') {
      if (!selecting) toggleSelecting();
      showToast('Pick your photos, then Download from the bar at the top');
      return;
    }
    const subset =
      scope === 'favourites' ? dlFavourites
      : scope === 'hearts' ? dlHearted
      : scope === 'both' ? dlBoth
      : null;
    // Only 'all' may go without ids, and it must: the server then resolves the share's own set
    // rather than whatever this page happens to have loaded. Every other scope names itself, or the
    // zip comes back holding the whole share and quietly undoes the choice.
    if (!subset) { offerDownload(photos); return; }
    offerDownload(subset, subset.map((p) => p.id));
  }
  function downloadSelected() {
    if (!selected.size) return;
    offerDownload(photos.filter((p) => selected.has(p.id)), [...selected]);
  }
</script>

<svelte:head><title>Shared photos — Snapdini</title></svelte:head>
<OgHead og={data?.og} />

<main>
  <!-- Same bar as the review screen: brand on the left, the EVENT centred, controls on the right.
       The album's own name used to live up here as the page's h1, which made the title a piece of
       navigation — it belongs in the page, over the photos it names. -->
  <header>
    <a class="brand" href="/"><Logo /></a>
    {#if eventName}<div class="hd-name" title={eventName}>{eventName}</div>{/if}
    <!-- No separate Select button. Selecting exists only to choose what to download, and Download
         already asks that as its first question ("Pick them myself") — so a second control beside
         it was a different door into the same room. Leaving select mode lives in the select bar,
         with the rest of it. Same call the event gallery made. -->
    {#if revealed && photos.length}
      <div class="actions">
        <TileSizeToggle bind:size={tileSize} on:change={(e) => saveTileSize(e.detail)} />
        {#if allowDownloads && !selecting}
          <button class="btn ghost" on:click={downloadAll} disabled={bulkSaving}>
            {#if bulkSaving}Saving {bulkProgress}…{:else if bulkDone}{bulkDone}{:else}<DownloadIcon /> Download{/if}
          </button>
        {/if}
      </div>
    {/if}
  </header>

  {#if selecting}
    <!-- Its own bar rather than more buttons in the header: it has room to say how many are picked,
         and the header already wraps on a phone. -->
    <div class="selbar">
      <span class="selcount">{selected.size} selected</span>
      <div class="selactions">
        <button class="btn ghost" on:click={toggleSelectAll}>
          {allShownSelected ? 'Clear' : `Select all${photos.length ? ` (${photos.length})` : ''}`}
        </button>
        <button class="btn ghost" on:click={toggleSelecting}>Cancel</button>
        <button class="btn primary" on:click={downloadSelected} disabled={!selected.size || bulkSaving}>
          <DownloadIcon /> Download{selected.size ? ` ${selected.size}` : ''}
        </button>
      </div>
    </div>
  {/if}

  {#if !loading && !error}
    <div class="album">
      <h1>{shareLabel || eventName}</h1>
      {#if shareLabel && eventName}<p class="from">from {eventName}</p>{/if}
    </div>
  {/if}

  {#if loading}
    <Loading />
  {:else if error}
    <div class="state"><span class="big">🔗</span><p>{error}</p></div>
  {:else if !revealed}
    <div class="reveal-wall">
      <span class="lock" aria-hidden="true">🔒</span>
      <p class="msg">{modeText(revealMode)}</p>
      {#if revealMode === 'at_end' && revealAt}
        <!-- At zero the page is already asking the server (after a short pad for clock skew). A
             counter frozen at 00:00:00 is what made this look broken. -->
        <div class="countdown" aria-live="polite">{remaining > 0 ? countdown : 'Unlocking…'}</div>
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
         style={`--tile-ar:${tileAspect(aspectRatios)};${tileVars(tileSize)}`}>
      {#each photos as p, i (p.id)}
        <PhotoCard photo={p} selected={selecting && selected.has(p.id)}
                   selectable={selecting}
                   hearts={reactions.hearts ? (heartCounts[p.id] ?? 0) : undefined}
                   hearted={heartMine.has(p.id)}
                   canHeart={reactions.hearts && !selecting}
                   comments={reactions.comments ? (commentCounts[p.id] ?? 0) : undefined}
                   on:heart={(e) => toggleHeart(p, e.detail)}
                   tileAr={tileAspect(aspectRatios)}
                   tileLabel={`Photo by ${p.participantName}`}
                   on:open={() => onThumb(p, i)}>
          <svelte:fragment slot="tile">
            <!-- Top-RIGHT. The top-left corner belongs to the heart, and with reactions on this
                 star was sitting on top of it. In select mode it steps aside for the tick rather
                 than disappearing — see `.star.aside`. -->
            {#if p.isHighlighted}
              <span class="star" class:aside={selecting} title="The host's favourite"><StarIcon filled size={17} /></span>
            {/if}
            <!-- No tick here: PhotoCard draws it from `selectable`/`selected`, and this was a
                 second one landing in the same corner. See the note beside it in PhotoCard.svelte. -->
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

{#if dlScopeOpen}
  <!-- Two pick events, one question — the dispatcher in ShareScope.svelte says why the hearts
       scopes travel separately. Both land in the same handler. -->
  <ShareScope action="download" voice="guest" approvedCount={photos.length}
              favouriteCount={dlFavourites.length}
              heartedCount={dlHearted.length} bothCount={dlBoth.length}
              videoCount={dlVideos} canSelect={true}
              on:pick={(e) => pickDownloadScope(e.detail)}
              on:pickHearts={(e) => pickDownloadScope(e.detail)}
              on:close={() => (dlScopeOpen = false)} />
{/if}

{#if choosing}
  <DownloadFormat count={choosing.list.length}
                  on:pick={(e) => (e.detail === 'zip' ? chooseZip() : chooseFiles())}
                  on:close={() => (choosing = null)} />
{/if}

{#if lbOpen}
  <Lightbox photos={photos} index={lbIndex} allowSave={allowDownloads}
            commentsOn={reactions.comments}
            hearts={reactions.hearts ? (heartCounts[photos[lbIndex]?.id ?? ''] ?? 0) : undefined}
            hearted={heartMine.has(photos[lbIndex]?.id ?? '')}
            canHeart={reactions.hearts}
            on:heart={(e) => { const p = photos[lbIndex]; if (p) void toggleHeart(p, e.detail); }}
            shareToken={token} {visitorToken} {ensureVisitor} {ensureNamed}
            on:commented={(e) => bumpComments(e.detail.id, e.detail.delta)}
            on:photochange={(e) => (lbIndex = e.detail)}
            on:close={() => (lbOpen = false)} />
{/if}

<!-- Asked once, at the first heart or the first comment — never on arrival. -->
{#if askName}
  <div class="name-scrim" role="presentation" on:click|self={cancelName}>
    <div class="name-box" role="dialog" aria-modal="true" aria-label="Your name">
      <h2>What's your name?</h2>
      <p>So everyone knows whose heart{reactions.comments ? ' and whose words' : ''} this is.</p>
      <form on:submit|preventDefault={submitName}>
        <!-- svelte-ignore a11y-autofocus -->
        <input bind:value={nameDraft} maxlength="40" autofocus
               placeholder="Your name" aria-label="Your name" />
        <div class="name-actions">
          <button type="button" class="btn ghost" on:click={cancelName}>Not now</button>
          <button type="submit" class="btn primary" disabled={nameBusy || !nameDraft.trim()}>
            {nameBusy ? '…' : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  main { min-height: 100dvh; background: var(--bg); color: var(--text); }
  /* 1fr auto 1fr keeps the event name optically centred in the bar whatever sits either side of
     it — the same three-column bar the review screen uses. */
  header { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px;
    padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; text-decoration: none; color: var(--text); }
  .hd-name { font-weight: 800; font-size: 0.95rem; text-align: center; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .actions { grid-column: 3; display: flex; gap: 8px; justify-content: flex-end; }
  .selbar { display: flex; align-items: center; justify-content: space-between; gap: 10px;
    flex-wrap: wrap; padding: 10px 18px; border-bottom: 1px solid var(--border); }
  .selcount { font-size: .85rem; font-weight: 700; color: var(--text-muted); }
  .selactions { display: flex; gap: 8px; flex-wrap: wrap; }
  @media (max-width: 480px) {
    .selbar { justify-content: stretch; }
    .selactions { flex: 1; }
    .selactions .btn { flex: 1; }
  }
  /* Narrow: the controls keep the top row and the event name drops to its own, still centred —
     rather than being hidden, which is what the review screen can afford and a shared link cannot. */
  @media (max-width: 560px) {
    header { grid-template-columns: auto 1fr; row-gap: 10px; }
    .actions { grid-column: 2; grid-row: 1; }
    .hd-name { grid-column: 1 / -1; grid-row: 2; white-space: normal; overflow-wrap: anywhere; }
  }
  /* The album's own title, over the photos it names. */
  .album { text-align: center; padding: 26px 18px 4px; }
  .album h1 { margin: 0; font-size: clamp(1.3rem, 4.5vw, 1.9rem); overflow-wrap: anywhere; text-wrap: balance; }
  .from { margin: 5px 0 0; font-size: 0.82rem; color: var(--text-muted); overflow-wrap: anywhere; }
  .name-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 320;
    display: flex; align-items: center; justify-content: center; padding: 18px; }
  .name-box { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 22px; width: min(400px, 100%); }
  .name-box h2 { margin: 0 0 4px; font-size: 1.1rem; }
  .name-box p { margin: 0 0 14px; font-size: .85rem; color: var(--text-muted); }
  .name-box input { width: 100%; padding: 10px 12px; border-radius: var(--radius-sm); font-size: 1rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  .name-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 7px 14px; font-size: .82rem;
    border: 1px solid transparent; cursor: pointer; }
  .btn.ghost { border-color: var(--border); color: var(--text); background: transparent; }
  .btn.ghost:hover { border-color: var(--accent); }
  .btn.primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
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
  /* The same flush corner wash the heart wears, mirrored — see the note on `.heart` in
     PhotoCard.svelte. A floating dark circle was a second visual language for the same idea. */
  .star { position: absolute; top: 0; right: 0; padding: 9px 9px 13px 16px; line-height: 1;
    display: flex; align-items: center; justify-content: center; color: var(--accent);
    background: radial-gradient(ellipse 135% 135% at 100% 0%,
      rgba(0,0,0,0.58) 0%, rgba(0,0,0,0.34) 46%, rgba(0,0,0,0) 74%);
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.55)); }
  /* Select mode: the tick owns the corner, so the star steps just inside it rather than vanishing.
     Hiding it meant a host picking photos could not see which ones they had already starred — the
     one thing most likely to drive the picking. Same seat and same treatment as `.fav-flag` on the
     review screen: no wash under it, because the tick's own dark chip is right beside it doing the
     contrast work a second one would only muddy. */
  .star.aside { top: 9px; right: 34px; padding: 0; background: none;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.75)); }

  footer { text-align: center; font-size: 0.78rem; color: var(--text-muted); padding: 28px 18px; }
  footer a { color: var(--text-muted); }
  footer a:hover { color: var(--accent); }
</style>

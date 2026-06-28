<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    getAdmin, getPhotosByOrganizer, ratePhoto, moderate, setHighlights, createShare, mediaMeta,
    type Photo, type AdminEvent, type ShareKind
  } from '$lib/events';
  import { applyEventTheme } from '$lib/theme';
  import { getAdminCode, saveAdminCode } from '$lib/session';
  import { showToast, showSuccess } from '$lib/toast';
  import { imgFallback, hidePoster } from '$lib/ui';
  import SlideshowPanel from '$lib/components/SlideshowPanel.svelte';
  import ShareModal from '$lib/components/ShareModal.svelte';

  // The share popup — opened after creating any share (filter or selection).
  let shareModal: { id: string; kind: ShareKind; label: string; slug: string | null; url: string; count: number | null } | null = null;
  async function openShare(kind: ShareKind, photoIds?: string[]) {
    busy = true;
    try {
      const r = await createShare(code, orgCode, kind, photoIds);
      shareModal = { id: r.token, kind: r.kind, label: r.label, slug: r.slug, url: r.url, count: photoIds ? photoIds.length : null };
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not create share', true); }
    finally { busy = false; }
  }

  const code = $page.params.code ?? '';

  // ── State ────────────────────────────────────────────────────────────────
  let orgCode = '';
  let booting = true;
  let ev: AdminEvent | null = null;
  let photos: Photo[] = [];

  type ViewMode = 'cards' | 'single' | 'slideshow';
  let view: ViewMode = 'cards';

  type Tab = 'pending' | 'all' | 'favourites' | 'rejected';
  let tab: Tab = 'all';

  let singleIndex = 0;

  // Selection (multi-select with shift-range), and the two-click reject confirm.
  let selecting = false;
  let selected = new Set<string>();
  let lastSelIndex = -1;
  let confirmRejectId: string | null = null;
  let busy = false;

  // ── Resolve organizer code: URL hash → ?code= → localStorage. ──────────────
  function resolveOrgCode(): string {
    const hash = (location.hash || '').slice(1);
    if (hash) { try { return decodeURIComponent(hash); } catch { return hash; } }
    const q = new URLSearchParams(location.search).get('code');
    if (q) return q;
    return getAdminCode(code);
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  onMount(async () => {
    orgCode = resolveOrgCode();
    if (!orgCode) { goto('/admin/' + code); return; }
    try {
      ev = await getAdmin(code, orgCode);
      // Cache the code, then strip it from the address bar so the secret doesn't linger in the URL.
      saveAdminCode(code, orgCode);
      // Returning from the $1 branding-removal checkout — celebrate + clean the URL.
      if (new URLSearchParams(location.search).get('brandingpaid') === '1') {
        showSuccess('Add-on unlocked — you can now generate a slideshow with no Snapdini frames 🎬');
        view = 'slideshow';
      }
      if (location.hash || location.search) history.replaceState(null, '', location.pathname);
      document.title = `${ev.name} — Review — Snapdini`;
      applyEventTheme(ev.theme);
      await loadPhotos();
      tab = pendingCount > 0 ? 'pending' : 'all';
    } catch {
      goto('/admin/' + code);
      return;
    }
    booting = false;
  });

  async function loadPhotos() {
    try {
      const data = await getPhotosByOrganizer(code, orgCode);
      photos = data.photos ?? [];
    } catch {
      showToast('Could not load photos', true);
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  $: pendingCount = photos.filter((p) => p.status === 'pending').length;
  $: rejectedCount = photos.filter((p) => p.status === 'rejected').length;
  // The Pending tab + per-photo Approve only matter when moderation is ON (otherwise pending = live).
  $: moderationOn = !!(ev && ev.moderationEnabled);
  $: showPendingTab = moderationOn && pendingCount > 0;

  $: filtered = (() => {
    if (tab === 'pending') return photos.filter((p) => p.status === 'pending');
    if (tab === 'rejected') return photos.filter((p) => p.status === 'rejected');
    if (tab === 'favourites') return photos.filter((p) => p.rating >= 5 && p.status !== 'rejected');
    return photos.filter((p) => p.status !== 'rejected');   // "All" = everything not binned
  })();

  $: if (filtered.length && singleIndex > filtered.length - 1) singleIndex = filtered.length - 1;
  $: current = filtered[singleIndex] ?? null;
  $: if (tab === 'pending' && !showPendingTab) tab = 'all';
  $: selectedCount = selected.size;

  const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtFull = (ts: number) => new Date(ts).toLocaleString();
  const backHref = () => `/admin/${code}#${encodeURIComponent(orgCode)}`;

  // ── Favourite (separate from approval) ───────────────────────────────────────
  async function setRating(photo: Photo, next: number) {
    const prev = photo.rating;
    if (next === prev) return;
    photo.rating = next; photos = photos;
    try {
      const res = await ratePhoto(code, orgCode, photo.id, next);
      photo.rating = res.rating; photo.isHighlighted = res.isHighlighted;
      photos = photos;
    } catch (e) {
      photo.rating = prev; photos = photos;
      showToast(e instanceof Error ? e.message : 'Failed', true);
    }
  }
  const onFavouriteClick = (photo: Photo) => setRating(photo, photo.rating >= 5 ? 0 : 5);

  // ── Moderation ───────────────────────────────────────────────────────────────
  async function approve(photo: Photo) {
    try {
      await moderate(code, orgCode, [photo.id], 'approve');
      photo.status = 'approved'; photos = photos;
      showSuccess('Approved');
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed', true); }
  }

  // Reject is a two-click confirm: first click arms (shows "Sure?"), second confirms. A click
  // anywhere else (window handler) resets the armed state.
  function requestReject(photo: Photo, e?: Event) {
    e?.stopPropagation();
    if (confirmRejectId === photo.id) { confirmRejectId = null; reject(photo); }
    else confirmRejectId = photo.id;
  }
  function resetRejectConfirm() { if (confirmRejectId) confirmRejectId = null; }

  async function reject(photo: Photo) {
    const prev = photo.status;
    photo.status = 'rejected'; photos = photos;
    try {
      await moderate(code, orgCode, [photo.id], 'reject');
      if (view === 'single' && !filtered.length) view = 'cards';
      else if (view === 'single' && singleIndex > filtered.length - 1) singleIndex = Math.max(0, filtered.length - 1);
    } catch (e) {
      photo.status = prev; photos = photos;
      showToast(e instanceof Error ? e.message : 'Failed', true);
    }
  }

  async function restore(photo: Photo) {
    // Un-reject → back to 'pending' (not straight to approved): under moderation it re-enters the
    // queue so the Approve button reappears; with moderation off 'pending' is already visible.
    const prev = photo.status;
    photo.status = 'pending'; photos = photos;
    try { await moderate(code, orgCode, [photo.id], 'restore'); }
    catch (e) { photo.status = prev; photos = photos; showToast(e instanceof Error ? e.message : 'Failed', true); }
  }

  // ── Selection ────────────────────────────────────────────────────────────────
  function toggleSelecting() {
    selecting = !selecting;
    if (!selecting) { selected = new Set(); lastSelIndex = -1; }
  }
  function onCardClick(p: Photo, i: number, e: MouseEvent) {
    if (!selecting) { openSingle(i); return; }
    if (e.shiftKey && lastSelIndex >= 0) {
      const [a, b] = [lastSelIndex, i].sort((x, y) => x - y);
      for (let k = a; k <= b; k++) selected.add(filtered[k].id);
    } else {
      if (selected.has(p.id)) selected.delete(p.id); else selected.add(p.id);
      lastSelIndex = i;
    }
    selected = selected;
  }
  const selectAll = () => { selected = new Set(filtered.map((p) => p.id)); };
  const selectFavourites = () => { selected = new Set(filtered.filter((p) => p.rating >= 5).map((p) => p.id)); };
  const clearSelection = () => { selected = new Set(); lastSelIndex = -1; };
  const selectedPhotos = () => filtered.filter((p) => selected.has(p.id));

  // ── Download ─────────────────────────────────────────────────────────────────
  async function downloadOne(url: string, name: string) {
    const res = await fetch(url); const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
  }
  async function downloadSelected() {
    const sel = selectedPhotos();
    if (!sel.length) return;
    busy = true;
    try {
      if (sel.length === 1) {
        const p = sel[0]; const ext = p.mediaType === 'video' ? 'mp4' : 'jpg';
        await downloadOne(p.url, `${p.participantName || 'photo'}.${ext}`);
      } else {
        const ids = sel.map((p) => p.id).join(',');
        const res = await fetch(`/api/photos/${code}/download?ids=${encodeURIComponent(ids)}`, { headers: { 'X-Organizer-Code': orgCode } });
        if (!res.ok) throw new Error('Download failed');
        const blob = await res.blob(); const href = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = href; a.download = `${ev?.name || 'event'}.zip`;
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
      }
    } catch (e) { showToast(e instanceof Error ? e.message : 'Download failed', true); }
    finally { busy = false; }
  }

  // ── Bulk curation ──────────────────────────────────────────────────────────
  async function bulkModerate(action: 'approve' | 'reject') {
    const ids = [...selected]; if (!ids.length) return;
    busy = true;
    try {
      await moderate(code, orgCode, ids, action);
      const st = action === 'approve' ? 'approved' : 'rejected';
      photos = photos.map((p) => selected.has(p.id) ? { ...p, status: st } : p);
      clearSelection();
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed', true); }
    finally { busy = false; }
  }
  async function bulkFavourite() {
    const ids = [...selected]; if (!ids.length) return;
    busy = true;
    try {
      await setHighlights(code, orgCode, ids, true);
      photos = photos.map((p) => selected.has(p.id) ? { ...p, rating: 5, isHighlighted: true } : p);
      clearSelection();
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed', true); }
    finally { busy = false; }
  }

  // ── Share ────────────────────────────────────────────────────────────────────
  // Share the CURRENT filter — the whole gallery, or the favourites if that tab is active.
  function shareGallery() { openShare(tab === 'favourites' ? 'favourites' : 'all'); }
  function shareSelected() { const ids = [...selected]; if (ids.length) openShare('selected', ids); }
  // Share just the photo currently open in the single view (no need to enter Select mode).
  function shareOne(photo: Photo) { openShare('selected', [photo.id]); }

  // ── View / navigation ────────────────────────────────────────────────────────
  function openSingle(i: number) { singleIndex = i; view = 'single'; history.pushState({ sv: true }, ''); }
  function closeSingle() { if (history.state?.sv) history.back(); else view = 'cards'; }
  function onPopState() { if (view === 'single') view = 'cards'; }
  function prev() { if (filtered.length) singleIndex = (singleIndex - 1 + filtered.length) % filtered.length; }
  function next() { if (filtered.length) singleIndex = (singleIndex + 1) % filtered.length; }
  let fsOpen = false;   // full-screen view of the current photo/video (works on desktop + mobile)
  function onKeydown(e: KeyboardEvent) {
    if (view !== 'single') return;
    if (e.key === 'Escape' && fsOpen) { fsOpen = false; return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
  }
  function setTab(t: Tab) { tab = t; singleIndex = 0; clearSelection(); }
</script>

<svelte:head><title>Review — Snapdini</title></svelte:head>
<svelte:window on:keydown={onKeydown} on:popstate={onPopState} on:click={resetRejectConfirm} />

{#if booting}
  <div class="state">Loading…</div>
{:else if ev}
  <!-- ── Header ── -->
  <header class="hd">
    <a class="back" href={backHref()}>← Manage</a>
    <div class="hd-name" title={ev.name}>{ev.name}</div>
    <div class="vtoggle">
      <button class="vbtn" class:active={view === 'cards'} on:click={() => (view = 'cards')}>Cards</button>
      <button class="vbtn" class:active={view === 'single'} on:click={() => (view = 'single')} disabled={!filtered.length}>Single</button>
    </div>
    <button class="ss-btn" class:active={view === 'slideshow'} on:click={() => (view = view === 'slideshow' ? 'cards' : 'slideshow')}>🎬 Slideshow</button>
  </header>

  <!-- ── Filter tabs + actions (hidden in the slideshow view) ── -->
  {#if view !== 'slideshow'}
  <nav class="tabs">
    {#if showPendingTab}
      <button class="tab" class:active={tab === 'pending'} on:click={() => setTab('pending')}>Pending ({pendingCount})</button>
    {/if}
    <button class="tab" class:active={tab === 'all'} on:click={() => setTab('all')}>All</button>
    <button class="tab" class:active={tab === 'favourites'} on:click={() => setTab('favourites')}>★ Favourites</button>
    {#if rejectedCount > 0}
      <button class="tab" class:active={tab === 'rejected'} on:click={() => setTab('rejected')}>🗑 Rejected ({rejectedCount})</button>
    {/if}
    <span class="tab-spacer"></span>
    {#if tab === 'all' || tab === 'favourites'}
      <button class="tab ghost-tab" on:click={shareGallery} disabled={busy} title="Share what's shown">📤 Share {tab === 'favourites' ? 'favourites' : 'gallery'}</button>
    {/if}
    {#if view !== 'single'}<button class="tab ghost-tab" class:active={selecting} on:click={toggleSelecting}>{selecting ? 'Done' : '☑ Select'}</button>{/if}
  </nav>

  {#if selecting}
    <div class="selbar">
      <span class="selcount">{selectedCount} selected</span>
      <button class="lnk" on:click={selectAll}>All</button>
      <button class="lnk" on:click={selectFavourites}>★ Favs</button>
      {#if selectedCount}<button class="lnk" on:click={clearSelection}>Clear</button>{/if}
      <span class="tab-spacer"></span>
      <button class="btn ghost sm" on:click={downloadSelected} disabled={!selectedCount || busy}>⬇ Download</button>
      <button class="btn ghost sm" on:click={shareSelected} disabled={!selectedCount || busy}>📤 Share</button>
      <button class="btn ghost sm" on:click={bulkFavourite} disabled={!selectedCount || busy}>★ Favourite</button>
      {#if moderationOn}<button class="btn ghost sm" on:click={() => bulkModerate('approve')} disabled={!selectedCount || busy}>✓ Approve</button>{/if}
      <button class="btn danger sm" on:click={() => bulkModerate('reject')} disabled={!selectedCount || busy}>✕ Reject</button>
    </div>
  {/if}
  {/if}

  {#if view === 'slideshow'}
    <div class="ss-wrap"><SlideshowPanel {code} {orgCode} hasPhotos={photos.length > 0} /></div>
  {:else if !photos.length}
    <div class="state">No photos yet</div>
  {:else if !filtered.length}
    <div class="state">Nothing here</div>
  {:else if view === 'cards'}
    <!-- ── Cards view ── -->
    <div class="grid">
      {#each filtered as p, i (p.id)}
        <div class="card" class:sel={selecting && selected.has(p.id)}>
          <div class="thumb-wrap">
            <button class="thumb" on:click={(e) => onCardClick(p, i, e)} aria-label={selecting ? 'Select photo' : 'Open photo'}>
              {#if p.mediaType === 'video'}
                <img src={p.thumbUrl} alt="" loading="lazy" on:error={hidePoster} />
                <div class="play">▶</div>
              {:else}
                <img src={p.thumbUrl ?? p.url} alt="" loading="lazy" on:error={(e) => imgFallback(e, p.url)} />
              {/if}
              {#if p.status === 'pending' && moderationOn}<div class="pending-badge">Pending</div>{/if}
              {#if p.status === 'approved' && moderationOn}<div class="ok-badge" title="Approved">✓</div>{/if}
              {#if selecting && p.rating >= 5}<span class="fav-flag" title="Favourite">★</span>{/if}
              {#if selecting}<span class="check" class:on={selected.has(p.id)}>{selected.has(p.id) ? '✓' : ''}</span>{/if}
            </button>
            {#if !selecting}
              <button class="fav-corner" class:on={p.rating >= 5} on:click={() => onFavouriteClick(p)} aria-label="Favourite">{p.rating >= 5 ? '★' : '☆'}</button>
            {/if}
          </div>

          <div class="meta">{p.participantName} · {fmtTime(p.takenAt)}</div>
          {#if mediaMeta(p)}<div class="media-meta">{p.mediaType === 'video' ? '🎥' : '🖼'} {mediaMeta(p)}</div>{/if}

          {#if !selecting}
            <div class="mod">
              {#if p.status === 'rejected'}
                <button class="btn ghost sm grow" on:click={() => restore(p)}>↩ Restore</button>
              {:else}
                {#if p.status === 'pending' && moderationOn}<button class="btn primary sm grow" on:click={() => approve(p)}>✓ Approve</button>{/if}
                <button class="btn danger sm grow" class:armed={confirmRejectId === p.id} on:click={(e) => requestReject(p, e)}>
                  {confirmRejectId === p.id ? 'Sure?' : '✕ Reject'}
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else if current}
    <!-- ── Single view (condensed) ── -->
    <div class="single">
      <div class="stage">
        <button class="nav prev" on:click={prev} aria-label="Previous">‹</button>
        {#if current.mediaType === 'video'}
          <video class="big" src={current.url} controls preload="metadata" muted playsinline></video>
        {:else}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
          <img class="big" src={current.url} alt="" decoding="async" on:click={() => (fsOpen = true)} />
        {/if}
        <button class="fs-btn" on:click={() => (fsOpen = true)} title="Full screen" aria-label="Full screen">⛶</button>
        <button class="nav next" on:click={next} aria-label="Next">›</button>
      </div>

      <div class="single-bar">
        <div class="srow">
          <span class="counter">{singleIndex + 1} / {filtered.length}</span>
          <button class="star" class:on={current.rating >= 5} on:click={() => onFavouriteClick(current)} aria-label="Favourite">{current.rating >= 5 ? '★' : '☆'}</button>
          <span class="single-meta">{current.participantName} · {fmtFull(current.takenAt)}{#if mediaMeta(current)} · {mediaMeta(current)}{/if}</span>
        </div>
        <div class="srow">
          {#if current.status === 'rejected'}
            <button class="btn ghost sm grow" on:click={() => restore(current)}>↩ Restore</button>
          {:else}
            {#if current.status === 'pending' && moderationOn}<button class="btn primary sm grow" on:click={() => approve(current)}>✓ Approve</button>{/if}
            <button class="btn danger sm grow" class:armed={confirmRejectId === current.id} on:click={(e) => requestReject(current, e)}>{confirmRejectId === current.id ? 'Sure?' : '✕ Reject'}</button>
          {/if}
          <button class="btn ghost sm grow" on:click={() => shareOne(current)} disabled={busy}>📤 Share</button>
          <button class="btn ghost sm grow" on:click={() => downloadOne(current.url, `${current.participantName || 'photo'}.${current.mediaType === 'video' ? 'mp4' : 'jpg'}`)}>⬇</button>
        </div>
      </div>
    </div>
  {/if}
{/if}

{#if fsOpen && current}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="fs" on:click={() => (fsOpen = false)} role="dialog" aria-modal="true" aria-label="Full screen photo">
    <button class="fs-x" on:click={() => (fsOpen = false)} aria-label="Close">✕</button>
    {#if filtered.length > 1}
      <button class="fs-nav prev" on:click|stopPropagation={prev} aria-label="Previous">‹</button>
      <button class="fs-nav next" on:click|stopPropagation={next} aria-label="Next">›</button>
    {/if}
    {#if current.mediaType === 'video'}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
      <video class="fs-media" src={current.url} controls autoplay playsinline on:click|stopPropagation></video>
    {:else}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
      <img class="fs-media" src={current.url} alt="" on:click|stopPropagation />
    {/if}
  </div>
{/if}

{#if shareModal}
  <ShareModal {code} {orgCode} share={shareModal} on:close={() => (shareModal = null)} />
{/if}

<style>
  .state { text-align: center; padding: 60px 16px; color: var(--text-muted); }

  .hd { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .back { text-decoration: none; color: var(--text); font-weight: 700; font-size: 0.85rem; white-space: nowrap; }
  .back:hover { color: var(--accent); }
  .hd-name { flex: 1; font-weight: 800; font-size: 0.95rem; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vtoggle { display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; flex-shrink: 0; }
  .vbtn { background: transparent; color: var(--text-muted); border: none; padding: 8px 12px; min-height: 40px; font: inherit; font-size: 0.8rem; font-weight: 700; cursor: pointer; }
  .vbtn.active { background: var(--accent); color: var(--accent-ink, #111); }
  .vbtn:disabled { opacity: 0.4; cursor: default; }
  .ss-btn { flex-shrink: 0; min-height: 40px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: transparent; color: var(--text); font: inherit; font-size: 0.8rem; font-weight: 700; cursor: pointer; white-space: nowrap; }
  .ss-btn:hover { border-color: var(--accent); }
  .ss-btn.active { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }

  .tabs { display: flex; align-items: center; gap: 6px; padding: 12px 16px; max-width: 980px; margin: 0 auto; flex-wrap: wrap; }
  .tab { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 20px; padding: 7px 14px; min-height: 40px; font: inherit; font-size: 0.82rem; font-weight: 700; cursor: pointer; }
  .tab.active { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  .tab:disabled { opacity: 0.5; cursor: default; }
  .ghost-tab { background: transparent; }
  .tab-spacer { flex: 1; }

  .selbar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; max-width: 980px; margin: 0 auto 14px; flex-wrap: wrap;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .selcount { font-size: 0.82rem; font-weight: 700; }
  .lnk { background: none; border: none; color: var(--accent); font: inherit; font-size: 0.8rem; font-weight: 700; cursor: pointer; padding: 4px; }

  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 10px 18px; font-size: 0.9rem; border: 1px solid transparent; cursor: pointer; text-decoration: none; font: inherit; text-align: center; min-height: 40px; }
  .btn.sm { padding: 9px 14px; font-size: 0.82rem; }
  .primary { background: var(--accent); color: var(--accent-ink, #111); }
  .ghost { border-color: var(--border); color: var(--text); background: transparent; }
  .ghost:hover { border-color: var(--accent); }
  .danger { background: var(--danger); color: #fff; }
  .danger.armed { background: #fff; color: var(--danger); border-color: var(--danger); }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .grow { flex: 1; }

  .ss-wrap { max-width: 560px; margin: 0 auto; padding: 12px 16px 80px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; max-width: 980px; margin: 0 auto; padding: 0 16px 80px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; }
  .card.sel { outline: 3px solid var(--accent); outline-offset: -3px; }
  .thumb-wrap { position: relative; }
  .thumb { position: relative; display: block; width: 100%; padding: 0; border: none; background: var(--surface-2); cursor: pointer; line-height: 0; }
  .fav-corner { position: absolute; top: 6px; right: 6px; width: 38px; height: 38px; border-radius: 50%; border: none; cursor: pointer; font-size: 1.15rem; line-height: 1; color: #fff; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); }
  .fav-corner.on { color: var(--accent); }
  .check { position: absolute; bottom: 6px; right: 6px; width: 26px; height: 26px; border-radius: 50%; background: rgba(0,0,0,.5); border: 2px solid #fff; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; font-weight: 800; }
  .check.on { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  .thumb img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
  .play { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 1.6rem; color: #fff; text-shadow: 0 2px 8px rgba(0,0,0,.6); pointer-events: none; }
  .pending-badge { position: absolute; top: 6px; left: 6px; font-size: 0.62rem; font-weight: 800; background: rgba(0,0,0,.6); color: #fff; padding: 3px 8px; border-radius: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  /* Approved tick (bottom-left) — clear at a glance which photos are live under moderation. */
  .ok-badge { position: absolute; bottom: 6px; left: 6px; width: 22px; height: 22px; border-radius: 50%; background: var(--success, #2ecc71); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
  /* Static favourite marker shown while selecting — same top-right corner + chip as the favourite
     button, so favourites read consistently and the select checkbox moves to the bottom corner. */
  .fav-flag { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 0.85rem; line-height: 1;
    color: var(--accent); background: rgba(0,0,0,.5); box-shadow: 0 1px 4px rgba(0,0,0,.4); }

  .meta { font-size: 0.7rem; color: var(--text-muted); padding: 8px 10px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .media-meta { font-size: 0.64rem; color: var(--text-muted); font-family: var(--font-mono); padding: 2px 10px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.85; }
  .mod { display: flex; gap: 6px; padding: 8px; flex-wrap: nowrap; }
  /* Keep mod-button labels on one line so a narrow (2-button) row never grows taller than a
     single-button row — cards stay the same height regardless of how many actions show. Tighter
     horizontal padding so "✓ Approve" + "✕ Reject" fit comfortably side by side in a card. */
  .mod .btn { white-space: nowrap; min-width: 0; padding-left: 6px; padding-right: 6px; }
  .star { background: none; border: none; padding: 4px; font-size: 1.4rem; line-height: 1; cursor: pointer; color: var(--text-muted); min-width: 44px; min-height: 44px; }
  .star.on { color: var(--accent); }

  /* Single view — condensed: two tidy rows instead of a tall stack. */
  .single { max-width: 980px; margin: 0 auto; padding-bottom: 24px; }
  .stage { position: relative; display: flex; align-items: center; justify-content: center; background: #000; min-height: 40dvh; }
  /* Fit the media so the action bar stays on-screen without vertical scrolling. */
  .big { max-width: 100%; max-height: min(70dvh, calc(100dvh - 250px)); object-fit: contain; display: block; cursor: zoom-in; }
  .fs-btn { position: absolute; top: 10px; right: 10px; width: 38px; height: 38px; border: none; border-radius: 8px;
    background: rgba(0,0,0,.5); color: #fff; font-size: 1.05rem; cursor: pointer; opacity: 0; transition: opacity .15s; }
  .stage:hover .fs-btn { opacity: 1; }
  @media (hover: none) { .fs-btn { opacity: .9; } }   /* touch devices: always visible */
  /* Full-screen viewer (CSS overlay — works on desktop + mobile, unlike the Fullscreen API on iOS). */
  .fs { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,.94); display: flex; align-items: center; justify-content: center; }
  .fs-media { max-width: 100vw; max-height: 100dvh; object-fit: contain; }
  .fs-x { position: absolute; top: 14px; right: 16px; width: 42px; height: 42px; border: none; border-radius: 50%; background: rgba(255,255,255,.15); color: #fff; font-size: 1.1rem; cursor: pointer; z-index: 2; }
  .fs-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 54px; height: 80px; border: none; background: rgba(255,255,255,.12); color: #fff; font-size: 2.4rem; line-height: 1; cursor: pointer; z-index: 2; }
  .fs-nav.prev { left: 0; } .fs-nav.next { right: 0; }
  .nav { position: absolute; top: 50%; transform: translateY(-50%); width: 44px; height: 64px; background: rgba(0,0,0,.4); color: #fff; border: none; font-size: 2rem; cursor: pointer; line-height: 1; }
  .nav.prev { left: 0; } .nav.next { right: 0; }
  .nav:hover { background: rgba(0,0,0,.65); }
  .single-bar { display: flex; flex-direction: column; gap: 8px; padding: 10px 14px; }
  .srow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .counter { font-size: 0.82rem; color: var(--text-muted); font-weight: 700; white-space: nowrap; }
  .single-meta { flex: 1; font-size: 0.76rem; color: var(--text-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  @media (min-width: 640px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  }
</style>

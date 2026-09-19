<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { replaceState, pushState } from '$app/navigation';
  import { goto } from '$app/navigation';
  import {
    getAdmin, getPhotosByOrganizer, ratePhoto, moderate, createShare, mediaMeta,
    savePhotoCaption, CAPTION_MAX, clampCaption, captionLength, captionRemaining,
    type Photo, type AdminEvent, type ShareKind, getHearts,
    getWords, deleteComment, type HostWord } from '$lib/events';
  import { applyEventTheme } from '$lib/theme';
  import Loading from '$lib/components/Loading.svelte';
  import { getAdminCode, saveAdminCode } from '$lib/session';
  import { api } from '$lib/api';
  import { firePurchase, purchaseTracked } from '$lib/adtracking';
  import { showToast, showSuccess } from '$lib/toast';
  import { tileAspect } from '$lib/ui';
  import { reviewEmptyState } from '$lib/reviewEmpty';
  import StarIcon from '$lib/components/StarIcon.svelte';
  import HeartIcon from '$lib/components/HeartIcon.svelte';
  import { sortPhotos, type PhotoSort } from '$lib/photoSort';
  import PhotoCard from '$lib/components/PhotoCard.svelte';
  import DownloadIcon from '$lib/components/DownloadIcon.svelte';
  import ShareScope from '$lib/components/ShareScope.svelte';
  import SlideshowPanel from '$lib/components/SlideshowPanel.svelte';
  import ShareModal from '$lib/components/ShareModal.svelte';

  // The share popup — opened after creating any share (filter or selection).
  let shareModal: { id: string; kind: ShareKind; label: string; slug: string | null; url: string; count: number | null;
                    heartsEnabled?: boolean; commentsEnabled?: boolean } | null = null;
  async function openShare(kind: ShareKind, photoIds?: string[]) {
    busy = true;
    try {
      const r = await createShare(code, orgCode, kind, photoIds);
      shareModal = { id: r.token, kind: r.kind, label: r.label, slug: r.slug, url: r.url,
                     count: photoIds ? photoIds.length : null,
                     // A reused link comes back with the switches it already had — the dialog must
                     // open showing THAT, not a fresh pair of offs.
                     heartsEnabled: r.heartsEnabled, commentsEnabled: r.commentsEnabled };
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not create share', true); }
    finally { busy = false; }
  }

  const code = $page.params.code ?? '';

  // ── State ────────────────────────────────────────────────────────────────
  let orgCode = '';
  let booting = true;
  let ev: AdminEvent | null = null;
  let photos: Photo[] = [];

  type ViewMode = 'cards' | 'single' | 'slideshow' | 'words';
  // ?view=slideshow lets the post-event email drop the host straight on the slideshow panel instead
  // of on a page where they still have to find it. Read once, at init, so it seeds the view without
  // fighting the buttons afterwards.
  let view: ViewMode = (typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('view') === 'slideshow') ? 'slideshow' : 'cards';

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
      // Returning from the branding-removal checkout — celebrate, fire the purchase conversion, clean the URL.
      const sp = new URLSearchParams(location.search);
      if (sp.get('brandingpaid') === '1') {
        showSuccess('Add-on unlocked — you can now generate a slideshow with no Snapdini frames 🎬');
        view = 'slideshow';
        const sid = sp.get('session_id');
        if (sid && purchaseTracked($page.data)) {
          try {
            const s = await api<{ paid: boolean; amountTotalCents: number; currency: string; transactionId: string }>(
              '/api/billing/session/' + encodeURIComponent(sid),
            );
            if (s?.paid) {
              firePurchase($page.data, {
                amountTotalCents: s.amountTotalCents,
                currency: s.currency,
                transactionId: s.transactionId,
              });
            }
          } catch { /* conversion is best-effort */ }
        }
      }
      // Get the organizer code out of the address bar — it is a bearer credential — but keep the
      // rest of the query. This used to drop the whole search string with a RAW history call, which
      // did two bad things: it threw away ?who= (the view filter a host had just clicked through
      // to), and it desynced SvelteKit's history so a later Back changed the URL without changing
      // the page. SvelteKit's replaceState keeps the router's bookkeeping intact.
      {
        const u = new URL(location.href);
        u.hash = '';
        u.searchParams.delete('code');
        const clean = u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '');
        if (clean !== location.pathname + location.search + location.hash) replaceState(clean, {});
      }
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
      void loadHearts();   // counts ride alongside, and never hold the grid up
    } catch {
      showToast('Could not load photos', true);
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  $: pendingCount = photos.filter((p) => p.status === 'pending').length;
  // For the share chooser: what each scope would actually contain.
  //
  // Two things this has to get right, and the first version got both wrong.
  // 1. VISIBILITY follows the server's rule, which is not one rule: with moderation on only
  //    'approved' is visible, with it off anything not rejected is. Counting `!== 'rejected'`
  //    either way overstated a moderated event by however many were still pending.
  // 2. VIDEOS are not photos. The slideshow reports 71 where this reported 92 for the same event —
  //    both correct, counting different things — so the wording says what is actually in there
  //    rather than calling 21 clips "photos".
  const shareVisible = (p: Photo) => (moderationOn ? p.status === 'approved' : p.status !== 'rejected');
  $: shareSet = photos.filter(shareVisible);
  $: approvedCount = shareSet.length;
  $: shareVideos = shareSet.filter((p) => p.mediaType === 'video').length;
  $: favouriteCount = shareSet.filter((p) => p.rating >= 5).length;
  $: rejectedCount = photos.filter((p) => p.status === 'rejected').length;
  // The Pending tab + per-photo Approve only matter when moderation is ON (otherwise pending = live).
  $: moderationOn = !!(ev && ev.moderationEnabled);
  $: showPendingTab = moderationOn && pendingCount > 0;

  // Optional shooter filter, arrived at from the Participants card on the manage page (?who=<id>).
  // A host looking for "the ones Nan took" was otherwise scrolling the whole event.
  // A set, because "show me what Nan and Grandad shot" is a normal thing to want and picking one
  // guest at a time makes you do the comparison in your head. Carried in the URL as a comma list
  // so a filtered view is still a link you can send someone.
  let whoSet = new Set(($page.url.searchParams.get('who') ?? '').split(',').filter(Boolean));
  $: whoNames = [...whoSet]
    .map((id) => photos.find((p) => p.participantId === id)?.participantName)
    .filter(Boolean) as string[];
  // SvelteKit's replaceState, NOT the raw History API. Calling history.replaceState directly
  // bypasses SvelteKit's history bookkeeping, and the next Back press then changed the URL without
  // changing the page — you ended up on /admin/<code> still looking at the review screen.
  function syncWho() {
    whoSet = new Set(whoSet);                 // tell Svelte the set changed
    const u = new URL(window.location.href);
    const list = [...whoSet].join(',');
    if (list) u.searchParams.set('who', list); else u.searchParams.delete('who');
    replaceState(u.pathname + u.search + u.hash, {});
  }
  function toggleWho(id: string) {
    whoSet.has(id) ? whoSet.delete(id) : whoSet.add(id);
    syncWho();
  }
  /** Clearing the filter CLOSES the menu, unlike ticking a guest in it.
   *
   *  The two are different acts. Ticking guests is a list you build up — the menu has to stay open
   *  or every tick costs a reopen. "Show everyone" is the end of that job: there is nothing left in
   *  the menu to do afterwards, and leaving it open makes the host dismiss a panel that is already
   *  finished with. */
  function clearWho() { whoSet.clear(); syncWho(); whoOpen = false; }

  // A <details> stays open until its summary is clicked again, which is a trap on a menu — you
  // click away expecting it gone and it follows you down the page. Close on any press outside it,
  // and on Escape.
  let whoMenuEl: HTMLDetailsElement;
  let whoOpen = false;
  const closeWhoOnOutside = (e: Event) => {
    if (whoOpen && whoMenuEl && !whoMenuEl.contains(e.target as Node)) whoOpen = false;
  };


  // Built from the photos themselves, so it only ever lists guests who actually shot something —
  // picking a name that yields an empty screen is not a useful option.
  $: shooters = [...new Map(photos.map((p) => [p.participantId, p.participantName])).entries()]
    .map(([id, name]) => ({ id, name: name || 'Unknown', n: photos.filter((x) => x.participantId === id).length }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));

  $: byWho = whoSet.size ? photos.filter((p) => whoSet.has(p.participantId)) : photos;
  let sort: PhotoSort = 'newest';
  $: anyHearts = !!ev?.heartsEnabled && Object.values(heartCounts).some((n) => n > 0);
  $: if (!anyHearts) sort = 'newest';
  $: filtered = sortPhotos((() => {
    if (tab === 'pending') return byWho.filter((p) => p.status === 'pending');
    if (tab === 'rejected') return byWho.filter((p) => p.status === 'rejected');
    if (tab === 'favourites') return byWho.filter((p) => p.rating >= 5 && p.status !== 'rejected');
    return byWho.filter((p) => p.status !== 'rejected');   // "All" = everything not binned
  })(), sort, heartCounts);

  $: if (filtered.length && singleIndex > filtered.length - 1) singleIndex = filtered.length - 1;
  $: current = filtered[singleIndex] ?? null;
  $: if (tab === 'pending' && !showPendingTab) tab = 'all';
  $: selectedCount = selected.size;

  const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  /** Time alone cannot place a line in a list that spans days, so the date joins it once it is not
   *  today — and the year once it is not this year. */
  function fmtWhen(ts: number): string {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime(ts);
    const sameYear = d.getFullYear() === now.getFullYear();
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })}, ${fmtTime(ts)}`;
  }
  const fmtFull = (ts: number) => new Date(ts).toLocaleString();
  const backHref = () => `/admin/${code}#${encodeURIComponent(orgCode)}`;

  /** The copy and the next action for an empty review screen — see reviewEmpty.ts, which is where
   *  the rule and its tests live. The page's only job is to hand it what it knows and format the
   *  start time in the event's own timezone. */
  $: emptyState = reviewEmptyState(ev && {
    isExpired: ev.isExpired,
    isUpcoming: ev.isUpcoming,
    participantCount: ev.participantCount,
    startsAtLabel: new Date(ev.startsAt).toLocaleString([], {
      timeZone: ev.timezone || undefined, dateStyle: 'medium', timeStyle: 'short',
    }),
  });

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

  // ── Captions ────────────────────────────────────────────────────────────
  // ── Captions & comments, in one list ───────────────────────────────────────
  //
  // The caption editor opens ONE photo at a time, which is right for writing and useless for
  // reading: a host who wants to know what has been written on their event had nowhere to look, and
  // guest comments had no host-facing surface at all. Now they do, both kinds together, newest
  // first, each with the photo it sits on and a way to take it off.
  let words: HostWord[] = [];
  let wordsLoaded = false;
  let wordsBusy = false;
  let wordsCapped = false;
  let wordTotal = 0;
  let wordKind: 'all' | 'caption' | 'comment' = 'all';
  /** Newest first by default — this is a moderation feed, and the thing a host is looking for is
   *  what somebody just wrote. Most loved is the other question it can answer. */
  let wordSort: 'newest' | 'loved' = 'newest';
  let wordSel = new Set<string>();
  /** Which row's Remove is armed — one at a time, so a second row cannot be half-armed behind the
   *  first. Cleared by any reload of the list. */
  let confirmWord: string | null = null;
  const wordKey = (w: HostWord) => `${w.kind}:${w.id}`;
  /** Words on REJECTED photos are their own view, not part of the main list.
   *
   *  They were mixed in and merely dimmed, which is the worst of both: a greyed row reads as broken
   *  rather than as deliberate, and it is asking the host to moderate a comment on a photo that is
   *  in nobody's gallery. The same call the photo tabs make — Rejected is a tab, not a shade. */
  let showRejected = false;
  const isGone = (w: HostWord) => w.status === 'rejected';
  $: liveWords = words.filter((w) => showRejected === isGone(w));
  $: rejectedCount2 = words.filter(isGone).length;
  $: filteredWords = wordKind === 'all' ? liveWords : liveWords.filter((w) => w.kind === wordKind);
  // Never in place: `words` is the server's order, and sorting it would make "newest" mean whatever
  // the last sort left behind.
  $: shownWords = wordSort === 'loved'
    ? [...filteredWords].sort((a, b) => (b.hearts ?? 0) - (a.hearts ?? 0))
    : filteredWords;
  $: anyWordHearts = words.some((w) => (w.hearts ?? 0) > 0);
  $: captionCount = liveWords.filter((w) => w.kind === 'caption').length;
  $: commentCount = liveWords.filter((w) => w.kind === 'comment').length;

  async function loadWords() {
    wordsBusy = true;
    try {
      const r = await getWords(code, orgCode);
      words = r.words; wordTotal = r.total; wordsCapped = r.capped;
      confirmWord = null;
      // Anything selected that is no longer in the list has been dealt with by someone else.
      const live = new Set(words.map(wordKey));
      wordSel = new Set([...wordSel].filter((k) => live.has(k)));
      wordsLoaded = true;
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not load that', true); }
    finally { wordsBusy = false; }
  }

  function openWords() {
    view = 'words';
    if (!wordsLoaded) void loadWords();
  }

  function toggleWord(w: HostWord) {
    const next = new Set(wordSel);
    const k = wordKey(w);
    next.has(k) ? next.delete(k) : next.add(k);
    wordSel = next;
  }
  function selectAllWords() {
    wordSel = wordSel.size === shownWords.length ? new Set() : new Set(shownWords.map(wordKey));
  }

  /** Remove ONE written line. Two kinds, two owners: a caption is cleared by saving an empty one
   *  (the same call the caption editor makes), a comment is deleted outright. Both already take the
   *  organizer code, so neither needed a new endpoint. */
  async function removeWord(w: HostWord) {
    if (w.kind === 'caption') {
      await savePhotoCaption(w.photoId, '', { organizerCode: orgCode });
      // Keep the cards view honest without a refetch — it is showing the same caption.
      const hit = photos.find((p) => p.id === w.photoId);
      if (hit) { hit.caption = null; photos = photos; }
    } else {
      await deleteComment(w.id, { organizerCode: orgCode });
    }
  }

  async function removeOne(w: HostWord) {
    if (wordsBusy) return;
    wordsBusy = true;
    try {
      await removeWord(w);
      words = words.filter((x) => wordKey(x) !== wordKey(w));
      confirmWord = null;
      wordTotal = Math.max(0, wordTotal - 1);
      showSuccess(w.kind === 'caption' ? 'Caption removed' : 'Comment removed');
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not remove that', true); }
    finally { wordsBusy = false; }
  }

  async function removeSelected() {
    if (wordsBusy || !wordSel.size) return;
    const targets = words.filter((w) => wordSel.has(wordKey(w)));
    if (!confirm(`Remove ${targets.length} ${targets.length === 1 ? 'line' : 'lines'}? This cannot be undone.`)) return;
    wordsBusy = true;
    let gone = 0;
    const failed: string[] = [];
    try {
      // One at a time and counted, so a partial failure reports what actually happened rather than
      // claiming the whole batch either worked or did not.
      for (const w of targets) {
        try { await removeWord(w); gone++; }
        catch { failed.push(wordKey(w)); }
      }
      const done = new Set(targets.map(wordKey).filter((k) => !failed.includes(k)));
      words = words.filter((w) => !done.has(wordKey(w)));
      wordTotal = Math.max(0, wordTotal - gone);
      wordSel = new Set(failed);
      if (failed.length) showToast(`Removed ${gone}; ${failed.length} could not be removed`, true);
      else showSuccess(`Removed ${gone}`);
    } finally { wordsBusy = false; }
  }

  // The host writes, edits and clears captions on ANY photo in their event, exactly as the guest
  // who took it can on their own. Captions carry no author label anywhere in the product, so a
  // host-written line reads the same as a guest's — intended: the caption is about the photo.
  let captionFor: Photo | null = null;
  let captionDraft = '';
  // Enforced here as well as via maxlength — see clampCaption() for why the attribute alone is
  // not enough on a phone. Reactive so it holds however the value arrives: typing, paste, or IME.
  $: if (captionLength(captionDraft) > CAPTION_MAX) captionDraft = clampCaption(captionDraft);
  let captionBusy = false;

  /** What the room loved, on the screen where the host decides what to keep.
   *
   *  The review grid is the one place a host picks favourites, and it was the one gallery with no
   *  idea which photos the guests had already picked out. Counts only — a host is not a guest and
   *  does not get a vote from here (the endpoint attributes a heart to a participant, and the host
   *  reviewing is not one). Read once on load and after a refresh, like every other count here. */
  let heartCounts: Record<string, number> = {};
  async function loadHearts() {
    if (!ev?.heartsEnabled) { heartCounts = {}; return; }
    try { heartCounts = (await getHearts(code)).hearts; }
    catch { /* counts are decoration on this screen — never block the review grid for them */ }
  }

  function openCaption(photo: Photo, e?: Event) {
    // The window click handler that disarms a Reject also fires on this one; stop it here so the
    // modal does not open with a stale "Sure?" still armed behind it.
    e?.stopPropagation();
    captionFor = photo;
    captionDraft = photo.caption ?? '';
  }

  async function saveCaption() {
    if (!captionFor || captionBusy) return;
    const target = captionFor;
    captionBusy = true;
    try {
      const r = await savePhotoCaption(target.id, captionDraft, { organizerCode: orgCode });
      // What the server STORED, not the draft — it collapses whitespace and cuts at CAPTION_MAX,
      // so echoing the draft would show a caption the gallery is not going to show.
      target.caption = r.caption; photos = photos;
      captionFor = null;
      showSuccess(r.caption ? 'Caption saved' : 'Caption removed');
      // The list is showing this very line; without this it would keep showing the old wording.
      if (wordsLoaded) void loadWords();
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not save that caption', true); }
    finally { captionBusy = false; }
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
  /** WHY you are selecting, which decides what the bar offers.
   *
   *  Picking photos is one tool serving two unrelated jobs, and showing both sets of actions at once
   *  made the bar a menu of everything the screen can do rather than a finish line for the thing you
   *  started. Worse, the two are opposites: a host working a moderation queue is one mis-aimed tap
   *  from emailing a link to photos they have not approved yet.
   *
   *  'files' covers Download and Share together — both are "pick some photos, then do something with
   *  those files". 'moderate' is Approve and Reject. */
  type SelectIntent = 'files' | 'moderate';
  let selectIntent: SelectIntent = 'files';

  function startSelecting(intent: SelectIntent) {
    selectIntent = intent;
    if (!selecting) toggleSelecting();
    clearSelection();
  }

  /** Into select mode with the queue in front of them. Two halves that always belong together: the
   *  Pending tab, because approving a photo that is already approved is a no-op the host cannot
   *  see, and select mode, because that is where the batch buttons live. */
  function startModerating() {
    if (tab !== 'pending') setTab('pending');
    startSelecting('moderate');
  }

  /* Selecting is a CARDS-view activity — the tick lives on the tile, and the batch buttons act on
     tiles. Carrying a moderation selection into the single view, the captions list or the slideshow
     left the bulk bar hanging over a screen with nothing to tick, and a half-built selection
     outliving the job it was built for is how the wrong photos get approved. */
  $: if (view !== 'cards' && selecting) toggleSelecting();

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
  function downloadSelected() { return downloadSet(selectedPhotos()); }

  /** Download a set of photos: one saves as itself, several as a zip.
   *
   *  Takes the list rather than reading the selection, because the header's Download offers scopes
   *  (everything / favourites / pick them myself) and only the last of those IS a selection. Same
   *  request either way, so the zip a host gets from "Everything" and the one they get from picking
   *  by hand are built by the same line of code. */
  async function downloadSet(sel: Photo[]) {
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

  // ── Share ────────────────────────────────────────────────────────────────────
  // ONE button, which asks. It used to share "whatever tab you are on" — the gallery from All, the
  // favourites from Favourites — and a separate button shared a selection. Three behaviours behind
  // one word, and the only clue which you would get was which tab happened to be underlined.
  let scopeOpen = false;
  let dlScopeOpen = false;
  /** The download half of the same chooser. `new` cannot arrive: it means "only the ones I have not
   *  saved on THIS device", which is a guest's idea about their own roll — the host's review screen
   *  keeps no such record, so the option is not offered (newCount stays 0). */
  function pickDownloadScope(scope: 'all' | 'favourites' | 'select' | 'new') {
    dlScopeOpen = false;
    if (scope === 'select') {
      startSelecting('files');
      showToast('Pick your photos, then Download from the bar at the bottom');
      return;
    }
    const list = scope === 'favourites' ? filtered.filter((p) => p.rating >= 5) : filtered;
    void downloadSet(list);
  }

  function pickScope(scope: 'all' | 'favourites' | 'select' | 'new') {
    // 'new' is a DOWNLOAD scope (see ShareScope). Sharing has no such axis — a link is a query the
    // recipient resolves, not a set of files this device has or has not got — so it cannot arrive
    // here; it is in the type only because one component serves both verbs.
    if (scope === 'new') return;
    scopeOpen = false;
    if (scope === 'select') {
      // Not a share yet: it hands them the tool and the selection bar finishes the job.
      startSelecting('files');
      showToast('Pick your photos, then Share from the bar at the bottom');
      return;
    }
    openShare(scope);
  }
  function shareSelected() { const ids = [...selected]; if (ids.length) openShare('selected', ids); }
  // Share just the photo currently open in the single view (no need to enter Select mode).
  function shareOne(photo: Photo) { openShare('selected', [photo.id]); }

  // ── View / navigation ────────────────────────────────────────────────────────
  // SvelteKit's shallow-routing pushState, not the raw History API. A raw pushState creates a
  // history entry the router has no record of; popping it left the URL on /admin/<code> while the
  // review screen stayed on screen. $page.state is how SvelteKit tracks the same idea.
  /** State FIRST, then the view — the order is the whole function.
   *
   *  The guard below mirrors `$page.state.sv` back into `view`, so it undoes any single-view entry
   *  that is not already backed by a history entry. Setting the view first and pushing second left
   *  a window where Svelte could flush the guard against the OLD state and bounce straight back to
   *  Cards. It never showed up from a card, because that path arrives on a timer (the double-tap
   *  window) and so runs in its own flush after the state has settled — which is exactly why the
   *  header's Single button appeared broken while opening a photo worked. */
  function openSingle(i: number) { singleIndex = i; pushState('', { sv: true }); view = 'single'; }
  function closeSingle() { if ($page.state.sv) history.back(); else view = 'cards'; }
  /** Back out of the single view. The window listener is the whole mechanism — see <svelte:window>.
   *
   *  There used to be a reactive statement here as well, reading the shallow-routing state off the
   *  page store and forcing the view back to Cards whenever it was absent. It said the same thing
   *  this listener says, and it raced. `$page.state` does not update synchronously with
   *  pushState, so the flush that followed entering the single view could read the OLD state and
   *  bounce straight back to Cards — which is why the header's Single button did nothing at all,
   *  while opening a photo worked purely because that path arrives on a timer (the double-tap
   *  window) and lands in a later flush. A control that works or not depending on which flush it
   *  happens to run in is a control nobody can debug from the outside. One mechanism, one place. */
  function onPopState() { if (view === 'single') view = 'cards'; }
  function prev() { if (filtered.length) singleIndex = (singleIndex - 1 + filtered.length) % filtered.length; }
  function next() { if (filtered.length) singleIndex = (singleIndex + 1) % filtered.length; }
  let fsOpen = false;   // full-screen view of the current photo/video (works on desktop + mobile)
  function onKeydown(e: KeyboardEvent) {
    // The caption editor owns the keyboard while it is open: in Single view the arrow keys page
    // through photos, which would otherwise move the album out from under a half-typed caption.
    if (captionFor) { if (e.key === 'Escape') captionFor = null; return; }
    // Escape closes the guest filter wherever you are — it is a menu, not part of the photo view.
    if (e.key === 'Escape' && whoOpen) { whoOpen = false; return; }
    if (view !== 'single') return;
    if (e.key === 'Escape' && fsOpen) { fsOpen = false; return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
  }
  function setTab(t: Tab) { tab = t; singleIndex = 0; clearSelection(); }
  // Leaving the sort engaged while its control is disabled would order the bin by hearts with
  // nothing on screen saying so — the state has to go with the control.
  $: if (tab === 'rejected' && sort === 'hearted') sort = 'newest';
  const tabLabel = (t: Tab) =>
    t === 'pending' ? 'Pending' : t === 'favourites' ? 'Favourites' : t === 'rejected' ? 'Rejected' : 'All';
</script>

<svelte:head><title>Review — Snapdini</title></svelte:head>
{#if dlScopeOpen}
  <ShareScope action="download" {approvedCount} {favouriteCount} videoCount={shareVideos}
              canSelect={view !== 'single'}
              on:pick={(e) => pickDownloadScope(e.detail)} on:close={() => (dlScopeOpen = false)} />
{/if}

{#if scopeOpen}
  <ShareScope action="share" {approvedCount} {favouriteCount} videoCount={shareVideos} canSelect={view !== 'single'}
              on:pick={(e) => pickScope(e.detail)} on:close={() => (scopeOpen = false)} />
{/if}

<svelte:window on:keydown={onKeydown} on:popstate={onPopState} on:click={resetRejectConfirm}
               on:pointerdown={closeWhoOnOutside} />

{#if booting}
  <Loading />
{:else if ev}
  <!-- ── Header ── -->
  <header class="hd">
    <!-- Two ways back, and in the single view they mean different places.
         `closeSingle` was written and then never wired to anything, so the only exits from a single
         photo were the browser's Back and the Cards toggle — and the nearest thing that LOOKED like
         a back button, "← Manage", left the review screen entirely. Reaching for it and landing on
         the admin page is the reported experience, and it was the only back-shaped control there.
         Now the contextual one comes first and says where it goes; Manage stays, unchanged, and no
         longer has to pretend to be two things. -->
    <div class="hd-side">
      {#if view === 'single'}
        <button class="back" on:click={closeSingle}>← Photos</button>
        <a class="back quiet" href={backHref()}>Manage</a>
      {:else}
        <a class="back" href={backHref()}>← Manage</a>
      {/if}
    </div>
    <div class="hd-name" title={ev.name}>{ev.name}</div>
    <div class="hd-side right">
      <div class="vtoggle">
        <!-- Through closeSingle, so leaving by this button pops the history entry that entering
             pushed. Setting the view directly left it stranded, and the next Back then went
             nowhere the host could see. -->
        <button class="vbtn" class:active={view === 'cards'} on:click={() => (view === 'single' ? closeSingle() : (view = 'cards'))}>Cards</button>
        <!-- Disabled with no explanation is a puzzle: it is off because THIS TAB has no photos, and
             nothing on screen said so. It says so now, and on a tab that can never fill (Rejected,
             with nothing rejected) it is simply not drawn — a control that can only apologise. -->
        <!-- openSingle, never a bare view assignment. Entering the single view has two halves: the view
             and the history entry that Back pops to leave it. This button only ever did the first,
             so the guard below — which exists to mirror that history state back into the view —
             saw no `sv` state and flipped it straight back to Cards on the same tick. The button
             could never work; opening a card could, because that path goes through openSingle.
             One entry point, so the two halves cannot come apart again. -->
        <button class="vbtn" class:active={view === 'single'} on:click={() => openSingle(singleIndex)}
                disabled={!filtered.length}
                title={filtered.length ? 'One photo at a time' : `Nothing in ${tabLabel(tab)} to look through yet`}>Single</button>
      </div>
      <!-- Its own mode rather than another filter tab: the tabs choose which PHOTOS are on screen,
           and this is not a view of photos. -->
      <button class="ss-btn" class:active={view === 'words'}
              on:click={() => (view === 'words' ? (view = 'cards') : openWords())}
              title="Read and remove captions and comments">💬 <span class="ss-lbl">Captions &amp; comments</span></button>
      <button class="ss-btn" class:active={view === 'slideshow'} on:click={() => (view = view === 'slideshow' ? 'cards' : 'slideshow')}>🎬 <span class="ss-lbl">Slideshow</span></button>
    </div>
  </header>

  <!-- ── Filter tabs + actions (hidden in the slideshow view) ── -->
  {#if view !== 'slideshow' && view !== 'words'}
  <nav class="tabs">
    {#if showPendingTab}
      <button class="tab" class:active={tab === 'pending'} on:click={() => setTab('pending')}>Pending ({pendingCount})</button>
    {/if}
    <button class="tab" class:active={tab === 'all'} on:click={() => setTab('all')}>All</button>
    <button class="tab" class:active={tab === 'favourites'} on:click={() => setTab('favourites')}>★ Favourites</button>
    {#if rejectedCount > 0}
      <button class="tab" class:active={tab === 'rejected'} on:click={() => setTab('rejected')}>🗑️ Rejected ({rejectedCount})</button>
    {/if}
    {#if anyHearts}
      <!-- A SORT, not a tab: it reorders whichever tab is open rather than being one of them, so it
           carries the toggled state (`on`) the who-filter uses and not the tab's `active`. Shown
           only once something has actually been hearted — a control that sorts nothing reads as
           broken. -->
      <!-- Off in the bin. Ordering rejected photos by how loved they are is a question nobody has,
           and the counts there belong to photos that are not in anyone's gallery. Disabled rather
           than hidden, with the reason on the control, so a host who was sorting a moment ago can
           see where it went. -->
      <button class="tab" class:on={sort === 'hearted'} disabled={tab === 'rejected'}
              on:click={() => (sort = sort === 'hearted' ? 'newest' : 'hearted')}
              title={tab === 'rejected' ? 'Not for the bin — rejected photos are not in anyone\'s gallery' : 'Sort by how many hearts each photo has'}
              aria-pressed={sort === 'hearted'}>Most loved</button>
    {/if}
    {#if shooters.length > 1}
      <!-- Checkbox list rather than a <select>: multiple guests at once, and you can see who is on
           without opening anything. Arriving from the Participants card pre-ticks one. -->
      <details class="who-menu" bind:this={whoMenuEl} bind:open={whoOpen}>
        <summary class="tab" class:on={whoSet.size > 0}>
          👤 {whoSet.size === 0 ? 'Everyone' : whoSet.size === 1 ? (whoNames[0] ?? '1 guest') : `${whoSet.size} guests`}
        </summary>
        <div class="who-pop">
          {#each shooters as sh}
            <label class="who-opt">
              <input type="checkbox" checked={whoSet.has(sh.id)} on:change={() => toggleWho(sh.id)} />
              <span class="who-nm">{sh.name}</span><span class="who-n">{sh.n}</span>
            </label>
          {/each}
          {#if whoSet.size}
            <button class="who-clear" on:click={clearWho}>Show everyone</button>
          {/if}
        </div>
      </details>
    {/if}
    <span class="tab-spacer"></span>
    <!-- Always here, and always the same word, whichever tab is showing. -->
    {#if photos.length}
      <button class="tab ghost-tab" on:click={() => (scopeOpen = true)} disabled={busy} title="Share photos">📤 Share</button>
    {/if}
    <!-- Moderation gets its own door, and only when moderation is ON. Selecting is reachable through
         Download's "pick them myself", but a host working through a queue of pending shots is not
         downloading anything — making them go in via Download to approve a batch is the wrong
         question in front of the right tool. Straight into select mode, pre-filtered to Pending,
         which is the only tab the batch actually means anything on. -->
    {#if moderationOn && pendingCount > 0 && view !== 'single'}
      <button class="tab ghost-tab" class:active={selecting && tab === 'pending'}
              on:click={startModerating} disabled={busy}
              title="Approve or reject several at once">✓ Moderate ({pendingCount})</button>
    {/if}
    <!-- DOWNLOAD, not Select. Select is a tool, not an intention: a host presses it because they
         want some of the photos, and then has to work out that picking is only step one. Download
         asks the question they actually have — which ones? — and "pick them myself" is one of the
         answers, which turns selecting on. Exactly what the event gallery does, for the same reason.
         While selecting it becomes Done, because then the tool IS on screen and turning it off is
         the only thing the control can usefully mean. -->
    {#if view !== 'single'}
      {#if selecting}
        <button class="tab ghost-tab active" on:click={toggleSelecting}>Done</button>
      {:else if photos.length}
        <button class="tab ghost-tab" on:click={() => (dlScopeOpen = true)} disabled={busy}
                title="Download photos"><DownloadIcon size={15} /> Download</button>
      {/if}
    {/if}
  </nav>

  {#if selecting}
    <div class="selbar">
      <span class="selcount">
        {selectIntent === 'moderate' ? 'Moderating' : 'Selecting'} · {selectedCount} selected
      </span>
      <button class="lnk" on:click={selectAll}>All</button>
      <button class="lnk" on:click={selectFavourites}>★ Faves</button>
      {#if selectedCount}<button class="lnk" on:click={clearSelection}>Clear</button>{/if}
      <span class="tab-spacer"></span>
      {#if selectIntent === 'moderate'}
        <button class="btn primary sm" on:click={() => bulkModerate('approve')} disabled={!selectedCount || busy}>✓ Approve{selectedCount ? ` ${selectedCount}` : ''}</button>
        <button class="btn danger sm" on:click={() => bulkModerate('reject')} disabled={!selectedCount || busy}>✕ Reject{selectedCount ? ` ${selectedCount}` : ''}</button>
      {:else}
        <button class="btn ghost sm" on:click={downloadSelected} disabled={!selectedCount || busy}><DownloadIcon /> Download</button>
        <button class="btn ghost sm" on:click={shareSelected} disabled={!selectedCount || busy}>📤 Share</button>
      {/if}
    </div>
  {/if}
  {/if}

  {#if view === 'words'}
    <div class="words">
      <div class="w-bar">
        <div class="w-filters">
          <button class="tab" class:active={wordKind === 'all'} on:click={() => (wordKind = 'all')}>All ({liveWords.length})</button>
          <button class="tab" class:active={wordKind === 'caption'} on:click={() => (wordKind = 'caption')}>Captions ({captionCount})</button>
          <button class="tab" class:active={wordKind === 'comment'} on:click={() => (wordKind = 'comment')}>Comments ({commentCount})</button>
          {#if rejectedCount2 > 0}
            <!-- Its own view, off by default. Kept reachable rather than dropped: a host who has
                 just rejected a photo may well want to see what was said on it. -->
            <button class="tab" class:active={showRejected}
                    on:click={() => { showRejected = !showRejected; wordSel = new Set(); confirmWord = null; }}
                    title="Words on photos you rejected — not in anyone's gallery">
              🗑️ On rejected ({rejectedCount2})
            </button>
          {/if}
          {#if anyWordHearts}
            <!-- A SORT, not a filter — the same distinction the photo tabs make, so it carries the
                 toggled `on` state rather than a tab's `active`. Shown only once something has been
                 hearted; a control that sorts a column of zeroes reads as broken. -->
            <!-- Inert, not cleared, while Captions is the filter. A caption cannot be hearted — it
                 is the photographer's own line about their own shot — so sorting a page of them by
                 hearts is sorting a column of zeroes. Switching the sort OFF would be worse: the
                 host set it, and coming back to Comments to find it silently unset is the control
                 undoing their choice behind their back. So it keeps its state and takes the
                 disabled look (`.tab:disabled`, already 0.5 opacity) until it means something
                 again. -->
            <button class="tab" class:on={wordSort === 'loved'}
                    on:click={() => (wordSort = wordSort === 'loved' ? 'newest' : 'loved')}
                    aria-pressed={wordSort === 'loved'}
                    disabled={wordKind === 'caption'}
                    title={wordKind === 'caption'
                      ? 'Captions can’t be hearted — nothing here to sort by'
                      : 'Sort by how many hearts each comment has'}>Most loved</button>
          {/if}
        </div>
        <div class="w-acts">
          {#if shownWords.length}
            <button class="btn ghost sm" on:click={selectAllWords}>
              {wordSel.size === shownWords.length ? 'Clear' : 'Select all'}
            </button>
          {/if}
          {#if wordSel.size}
            <button class="btn danger sm" on:click={removeSelected} disabled={wordsBusy}>
              Remove {wordSel.size}
            </button>
          {/if}
          <button class="btn ghost sm" on:click={loadWords} disabled={wordsBusy}>↻ Refresh</button>
        </div>
      </div>

      {#if !wordsLoaded}
        <Loading />
      {:else if !shownWords.length}
        <div class="state empty">
          <div class="empty-i" aria-hidden="true">💬</div>
          <h2 class="empty-t">{showRejected ? 'Nothing written on those' : 'Nothing written yet'}</h2>
          <p class="empty-b">
            {#if showRejected}
              None of the photos you rejected carry a caption or a comment.
            {:else}
              Captions your guests add to their own photos, and comments anyone leaves on a photo, all
              show up here for you to read — or take down.
            {/if}
          </p>
        </div>
      {:else}
        {#if wordsCapped}
          <p class="w-capped">Showing the {words.length} most recent of {wordTotal}.</p>
        {/if}
        <ul class="w-list">
          {#each shownWords as w (wordKey(w))}
            <li class="w-row" class:sel={wordSel.has(wordKey(w))}>
              <label class="w-pick">
                <input type="checkbox" checked={wordSel.has(wordKey(w))} on:change={() => toggleWord(w)}
                       aria-label="Select this line" />
              </label>
              <img class="w-thumb" src={w.thumbUrl} alt="" loading="lazy" />
              <div class="w-body">
                <!-- `{w.text}` — Svelte escapes it. NEVER {@html}: this is text somebody typed. -->
                <p class="w-text">{w.text}</p>
                <p class="w-meta">
                  <span class="w-kind" class:cmt={w.kind === 'comment'}>{w.kind === 'caption' ? 'Caption' : 'Comment'}</span>
                  {#if (w.hearts ?? 0) > 0}
                    <span class="w-hearts" title={`${w.hearts} ${w.hearts === 1 ? 'heart' : 'hearts'}`}>
                      <HeartIcon filled size={11} /> {w.hearts}
                    </span>
                  {/if}
                  <span>{w.author}</span>
                  <!-- Worth saying plainly: a name typed into a forwarded link is not the same
                       claim as a guest who joined the event. -->
                  {#if w.authorKind === 'visitor'}<span class="w-via">via a share link</span>{/if}
                  <span>{fmtWhen(w.createdAt)}</span>

                </p>
              </div>
              <div class="w-row-acts">
                {#if w.kind === 'caption'}
                  <button class="btn ghost sm" on:click={() => { const p = photos.find((x) => x.id === w.photoId); if (p) openCaption(p); }}>Edit</button>
                {/if}
                <!-- Armed, like Reject on this same screen and like deleting a shot in the camera:
                     one tap to say what you mean, a second to mean it. -->
                <!-- BOTH labels are always in the button; only one is visible. Swapping the text
                     resized the button mid-decision, so the second tap — the one that deletes —
                     landed on a target that had just moved under the finger. The hidden label keeps
                     the slot, and `visibility` keeps it out of the accessibility tree. -->
                <button class="btn danger sm steady" class:armed={confirmWord === wordKey(w)}
                        on:click={() => (confirmWord === wordKey(w) ? removeOne(w) : (confirmWord = wordKey(w)))}
                        disabled={wordsBusy}
                        aria-label={confirmWord === wordKey(w) ? `Confirm removing this ${w.kind}` : `Remove this ${w.kind}`}>
                  <span class="lbl" class:off={confirmWord === wordKey(w)} aria-hidden="true">🗑️ Remove</span>
                  <span class="lbl" class:off={confirmWord !== wordKey(w)} aria-hidden="true">Sure?</span>
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if view === 'slideshow'}
    <div class="ss-wrap"><SlideshowPanel {code} {orgCode} hasPhotos={photos.length > 0} /></div>
  {:else if !photos.length}
    <div class="state empty">
      <div class="empty-i" aria-hidden="true">{emptyState.icon}</div>
      <h2 class="empty-t">{emptyState.title}</h2>
      <p class="empty-b">{emptyState.body}</p>
      {#if emptyState.action?.kind === 'link'}
        <a class="btn primary" href={backHref()}>{emptyState.action.label}</a>
      {:else if emptyState.action?.kind === 'refresh'}
        <button class="btn ghost" on:click={loadPhotos}>{emptyState.action.label}</button>
      {/if}
    </div>
  {:else if !filtered.length}
    <!-- Names the tab. "Nothing here" on a screen with four tabs is a sentence about which one? -->
    <div class="state">Nothing in {tabLabel(tab)} yet</div>
  {:else if view === 'cards'}
    <!-- ── Cards view ── -->
    <!-- The same card as the guest's roll, the gallery and a share link — see PhotoCard.svelte.
         This screen is the one with the most furniture: badges, a favourite, a select checkbox and
         the approve/reject row, all of which ride in on slots. In Select mode the caption goes
         static: a click on a card there means "pick this", not "edit this". -->
    <div class="pgrid"
         style={`--tile-ar:${tileAspect(ev.aspectRatios)}`}>
      {#each filtered as p, i (p.id)}
        <PhotoCard photo={p} selected={selecting && selected.has(p.id)}
                   selectable={selecting}
                   tileAr={tileAspect(ev.aspectRatios)}
                   captionMode="static"
                   hearts={ev.heartsEnabled ? (heartCounts[p.id] ?? 0) : undefined}
                   favourite={p.rating >= 5}
                   doubleTap={selecting ? 'none' : 'favourite'}
                   on:favourite={() => setRating(p, 5)}
                   meta={`${p.participantName} · ${fmtTime(p.takenAt)}`}
                   tileLabel={selecting ? 'Select photo' : 'Open photo'}
                   on:open={(e) => onCardClick(p, i, e.detail)}>
          <svelte:fragment slot="tile">
            {#if p.status === 'pending' && moderationOn}<div class="pending-badge">Pending</div>{/if}
            <!-- Approved, not downloaded — but while MODERATING it is a second tick in a second
                 corner competing with the one the host is actually using to pick photos, on a
                 screen where nothing can be downloaded anyway. It comes back the moment they stop
                 moderating, which is when "which of these are already through?" is a real question. -->
            {#if p.status === 'approved' && moderationOn && !(selecting && selectIntent === 'moderate')}<div class="ok-badge" title="Approved">✓</div>{/if}
            {#if selecting && p.rating >= 5}<span class="fav-flag" title="Favourite"><StarIcon filled size={14} /></span>{/if}
            <!-- No tick here either: PhotoCard draws it. This one sat in the OTHER corner, so
                 select mode showed two. -->
            {#if !selecting}
              <button class="fav-corner" class:on={p.rating >= 5} on:click={() => onFavouriteClick(p)}
                      aria-pressed={p.rating >= 5} aria-label="Favourite"><StarIcon filled={p.rating >= 5} size={19} /></button>
            {/if}
          </svelte:fragment>
          <svelte:fragment slot="foot">
            {#if mediaMeta(p)}<span class="media-meta">{p.mediaType === 'video' ? '🎥' : '🖼️'} {mediaMeta(p)}</span>{/if}
          </svelte:fragment>
          {#if !selecting}
            <div class="mod">
              {#if p.status === 'rejected'}
                <button class="btn ghost sm grow" on:click={() => restore(p)}>↩ Restore</button>
              {:else}
                {#if p.status === 'pending' && moderationOn}<button class="btn primary sm grow" on:click={() => approve(p)} aria-label="Approve"><span class="mod-g" aria-hidden="true">✓</span><span class="mod-t">Approve</span></button>{/if}
                <button class="btn danger sm grow" class:armed={confirmRejectId === p.id} on:click={(e) => requestReject(p, e)}
                        aria-label={confirmRejectId === p.id ? 'Confirm reject' : 'Reject'}>
                  <!-- "Sure?" keeps its word on every screen: it is a confirmation, and a bare ✕ that
                       means something different from the ✕ a moment ago is how people delete things
                       they meant to keep. -->
                  {#if confirmRejectId === p.id}Sure?{:else}<span class="mod-g" aria-hidden="true">✕</span><span class="mod-t">Reject</span>{/if}
                </button>
              {/if}
            </div>
          {/if}
        </PhotoCard>
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
          <span class="single-meta">{#if current.caption}<span class="scap">{current.caption}</span> · {/if}{#if current.challenge}<span class="smission" class:secondary={!!current.caption}>{current.challenge}</span> · {/if}{current.participantName} · {fmtFull(current.takenAt)}{#if mediaMeta(current)}{' '}· {mediaMeta(current)}{/if}</span>
          <button class="btn ghost sm capbtn" on:click={(e) => openCaption(current, e)}>💬 {current.caption ? 'Edit caption' : 'Caption'}</button>
        </div>
        <div class="srow">
          {#if current.status === 'rejected'}
            <button class="btn ghost sm grow" on:click={() => restore(current)}>↩ Restore</button>
          {:else}
            {#if current.status === 'pending' && moderationOn}<button class="btn primary sm grow" on:click={() => approve(current)}>✓ Approve</button>{/if}
            <button class="btn danger sm grow" class:armed={confirmRejectId === current.id} on:click={(e) => requestReject(current, e)}>{confirmRejectId === current.id ? 'Sure?' : '✕ Reject'}</button>
          {/if}
          <button class="btn ghost sm grow" on:click={() => shareOne(current)} disabled={busy}>📤 Share</button>
          <button class="btn ghost sm grow" aria-label="Save this photo to your device"
                  on:click={() => downloadOne(current.url, `${current.participantName || 'photo'}.${current.mediaType === 'video' ? 'mp4' : 'jpg'}`)}><DownloadIcon /></button>
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

{#if captionFor}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
  <div class="capback" on:click|self={() => (captionFor = null)} role="dialog" aria-modal="true" aria-label="Caption this photo">
    <div class="capmodal">
      <div class="capm-head"><span>Caption</span><button class="fs-x static" on:click={() => (captionFor = null)} aria-label="Close">✕</button></div>
      {#if captionFor.challenge}
        <!-- The trick stays in view while they type: a caption sits ALONGSIDE the mission, not
             instead of it, and seeing it here is what stops anyone retyping it as the caption. -->
        <div class="capm-mission">🃏 {captionFor.challenge}</div>
      {/if}
      <!-- svelte-ignore a11y-autofocus -->
      <textarea class="capm-text" rows="2" bind:value={captionDraft} autofocus
                placeholder="Describe the scene…"></textarea>
      <div class="capm-row">
        <span class="capm-left">{captionRemaining(captionDraft)}</span>
        {#if captionFor.caption}
          <!-- Clearing IS saving nothing — the same call with empty text. The button exists because
               "empty the box and press Save" is not a thing anyone guesses. -->
          <button class="btn ghost sm" on:click={() => { captionDraft = ''; void saveCaption(); }} disabled={captionBusy}>Remove</button>
        {/if}
        <button class="btn primary sm" on:click={saveCaption} disabled={captionBusy}>{captionBusy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  </div>
{/if}

{#if shareModal}
  <ShareModal {code} {orgCode} share={shareModal} on:close={() => (shareModal = null)} />
{/if}

<style>
  .state { text-align: center; padding: 60px 16px; color: var(--text-muted); }
  .state.empty { max-width: 460px; margin: 0 auto; }
  .empty-i { font-size: 2.6rem; line-height: 1; margin-bottom: 12px; }
  .empty-t { margin: 0 0 8px; font-size: 1.05rem; font-weight: 800; color: var(--text); }
  .empty-b { margin: 0 0 18px; font-size: 0.88rem; line-height: 1.5; }

  /* Grid, not flex. As a flex row the title had flex:1 between a narrow back link and a wide
     button group, so it centred in the LEFTOVER space and sat visibly left of true centre. Equal
     1fr side tracks put the middle column in the actual middle of the bar regardless of what the
     sides contain. */
  .hd { position: sticky; top: 0; z-index: 10; display: grid; align-items: center; gap: 12px;
    grid-template-columns: 1fr auto 1fr;
    padding: 10px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .hd-side { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .hd-side.right { justify-content: flex-end; }
  /* inline-FLEX with a set line-height, because these two are a <button> and an <a> sitting side by
     side: the button takes `line-height: normal` from the browser and the link inherits the page's,
     so "← Photos" stood 15px tall against "Manage" at 20px and the two words sat on different
     baselines — close enough to read as a wobble rather than as a decision. */
  .back { text-decoration: none; color: var(--text); font-weight: 700; font-size: 0.85rem; white-space: nowrap;
    display: inline-flex; align-items: center; line-height: 1.4;
    background: none; border: 0; padding: 0; font-family: inherit; cursor: pointer; }
  /* Manage sits second in the single view: still there, no longer the loudest way out. */
  .back.quiet { font-weight: 600; color: var(--text-muted); }
  .back.quiet:hover { color: var(--accent); }
  .hd-side { display: flex; align-items: center; gap: 14px; min-width: 0; }
  .back:hover { color: var(--accent); }
  .hd-name { font-weight: 800; font-size: 0.95rem; text-align: center; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  /* On a narrow screen the sides need every pixel, so the name steps out rather than squeezing
     the controls it sits between. */
  /* Below 560 the header stops being a three-column grid and becomes a wrapping row.
     As a grid it could not wrap, so when the right-hand controls outgrew their track they simply
     ran over the left ones — measured at 390px: "Manage" ended at 144px and "Cards" began at 138px,
     six pixels of overlap, with the two sitting on top of each other. Wrapping gives the toggles a
     second line to drop to when the width is not there, which is the one thing a grid track cannot
     do. The event name stays hidden: it is the only thing here that is not a control. */
  @media (max-width: 560px) {
    .hd { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 12px; }
    .hd-name { display: none; }
    .hd-side { flex: 0 1 auto; }
    .hd-side.right { flex: 1 1 auto; }
  }
  .vtoggle { display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; flex-shrink: 0; }
  .vbtn { background: transparent; color: var(--text-muted); border: none; padding: 8px 12px; min-height: 40px; font: inherit; font-size: 0.8rem; font-weight: 700; cursor: pointer; }
  .vbtn.active { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .vbtn:disabled { opacity: 0.4; cursor: default; }
  .ss-btn { flex-shrink: 0; min-height: 40px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: transparent; color: var(--text); font: inherit; font-size: 0.8rem; font-weight: 700; cursor: pointer; white-space: nowrap; }
  .ss-btn:hover { border-color: var(--accent); }
  /* Two mode buttons now share the row; under 760px they keep their emoji and drop the words rather
     than pushing the event name out of the bar. */
  @media (max-width: 760px) { .ss-lbl { display: none; } }

  /* ── Captions & comments ── */
  .words { padding: 14px 16px 40px; max-width: 900px; margin: 0 auto; }
  .w-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
  .w-filters { display: flex; flex-wrap: wrap; gap: 6px; }
  .w-acts { margin-left: auto; display: flex; flex-wrap: wrap; gap: 6px; }
  .w-capped { margin: 0 0 10px; font-size: .78rem; color: var(--text-muted); }
  .w-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .w-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px;
    border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
  .w-row.sel { border-color: var(--accent); }

  .w-pick { flex: none; padding-top: 3px; cursor: pointer; }
  .w-thumb { flex: none; width: 46px; height: 46px; object-fit: cover; border-radius: 6px;
    background: var(--surface-2); }
  .w-body { flex: 1; min-width: 0; }
  .w-text { margin: 0; font-size: .92rem; line-height: 1.4; overflow-wrap: anywhere;
    unicode-bidi: plaintext; }
  .w-meta { margin: 4px 0 0; font-size: .72rem; color: var(--text-muted);
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
  .w-kind { font-weight: 800; letter-spacing: .03em; text-transform: uppercase; font-size: .66rem;
    padding: 2px 6px; border-radius: 999px; background: var(--surface-2); color: var(--text); }
  .w-kind.cmt { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .w-hearts { display: inline-flex; align-items: center; gap: 3px; color: var(--heart-red, #ec2f55);
    font-weight: 700; font-variant-numeric: tabular-nums; }
  .w-via { font-style: italic; }
  /* One cell, two labels stacked in it: the button is as wide as the WIDER of them and stays that
     width whichever is showing. */
  .steady { display: grid; place-items: center; }
  .steady .lbl { grid-area: 1 / 1; white-space: nowrap; }
  .steady .lbl.off { visibility: hidden; }
  .w-row-acts { flex: none; display: flex; flex-direction: column; gap: 5px; }
  @media (max-width: 520px) {
    .w-row { flex-wrap: wrap; }
    .w-row-acts { flex-direction: row; width: 100%; justify-content: flex-end; }
  }
  .ss-btn.active { background: var(--accent-fill); color: var(--accent-ink, #111); border-color: var(--accent); }

  .tabs { display: flex; align-items: center; gap: 6px; padding: 12px 16px; max-width: 980px; margin: 0 auto; flex-wrap: wrap; }
  .tab { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 20px; padding: 7px 14px; min-height: 40px; font: inherit; font-size: 0.82rem; font-weight: 700; cursor: pointer; }
  .tab.active { background: var(--accent-fill); color: var(--accent-ink, #111); border-color: var(--accent); }
  /* `.on` is the ENGAGED look for a control that is not one of the tabs — the guest filter and the
     sort. It was set on Most loved from the day it shipped and never styled, so the one control on
     this row that could be switched on had no way to show it. Same treatment the guest filter uses,
     because it is the same idea: this is narrowing or reordering what you are looking at. */
  .tab.on { background: var(--accent-fill); color: var(--accent-ink, #111); border-color: var(--accent); }
  .tab:disabled { opacity: 0.5; cursor: default; }
  .ghost-tab { background: transparent; }
  .who-menu { position: relative; }
  /* display:flex, because a <summary> is a list-item and a <button> is not.
     Every other pill in this row is a button, which centres its own content; this one stacked its
     text from the top of the box and left the spare `min-height` underneath, so the label sat 2.5px
     high against 0.34px for its neighbours — visible as a row that does not quite line up.
     `list-style: none` alone does not fix it: that hides the marker, it does not change the layout
     mode the marker comes from. */
  .who-menu > summary { list-style: none; cursor: pointer; user-select: none;
    display: flex; align-items: center; justify-content: center; }
  .who-menu > summary::-webkit-details-marker { display: none; }
  .who-menu > summary.on { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .who-pop {
    /* Anchored to the menu's RIGHT edge, not its left.
       With `left: 0` the panel started where the summary starts — x=187 in the filter row — and
       ran 220px from there, so its right edge landed at 407px on both a 360 and a 390 phone and
       about fifty pixels of the guest list was off-screen and unreachable. max-width caps how WIDE
       it is, which never helped: the problem was where it began. Opening leftward from a control
       that already sits right-of-centre keeps the whole list on screen at every phone width. */
    position: absolute; top: calc(100% + 6px); right: 0; left: auto; z-index: 30; min-width: 220px;
    /* Never wider than the screen, and never flush against its edge on a narrow phone. */
    max-width: calc(100vw - 16px);
    max-height: 320px; overflow-y: auto; padding: 8px; border-radius: var(--radius-sm);
    background: var(--surface); border: 1px solid var(--border); box-shadow: 0 10px 30px rgba(0,0,0,.35);
  }
  .who-opt { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px; cursor: pointer; font-size: .85rem; }
  .who-opt:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .who-nm { flex: 1; }
  .who-n { opacity: .6; font-variant-numeric: tabular-nums; }
  .who-clear { width: 100%; margin-top: 6px; padding: 8px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text); font: inherit; font-size: .82rem; cursor: pointer; }
  .tab-spacer { flex: 1; }

  .selbar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; max-width: 980px; margin: 0 auto 14px; flex-wrap: wrap;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .selcount { font-size: 0.82rem; font-weight: 700; }
  .lnk { background: none; border: none; color: var(--accent); font: inherit; font-size: 0.8rem; font-weight: 700; cursor: pointer; padding: 4px; }

  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 10px 18px; font-size: 0.9rem; border: 1px solid transparent; cursor: pointer; text-decoration: none; font-family: inherit; text-align: center; min-height: 40px; }
  .btn.sm { padding: 9px 14px; font-size: 0.82rem; }
  .primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .ghost { border-color: var(--border); color: var(--text); background: transparent; }
  .ghost:hover { border-color: var(--accent); }
  .danger { background: var(--danger); color: #fff; }
  .danger.armed { background: #fff; color: var(--danger); border-color: var(--danger); }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .grow { flex: 1; }

  .ss-wrap { max-width: 560px; margin: 0 auto; padding: 12px 16px 80px; }
  /* The grid and the card are PhotoCard's (.pgrid / .pcell-wrap); this page only bounds and
     positions the grid, and styles what it hangs on the card. The bottom padding keeps the last
     row clear of the sticky furniture. */
  .pgrid { max-width: 980px; margin: 0 auto; padding-bottom: 80px; }
  /* The same flush corner wash the heart uses, mirrored into the top-RIGHT — see the long note on
     `.heart` in PhotoCard.svelte for why it is square, pinned at the corner and has the gradient's
     origin there too. A dark circle floating 6px in was a second visual language for the same idea
     (one tap, one mark on a photo), and the two sat on the same card. */
  .fav-corner { position: absolute; top: 0; right: 0; border: 0; border-radius: 0; cursor: pointer;
    padding: 9px 9px 13px 16px; line-height: 1; color: #fff;
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(ellipse 135% 135% at 100% 0%,
      rgba(0,0,0,0.58) 0%, rgba(0,0,0,0.34) 46%, rgba(0,0,0,0) 74%);
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.55)); }
  .fav-corner.on { color: var(--accent); }
  .pending-badge { position: absolute; top: 6px; left: 6px; font-size: 0.62rem; font-weight: 800; background: rgba(0,0,0,.6); color: #fff; padding: 3px 8px; border-radius: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  /* Approved tick (bottom-left) — clear at a glance which photos are live under moderation. */
  .ok-badge { position: absolute; bottom: 6px; left: 6px; width: 22px; height: 22px; border-radius: 50%; background: var(--success, #2ecc71); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 800; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
  /* Static favourite marker, shown only while selecting — where the tick owns the corner itself, so
     this sits just inside it rather than under it, and wears the drop shadow alone: the tick's own
     dark chip is right beside it doing the contrast work a second wash would only muddy. */
  .fav-flag { position: absolute; top: 9px; right: 34px; line-height: 1; color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.75)); }

  .capbtn { white-space: nowrap; }
  .single-meta .scap { color: var(--text); font-weight: 700; }
  .single-meta .smission.secondary { color: var(--text-muted); font-weight: 400; }
  .capback { position: fixed; inset: 0; z-index: 260; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; padding: 20px; }
  .capmodal { width: 100%; max-width: 380px; background: var(--surface); color: var(--text);
    border: 1px solid var(--border); border-radius: var(--radius, 12px); padding: 4px 16px 16px;
    box-shadow: 0 16px 50px rgba(0,0,0,0.5); }
  .capm-head { display: flex; align-items: center; justify-content: space-between;
    padding: 12px 0 10px; border-bottom: 1px solid var(--border); font-weight: 800; font-size: 0.95rem; }
  .capm-mission { font-size: .76rem; color: var(--text-muted); padding-top: 8px; }
  .capm-text { width: 100%; box-sizing: border-box; margin-top: 10px; resize: none;
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 10px; padding: 9px 10px; font: inherit; font-size: 0.9rem; }
  .capm-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .capm-left { flex: 1; font-size: .72rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  /* The full-screen close button, borrowed for the modal head — it is fixed-positioned there. */
  .fs-x.static { position: static; }
  /* Dimensions/length · size, in the card foot under the shooter line. It is a slot child, so the
     foot's own flex column supplies the spacing — no padding of its own. */
  .media-meta { font-size: 0.64rem; color: var(--text-muted); font-family: var(--font-mono);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.85; }
  .mod { display: flex; gap: 8px; padding: 8px; flex-wrap: nowrap; }
  /* The glyph and its word are two elements with a gap between them, not one string relying on a
     leading space inside a span. In a flex button that space is a text node between two flex items
     and it collapses, so "✕ Reject" rendered as "✕Reject" wherever the label showed — which is
     desktop, the only place it shows at all. A gap cannot collapse.
     The glyph is also held at one size and given a fixed box, so Approve and Reject line up as a
     pair instead of each being as wide as its own word makes it. */
  .mod .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
  .mod-g { font-size: 0.95rem; line-height: 1; width: 1em; text-align: center; flex: none; }
  /* Keep mod-button labels on one line so a narrow (2-button) row never grows taller than a
     single-button row — cards stay the same height regardless of how many actions show. Tighter
     horizontal padding so "✓ Approve" + "✕ Reject" fit comfortably side by side in a card. */
  .mod .btn { white-space: nowrap; min-width: 0; padding-left: 6px; padding-right: 6px; }
  /* On a phone the glyphs carry it. Two words squeezed into a 180px card read as cramped, and the
     tick and cross are not ambiguous — they are the two things this screen does. */
  @media (max-width: 560px) { .mod-t { display: none; } .mod .btn { font-size: 1rem; padding: 6px 4px; } }
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
  /* Two per row on a phone, not four. At 390px four buttons get ~83px each, which is narrower than
     "✓ Approve" — so the three labelled ones wrapped to two lines and stood 50px tall while the
     download button, whose label is an icon, stayed at 40px. A row of four controls where three
     are taller than the fourth reads as a mistake, and the cause is simply that the labels were
     never given room. Half-width each: nothing wraps, and every button is the same height again. */
  @media (max-width: 560px) {
    .srow > .btn { flex: 1 1 calc(50% - 10px); }
  }
  .counter { font-size: 0.82rem; color: var(--text-muted); font-weight: 700; white-space: nowrap; }
  .single-meta { flex: 1; font-size: 0.76rem; color: var(--text-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* On a phone the caption gets the row to itself. Sharing one nowrap line with the counter and the
     Edit caption button left it as three words and an ellipsis — the caption being the one thing on
     this bar anybody is actually reading. Below the two controls rather than above them, so the
     button stays where the thumb already was. */
  @media (max-width: 560px) {
    .single-meta {
      flex: 1 1 100%; order: 3;
      white-space: normal; overflow: visible; text-overflow: clip; line-height: 1.4;
    }
  }
  .single-meta .smission { color: var(--text); font-weight: 700; }

  @media (min-width: 640px) {
    .pgrid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  }
</style>

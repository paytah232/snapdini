<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { getEvent, getGalleryPhotos, getMe, setHeart, getHearts,
           type Photo, type PhotoRotation, type PublicEvent } from '$lib/events';
  import { getSession } from '$lib/session';
  import FaceFinder from '$lib/components/FaceFinder.svelte';
  import GuestFeedback from '$lib/components/GuestFeedback.svelte';
  import { applyEventTheme } from '$lib/theme';
  import { showToast } from '$lib/toast';
  import { isTransient, writeFailed } from '$lib/api';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import OgHead from '$lib/components/OgHead.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import PhotoCard from '$lib/components/PhotoCard.svelte';
  import StarIcon from '$lib/components/StarIcon.svelte';
  import TileSizeToggle from '$lib/components/TileSizeToggle.svelte';
  import { loadTileSize, saveTileSize, tileVars, type TileSize } from '$lib/tileSize';
  import { galleryVisitorJoin } from '$lib/events';
  import DownloadIcon from '$lib/components/DownloadIcon.svelte';
  import { tileAspect } from '$lib/ui';
  import { sortPhotos, type PhotoSort } from '$lib/photoSort';
  import { demoLinks } from '$lib/demo';
  import { saveMany, type SaveManyProgress, savePhotoByUrl } from '$lib/saveImage';
  import { savedSet, markSaved } from '$lib/saved';
  import ShareScope from '$lib/components/ShareScope.svelte';
  import DownloadFormat from '$lib/components/DownloadFormat.svelte';
  import { zipHref, downloadFilename, heartedPhotos, favouritesUnion, type DownloadScope } from '$lib/download';
  import StartYourOwn from '$lib/components/StartYourOwn.svelte';
  import { trackGalleryView, trackPhotos } from '$lib/referral';
  import { createRevealWatch, galleryPollBaseMs, galleryPollDelayMs, shouldPollGallery } from '$lib/revealWatch';
  import type { PageData } from './$types';

  export let data: PageData;
  const code = $page.params.code ?? '';

  let loading = true;
  let error = '';
  let event: PublicEvent | null = null;

  let revealed = false;
  let revealMode = '';
  /** The host is the only one who can open this. See awaitingHost on the event payload. */
  let awaitingHost = false;
  let revealAt: number | null = null;
  // "Just revealed" = within 48h of the gallery unlocking. That window is the reveal moment for an
  // at_end/manual event, when guests come back and see everything at once.
  $: justRevealed = revealed && !!revealAt && Date.now() - revealAt < 48 * 3600 * 1000;
  let photoCount = 0;
  // Moderation is a WHERE clause on the server, not a gate — so a moderated event can answer
  // `revealed: true` with an empty array for as long as the host has approved nothing. Knowing
  // which of those two empties this is decides both what the page says and whether it keeps asking.
  let moderationEnabled = false;
  // How many are waiting for the host. Undefined until a server that sends it has answered — and
  // undefined deliberately reads as "keep asking", because a silent stop is the wrong response to
  // not knowing. See shouldPollGallery().
  let pendingCount: number | undefined = undefined;

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
  /** Which participant this viewer is, when they are one.
   *
   *  The gallery payload cannot tell us: it is cached PUBLICLY (see gallery-cache.test.ts), so the
   *  server strips `isOwn` from every row rather than let one guest's view of the album be served
   *  to the next person who asks. Every row does carry its participantId though, and getMe below
   *  is an authenticated call this page already makes — so ownership is decided here instead of
   *  asking for a per-viewer copy of a response that exists to be shared. */
  let myParticipantId = '';
  // Feedback is offered here too. This is where a guest arrives after the event ends, which is a
  // better moment to ask than mid-party — and because the control needs a participant session, a
  // stranger who was sent the gallery link is never asked at all.
  let feedbackDone = false;
  let faceMatching = false;
  let faceEnrolled = false;
  let facePhotoIds = new Set<string>();
  let meOnly = false;
  let sort: PhotoSort = 'newest';
  // Offered only when there is something to sort BY. A "most hearted" control on an event where
  // nobody has hearted anything sorts nothing and says the feature is broken.
  $: anyHearts = !!event?.heartsEnabled && Object.values(heartCounts).some((n) => n > 0);
  $: if (!anyHearts) sort = 'newest';
  // NOT re-sorted here any more. The server returns the page already in the chosen order, because
  // "most loved" has to mean most loved IN THE EVENT — sorting the loaded page client-side answered
  // "the most loved of the first hundred", which is a different answer at every scroll position and
  // never the real one. The only client-side narrowing left is the face filter, which genuinely is
  // about this viewer.
  $: visiblePhotos = meOnly ? photos.filter((p) => facePhotoIds.has(p.id)) : photos;
  /* `isOwn` filled in from the identity above, for the one control that needs it: a guest may
     rotate their own sideways shot and nobody else's. A new array only while there is an identity
     to apply, so the common case — a stranger with the link — hands the grid the very same objects
     it had before and re-renders nothing. The server is still the authority; this decides what to
     OFFER, not what is allowed. */
  $: shownPhotos = myParticipantId
    ? visiblePhotos.map((p) => (p.participantId === myParticipantId && !p.isOwn ? { ...p, isOwn: true } : p))
    : visiblePhotos;

  // Changing the sort starts the list again, in the server's new order.
  let sortLoaded: PhotoSort = 'newest';
  $: if (sort !== sortLoaded && !loading) { sortLoaded = sort; void reloadForSort(); }
  /* When this viewer last changed a heart themselves.
     A WINDOW rather than a one-shot flag: the shared gallery answer is cached for 30s, so every
     request made inside that window would otherwise be able to serve the pre-heart order — and a
     one-shot flag is spent by whichever load happens first, which on a sort→sort→sort round trip
     is not the one the guest is looking at. Past the window the shared copy has expired anyway and
     already carries the change, so this stops asking for special treatment. */
  let heartsChangedAt = 0;
  const HEART_FRESH_MS = 35_000;   // the 30s gallery TTL, plus a little for clock skew
  $: heartsDirty = heartsChangedAt > 0 && now - heartsChangedAt < HEART_FRESH_MS;

  /* When this viewer last straightened a photo. The same window, reusing the same constant —
     35s is a property of the shared ANSWER, not of what happened to be changed in it.
     Sharper stakes here than for a heart, which is why the poll is covered and not just the
     reload that follows the press: a rotation RENAMES the stored file and unlinks the old one, so
     a cached gallery answer from before it does not show a stale picture, it points at a filename
     that no longer exists — a broken tile until the cache expires. Every load inside the window
     asks for the uncached copy. */
  let rotatedAt = 0;
  $: rotateDirty = rotatedAt > 0 && now - rotatedAt < HEART_FRESH_MS;

  /* ONE flag, read by EVERY load, because the bug was one load being forgotten.
     `loadPhotos` asked for an uncached copy after a rotation and the other two did not, so
     changing the sort or scrolling a page in during that window went back to the shared cache and
     was handed rows naming a file the rotation had already unlinked — broken tiles, from a
     feature that had "fixed" exactly this on the one path somebody thought of. There is no path
     where the cache should be trusted for one of these and not the other, so there is no longer a
     choice to make at the call site. */
  $: skipCache = heartsDirty || rotateDirty;

  /** Fold a rotation's reply into the row it belongs to.
   *
   *  A MERGE, not a refetch. The reply carries everything that changed — the new names, the
   *  swapped dimensions, and `shotSideways` as a real boolean — so the tile is right on this tick
   *  rather than after a round trip that the shared cache could answer with the pre-rotation row.
   *  It is also the only way to take the ↻ "shot sideways" mark off a card without a reload: the
   *  gallery row omits that field entirely when it is false, so there is nothing in a refetch to
   *  overwrite a stale `true` with. See PhotoRotation.
   *
   *  `photos` and not `shownPhotos`: this page owns the former and derives the latter. */
  function applyRotation(r: PhotoRotation) {
    rotatedAt = Date.now();
    now = rotatedAt;               // `now` ticks once a second; don't wait for it to catch up
    photos = photos.map((p) => (p.id === r.id
      ? { ...p, url: r.url, thumbUrl: r.thumbUrl, playUrl: r.playUrl,
          width: r.width, height: r.height, shotSideways: r.shotSideways }
      : p));
  }

  async function reloadForSort() {
    try {
      const data = await getGalleryPhotos(code, highlightsOnly, null, sort, skipCache);
      photos = data.photos ?? [];
      nextCursor = data.nextCursor ?? null;
      selectAllEvent = false;      // a different order is a different "everything"
      void loadHearts();
    } catch (e) { showToast(writeFailed(e, 'Could not sort those'), true); }
  }
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
    const data = await getGalleryPhotos(code, highlightsOnly, null, undefined, skipCache);
    revealed = data.revealed;
    revealMode = data.revealMode ?? '';
    awaitingHost = data.awaitingHost === true;
    revealAt = data.revealAt ?? null;
    photoCount = data.photoCount ?? 0;
    hasHighlights = data.hasHighlights ?? false;
    allowDownloads = data.allowDownloads !== false;
    moderationEnabled = !!data.moderationEnabled;
    pendingCount = data.pendingCount;
    photos = data.photos ?? [];
    nextCursor = data.nextCursor ?? null;
    // Separate call on purpose: this payload is shared-cacheable, so live counts and "which are
    // mine" cannot ride in it. See the hearts endpoint.
    void loadHearts();
    // Every load decides afresh whether there is still anything to wait for. Cheaper than a
    // reactive statement and impossible to get out of step with the data it is deciding on.
    schedulePoll();
    // Engagement: the ids this viewer actually received. Batched and fire-and-forget — a counter
    // must never delay or break the gallery.
    trackPhotos(code, photos.map((p) => p.id), 'view');
  }

  // ── Scrolling into the rest of the gallery ──────────────────────────────────
  //
  // The server hands back a page and a cursor; this asks for the next one as the bottom of the grid
  // comes into view, so a guest scrolls through the whole event without ever seeing a page control.
  // The IMAGES have always lazy-loaded (`loading="lazy"` on the tile) — this is the metadata
  // catching up, and it is what stops a 14,000-photo event sending ~7.4MB of JSON before the first
  // picture appears.
  let nextCursor: string | null = null;
  let loadingMore = false;
  let sentinel: HTMLElement | undefined;

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    try {
      const data = await getGalleryPhotos(code, highlightsOnly, nextCursor, sort, skipCache);
      const seen = new Set(photos.map((p) => p.id));
      // Deduplicated on arrival. The cursor cannot produce an overlap on its own, but a photo
      // uploaded while somebody is mid-scroll can arrive on two different pages, and a key
      // collision in an {#each} is a crash rather than a cosmetic problem.
      photos = [...photos, ...(data.photos ?? []).filter((p) => !seen.has(p.id))];
      nextCursor = data.nextCursor ?? null;
      trackPhotos(code, (data.photos ?? []).map((p) => p.id), 'view');
      void loadHearts();
    } catch (e) {
      // Silent and retryable: the sentinel is still on screen, so scrolling a little asks again.
      if (!isTransient(e)) nextCursor = null;   // a settled error means there is nothing more to get
    } finally { loadingMore = false; }

    // KEEP GOING WHILE IT IS STILL IN VIEW. An IntersectionObserver fires on a CHANGE of
    // intersection, not continuously — so if the sentinel is still on screen after a page lands
    // (a short page, a tall window, or the 800px margin), nothing fires again and the scroll dies
    // one page in. Asking again here is what turns "one more page" into "as many as it takes".
    // One frame, so the tiles that just arrived are laid out before the sentinel is measured.
    // NOT Svelte's tick() — this page already has a `tick` of its own (the countdown interval), and
    // importing the other one shadows it.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    if (nextCursor && sentinel) {
      const r = sentinel.getBoundingClientRect();
      if (r.top < window.innerHeight + 800) void loadMore();
    }
  }

  // Watches the sentinel rather than listening to scroll: no per-frame work, and it fires for a
  // short gallery that never scrolls at all.
  $: if (sentinel) {
    moreObserver?.disconnect();
    moreObserver = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) void loadMore(); },
      // A screen of margin, so the next page is usually already there by the time it is needed.
      { rootMargin: '800px' },
    );
    moreObserver.observe(sentinel);
  }
  let moreObserver: IntersectionObserver | undefined;

  // ── Unlocking without a reload ──────────────────────────────────────────────
  //
  // Two mechanisms, because the product has two ways a gallery opens.
  //
  // 1. The countdown crossing zero (`at_end`). One refetch per crossing, 5s late on purpose — the
  //    server gates on ITS clock and this page counts on the phone's, so a phone two seconds fast
  //    would otherwise ask early, be told no, and sit there. A no is retried with backoff, capped,
  //    so a badly wrong clock backs off instead of hammering. See lib/revealWatch.ts.
  // 2. A slow poll, for everything with no moment to cross: a `manual` reveal (the host presses a
  //    button, whenever), a host revealing an at_end event early, and the moderated case where the
  //    gallery IS revealed and fills up as the host approves.
  const revealWatch = createRevealWatch({
    attempt: async () => {
      try { await loadPhotos(); } catch { return false; }
      return revealed;
    },
  });

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  function schedulePoll() {
    if (typeof document === 'undefined') return;
    clearTimeout(pollTimer);
    pollTimer = undefined;
    // `photoCount`, NOT photos.length. The server sends this one counted WITHOUT ?highlightsOnly
    // precisely so the client can tell "nothing here yet" from "nothing starred yet" (see the
    // comment on visibleCount in routes/photos.ts). photos.length is the filtered set, so on the
    // Highlights view a moderated event with a queue read as an empty gallery and kept polling for
    // a change that view could never show.
    if (!shouldPollGallery({ revealed, photoCount, moderationEnabled, pendingCount })) return;
    // Never poll a backgrounded tab. A gallery link left open on a phone in a pocket is the common
    // case, and it is the single biggest saving available on the highest-fan-out surface we have.
    // The visibility handler below picks it straight back up, with a catch-up request first.
    if (document.hidden) return;
    pollTimer = setTimeout(() => {
      // loadPhotos() re-schedules (or stops) by itself; a failure must leave what is on screen
      // alone, so the retry is simply the next tick.
      loadPhotos().catch(() => schedulePoll());
    }, galleryPollDelayMs(Math.random(), galleryPollBaseMs({ revealed, revealAt, now: Date.now() })));
  }

  function onVisibility() {
    if (document.hidden) { clearTimeout(pollTimer); pollTimer = undefined; return; }
    // Back in front of someone: answer "did anything happen while I was away" immediately rather
    // than up to 45s later.
    // Same number as schedulePoll(), for the same reason.
    if (shouldPollGallery({ revealed, photoCount, moderationEnabled, pendingCount })) {
      loadPhotos().catch(() => schedulePoll());
    }
  }

  // How big the cards are. Per device, not per event — see lib/tileSize.ts.
  let tileSize: TileSize = 'small';

  // ── Reacting without having joined ──────────────────────────────────────────
  //
  // The gallery link is the one a host is most likely to send round, so the people holding it can
  // react too — governed by the EVENT's own hearts/comments switches, because this link is the
  // event. A visitor is not a participant: no seat against the guest cap, no roll, no trick card,
  // no line in the guest list. Guests keep reacting as themselves; this is only for browsers with
  // no session for this event.
  let visitorToken: string | null = null;
  let visitorName = '';
  const VKEY = `snapdini.gallery.visitor.${code}`;

  let askName = false;
  let nameDraft = '';
  let nameBusy = false;
  let nameResolve: ((t: string | null) => void) | null = null;

  /** A token, silently. Nothing shows who hearted a photo, so asking a name before a heart is a toll
   *  gate on the smallest gesture in the product. */
  async function ensureVisitor(): Promise<string | null> {
    if (guestToken) return null;            // a guest reacts as the guest they are
    if (visitorToken) return visitorToken;
    try {
      const r = await galleryVisitorJoin(code, '');
      visitorToken = r.token;
      try { localStorage.setItem(VKEY, r.token); } catch { /* private mode */ }
      return r.token;
    } catch { showToast('Could not save that', true); return null; }
  }

  /** A token AND a name — the comment path, asked at the moment it is needed. */
  function ensureNamed(): Promise<string | null> {
    if (guestToken) return Promise.resolve(guestToken);
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
      const r = await galleryVisitorJoin(code, name, visitorToken);
      visitorToken = r.token;
      visitorName = r.name;
      try { localStorage.setItem(VKEY, r.token); } catch { /* private mode */ }
      askName = false;
      nameResolve?.(r.token); nameResolve = null;
    } catch (e) { showToast(writeFailed(e, 'Could not save that name'), true); }
    finally { nameBusy = false; }
  }
  function cancelName() { askName = false; nameResolve?.(null); nameResolve = null; }

  /** May this browser react, and under whose rules?
   *
   *  TWO different questions with two different answers, which is the whole point of 0064: a guest
   *  who scanned the QR is governed by the event's guest switches, and somebody who only holds the
   *  gallery link by that link's own. A host can leave guests hearting each other's shots all night
   *  and still send round a link nobody can write on. */
  $: canReact = revealed && (guestToken ? !!event?.heartsEnabled : !!event?.galleryHeartsEnabled);
  $: canComment = revealed && (guestToken ? !!event?.commentsEnabled : !!event?.galleryCommentsEnabled);


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
      event = await getEvent(code);
      document.title = `${event.name} — Snapdini`;
      applyEventTheme(event.theme);
      // BEFORE loadPhotos, because loadPhotos asks for the hearts and the hearts answer is the one
      // per-viewer thing on this page: which of them are MINE. Read after, the first hearts call
      // went out with no credential at all, so a guest opened their own gallery to hollow hearts
      // on photos they had hearted themselves — and they filled in only when something else
      // (a sort change, the poll) asked again, by which time this had been set.
      guestToken = getSession(code) ?? '';
      await loadPhotos();
      if (guestToken) {
        try {
          const me = await getMe(guestToken);
          myParticipantId = me.participant?.id ?? '';
          faceMatching = !!me.faceMatching;
          faceEnrolled = !!me.faceEnrolled;
          feedbackDone = !!me.feedbackGiven;
        } catch { guestToken = ''; myParticipantId = ''; }   // stale session — just don't offer it
      }
      retrying = false; retryWait = 1000; error = '';
      loading = false;
    } catch (e) {
      // Stay on the spinner and come back on our own — see scheduleRetry.
      if (isTransient(e)) { scheduleRetry(firstLoad); return; }
      error = e instanceof Error ? e.message : 'Event not found';
      loading = false;
    }
  }

  onMount(async () => {
    trackGalleryView(code);
    saved = savedSet(code);
    tileSize = loadTileSize();
    try { visitorToken = localStorage.getItem(VKEY); } catch { /* private mode */ }
    await firstLoad();
    document.addEventListener('visibilitychange', onVisibility);
    tick = setInterval(() => {
      now = Date.now();
      // Fed every second; acts at most once per reveal moment (and re-arms if the host moves it).
      if (!revealed) revealWatch.tick(revealAt);
    }, 1000);
  });

  onDestroy(() => {
    clearTimeout(retryTimer);
    moreObserver?.disconnect();
    clearInterval(tick);
    clearTimeout(pollTimer);
    revealWatch.stop();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  });

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

  // ── Hearts ──────────────────────────────────────────────────────────────────
  // Counts live SEPARATELY from `photos` rather than on the rows, because the two arrive from
  // different places for good reason: the gallery payload is shared-cacheable and carries counts
  // that may be a minute old, while this is the live, per-viewer answer. Keeping them apart means a
  // gallery refresh cannot quietly overwrite a fresher count with a staler one.
  let heartCounts: Record<string, number> = {};
  let heartMine = new Set<string>();

  async function loadHearts() {
    if (!event?.heartsEnabled) return;
    try {
      const r = await getHearts(code, guestToken || undefined, undefined, visitorToken);
      heartCounts = r.hearts;
      heartMine = new Set(r.mine);
    } catch { /* counts are decoration; a failed poll must never break the gallery */ }
  }

  /** Keep the card's count in step with the thread the viewer just changed, rather than refetching
   *  a gallery whose reply is cached anyway and would come back with the old number. */
  function bumpComments(id: string, delta: number) {
    photos = photos.map((p) => (p.id === id
      ? { ...p, comments: Math.max(0, (p.comments ?? 0) + delta) }
      : p));
  }

  async function toggleHeart(p: Photo, want: boolean) {
    // A guest uses their session; anybody else is minted a visitor token on the spot, with no name
    // asked for.
    const vt = guestToken ? null : await ensureVisitor();
    if (!guestToken && !vt) return;
    // Optimistic, because a heart has to feel instant — but only the COUNT DELTA is guessed, and
    // the server's own total replaces it the moment it answers. Guessing the total instead is what
    // drifts when two people press at once.
    const before = heartCounts[p.id] ?? 0;
    heartCounts = { ...heartCounts, [p.id]: Math.max(0, before + (want ? 1 : -1)) };
    const mine = new Set(heartMine);
    want ? mine.add(p.id) : mine.delete(p.id);
    heartMine = mine;
    // Their own change: every gallery request for the next half-minute skips the shared copy, so
    // re-sorting by Most loved reflects what they just did rather than the order before it.
    heartsChangedAt = Date.now();
    now = heartsChangedAt;   // `now` ticks once a second; don't wait for it to catch up
    try {
      const r = await setHeart(p.id, guestToken, want, vt);
      heartCounts = { ...heartCounts, [p.id]: r.hearts };
    } catch (e) {
      heartCounts = { ...heartCounts, [p.id]: before };   // put it back; nothing happened
      const undo = new Set(heartMine);
      want ? undo.delete(p.id) : undo.add(p.id);
      heartMine = undo;
      showToast(writeFailed(e, 'Could not save that'), true);
    }
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
      // Picking one photo is no longer 'all of them'.
      selectAllEvent = false;
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

  // Files on a phone, a zip on a desktop.
  //
  // A zip is one tidy file on a laptop and close to a dead end on a phone: you need an extractor,
  // and what comes out sits in a folder rather than the camera roll, which is where the photos were
  // wanted. So a touch device gets the actual files — shared on iOS, where that is the only route
  // into Photos, and downloaded on Android, where the gallery picks them up by itself.
  //
  let bulkSaving = false;
  let bulkProgress = '';
  let bulkDone = '';
  async function saveAsFiles(list: typeof photos) {
    bulkSaving = true; bulkProgress = `0/${list.length}`;
    try {
      const items = list.map((p) => ({
        id: p.id,
        url: p.url,
        filename: downloadFilename(p),
      }));
      const r = await saveMany(items, (pr: SaveManyProgress) => (bulkProgress = `${pr.done}/${pr.total}`));
      // Only what actually got through — a cancelled share sheet returns the batches before it,
      // not the whole list.
      if (r.savedIds.length) saved = markSaved(code, r.savedIds);
      if (r.cancelled) { showToast(r.saved ? `Stopped — ${r.saved} downloaded` : 'Stopped'); bulkDone = ''; }
      else {
        showToast(`${r.saved} photo${r.saved === 1 ? '' : 's'} downloaded`);
        // Batched saving is slow, and the toast is long gone by the time the last batch lands. The
        // button holds the answer to "did that finish?" for a few seconds.
        bulkDone = `✓ Downloaded ${r.saved}`;
        setTimeout(() => (bulkDone = ''), 4000);
      }
    } catch (e) { showToast(writeFailed(e, 'Could not save those'), true); }
    finally { bulkSaving = false; bulkProgress = ''; }
  }

  // Why the question is asked every time, rather than guessed or remembered, lives in
  // lib/download.ts. zipIds undefined means "the whole event": the server then streams everything
  // it holds rather than only the page's loaded set.
  let choosing: { list: typeof photos; zipIds?: string[] } | null = null;

  function offerDownload(list: typeof photos, zipIds?: string[]) {
    choosing = { list, zipIds };
  }
  function startZip(zipIds?: string[]) {
    choosing = null;
    showToast('Preparing your download…');
    location.href = zipHref(code, zipIds);
  }
  function chooseZip() { startZip(choosing?.zipIds); }
  function chooseFiles() {
    const list = choosing?.list ?? [];
    choosing = null;
    void saveAsFiles(list);
  }

  // ── What to download ────────────────────────────────────────────────────────
  // The same question as sharing, plus two answers sharing cannot give — the hearted ones, and the
  // two favourites together — because a share link is a query the server re-resolves and it has no
  // query for either. "Download all" meant everything on screen, which quietly depends on whether
  // Highlights happens to be toggled — so the button's meaning changed with a filter elsewhere on
  // the page. Asking is both clearer and one tap shorter than finding the filter first.
  let dlScopeOpen = false;
  $: dlVideos = photos.filter((p) => p.mediaType === 'video').length;
  $: dlFavourites = photos.filter((p) => p.isHighlighted);
  // Per-device, from lib/saved.ts — so this is "not on THIS phone", which is what the row says.
  $: dlNew = photos.filter((p) => !saved.has(p.id));
  // The host's stars and the guests' hearts are two different favourites, so they are two different
  // scopes plus their union. An event with hearts switched off has no guest-favourites axis at all,
  // and the empty map is how that is said once here rather than at every use below.
  $: dlHearts = event?.heartsEnabled ? heartCounts : {};
  $: dlHearted = heartedPhotos(photos, dlHearts);
  $: dlBoth = favouritesUnion(photos, dlHearts);

  function startDownload(list: typeof photos, ids?: string[]) {
    if (!list.length) return;
    // Counted here, not in zipHref: that builder can be evaluated during render, which would
    // record downloads that never happened.
    trackPhotos(code, list.map((p) => p.id), 'download');
    offerDownload(list, ids);
  }
  function pickDownloadScope(scope: DownloadScope) {
    dlScopeOpen = false;
    if (scope === 'select') {
      if (!selecting) toggleSelecting();
      showToast('Pick your photos, then Download from the bar at the bottom');
      return;
    }
    const subset =
      scope === 'new' ? dlNew
      : scope === 'favourites' ? dlFavourites
      : scope === 'hearts' ? dlHearted
      : scope === 'both' ? dlBoth
      : null;
    // Only 'all' may go without ids, and it MUST: the server then streams everything the event
    // holds, which is not the same as everything this page has loaded. Every other scope is a
    // subset and has to name itself, or the zip comes back holding the whole event and quietly
    // undoes the choice — which is exactly what 'favourites' did until these ids were passed.
    if (!subset) { startDownload(photos); return; }
    startDownload(subset, subset.map((p) => p.id));
  }
  function downloadAll() {
    if (!allowDownloads) { showToast('Downloads are disabled for this event', true); return; }
    // Straight to it when there is nothing to choose between — a chooser whose answers are all the
    // same set is a tap that teaches nothing.
    // "Pick them myself" is always a different answer from "all", so the sheet is worth showing for
    // any gallery holding more than one photo — including one already fully downloaded, which used
    // to skip straight to re-downloading the lot.
    if (photos.length <= 1) { startDownload(photos); return; }
    dlScopeOpen = true;
  }
  // "All" means everything currently on screen, not everything in the event — otherwise the button
  // quietly contradicts whatever filter the viewer is looking through.
  /** "Select all" means EVERY photo in the event, not every photo that happens to be loaded.
   *
   *  Deliberately a FLAG rather than a list of ids: at 14,000 photos the ids alone are ~500KB to
   *  fetch and hold, and both things you can do with a selection already have a whole-event form
   *  that needs no ids at all — the zip endpoint streams the event when given none, and a share of
   *  everything is the 'all' kind rather than a hand-picked one. So this says "all of it" and the
   *  actions take the cheaper path. Touching any individual photo drops back to explicit ids. */
  let selectAllEvent = false;
  $: allShownSelected = selectAllEvent
    || (shownPhotos.length > 0 && shownPhotos.every((p) => selected.has(p.id)));
  $: selectedCount = selectAllEvent ? photoCount : selected.size;
  function toggleSelectAll() {
    if (allShownSelected) { selectAllEvent = false; selected = new Set(); return; }
    selectAllEvent = true;
    selected = new Set();
  }

  function downloadSelected() {
    // The whole event takes the whole-event path: no ids, so the server streams everything it holds
    // rather than the page this browser happens to have scrolled to.
    if (selectAllEvent) { startDownload(photos); return; }
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
  <!-- A guest who is IN this event needs the way back, and there wasn't one. Worse, a spent roll
       is sent here with replaceState, so the browser's own Back button does not go back either —
       they were simply stranded in the album. Shown only to someone with a session for THIS
       event: a stranger opening a shared gallery link has no camera to return to.

       OUTSIDE .nav-right, and directly after the brand, so it is pinned to the FIRST row. It is the
       way out of this page, which makes it the one control that must not be the one pushed onto a
       second line — and inside the wrapping group it was exactly as likely to wrap as anything
       else. Everything else still fills the rest of that row and wraps beneath when it runs out. -->
  {#if guestToken && !event?.isDemo}
    <a class="btn ghost back-ev" href={`/join/${code}`}>← Back to the event</a>
  {/if}
  <div class="nav-right">
    <!-- The demo's own navigation. Arriving here from the demo camera used to be a one-way door:
         the camera carries these links, this page did not, so there was no way to the host's view
         and no way out but the back button. Same order as the camera's — see the room, then the
         host's side of it, and only then the exit. -->
    {#if event?.isDemo}
      <a class="btn ghost demo" href={dlinks.camera}>📷 Camera</a>
      {#if dlinks.host}<a class="btn ghost demo" href={dlinks.host}>🎛️ Host view</a>{/if}
      <!-- No "Exit demo" here: the Snapdini logo to the left of this row already goes home, and on
           a revealed gallery this bar can hold Highlights, Select and Download all as well. A
           third pill that duplicates the logo is the one that pushes it over. -->
    {/if}
    {#if revealed && hasHighlights}
      <button class="btn ghost" on:click={toggleHighlights}>
        <!-- "Favourites", because that is what they are called on every other screen — the review
             tab, the share dialog, the star on the tile. "Highlights" was a second name for one
             thing, and the only place it appeared was the screen guests actually see. -->
        {highlightsOnly ? '📷 All photos' : '⭐ Favourites'}
      </button>
    {/if}
    <!-- No separate "Select" button. Selecting exists only to choose what to download, and Download
         already asks that as its first question ("Pick them myself") — so a second control beside it
         was a different door into the same room, and one more thing competing for a header row that
         wraps on a phone. Leaving select mode now lives in the select bar, with the rest of it. -->
    {#if revealed && photos.length}
      <TileSizeToggle bind:size={tileSize} on:change={(e) => saveTileSize(e.detail)} />
    {/if}
    {#if revealed && allowDownloads && photos.length && !selecting}
      <button class="btn ghost" on:click={downloadAll} disabled={bulkSaving}>
        {#if bulkSaving}Saving {bulkProgress}…{:else if bulkDone}{bulkDone}{:else}<DownloadIcon /> Download{/if}
      </button>
    {/if}
  </div>
</nav>

{#if selecting}
  <!-- Its own bar rather than more buttons in the nav: on a phone the nav is a fixed 62px and the
       extra controls wrapped straight out of view. This also has room to say how many are picked. -->
  <div class="selbar">
    <!-- Says which "all" this is. "92 selected" after pressing Select all on a gallery showing 20
         would otherwise be the only clue that it means more than what is on screen. -->
    <span class="selcount">
      {#if selectAllEvent}All {photoCount} photo{photoCount === 1 ? '' : 's'} selected
      {:else}{selected.size} selected{/if}
    </span>
    <div class="selactions">
      <button class="btn ghost" on:click={toggleSelectAll}>
        {allShownSelected ? 'Clear' : `Select all${shownPhotos.length ? ` (${shownPhotos.length})` : ''}`}
      </button>
      <!-- The way out. It used to be the nav's Select button doing double duty as Cancel, which is
           also what made that button look like it was worth keeping. -->
      <button class="btn ghost" on:click={toggleSelecting}>Cancel</button>
      <button class="btn primary" on:click={downloadSelected} disabled={!selectedCount || bulkSaving}>
        <DownloadIcon /> Download{selectedCount ? ` ${selectedCount}` : ''}
      </button>
    </div>
  </div>
{/if}

<!-- Asked at the first comment, never on arrival. Hearting never reaches this. -->
{#if askName}
  <div class="name-scrim" role="presentation" on:click|self={cancelName}>
    <div class="name-box" role="dialog" aria-modal="true" aria-label="Your name">
      <h2>What's your name?</h2>
      <p>So everyone knows whose words these are.</p>
      <form on:submit|preventDefault={submitName}>
        <!-- svelte-ignore a11y-autofocus -->
        <input bind:value={nameDraft} maxlength="40" autofocus placeholder="Your name" aria-label="Your name" />
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

{#if choosing}
  <DownloadFormat count={choosing.list.length}
                  on:pick={(e) => (e.detail === 'zip' ? chooseZip() : chooseFiles())}
                  on:close={() => (choosing = null)} />
{/if}

{#if event?.theme?.headerImage}
  <!-- Event image as a full-bleed hero background (cover) with the title over a gradient — scales
       cleanly for any aspect, unlike the old fixed-width banner. -->
  <header class="hero" style="background-image:url('{event.theme.headerImage}')">
    <div class="hero-inner">
      <h1>{event?.name ?? 'Gallery'}</h1>
      {#if revealed && photos.length}
        <p class="meta">{photos.length} photo{photos.length === 1 ? '' : 's'}{highlightsOnly ? ' · favourites' : ''}</p>
      {/if}
    </div>
  </header>
{:else}
  <header class="event-head">
    <h1>{event?.name ?? 'Gallery'}</h1>
    {#if revealed && photos.length}
      <p class="meta">{photos.length} photo{photos.length === 1 ? '' : 's'}{highlightsOnly ? ' · favourites' : ''}</p>
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
      <p class="msg">{awaitingHost ? 'The host hasn\u2019t revealed the photos yet' : modeText(revealMode)}</p>
      <!-- Only where asking would actually change something. On a timed reveal the countdown below
           is the whole answer. It also covers the case this was written for: an INSTANT event whose
           photos had been hidden used to read "Refresh to see photos" — advice that can never work,
           offered to somebody refreshing an empty page at a wedding. -->
      {#if awaitingHost}
        <p class="ask-host">Ask the host to reveal the photos now!</p>
      {/if}
      {#if revealMode === 'at_end' && revealAt}
        <!-- At zero the page is already asking the server (after a short pad for clock skew), so
             say so. A counter frozen at 00:00:00 with nothing happening is precisely what made
             this look broken. -->
        <div class="countdown" aria-live="polite">{remaining > 0 ? countdown : 'Unlocking…'}</div>
      {/if}
      <p class="count">{photoCount} photo{photoCount === 1 ? '' : 's'} so far</p>
    </div>
  {:else if !photos.length}
    {#if moderationEnabled && pendingCount !== 0}
      <!-- Revealed, and empty because the host is working through the queue — not because the
           event has no photos. A guest standing next to a host approving ninety shots used to be
           shown a flat "No photos yet" that never changed.
           `pendingCount !== 0` is the other half of that, and it covers the case this sentence was
           a lie in: a moderated event where nobody took a photo at all. There is nothing in the
           queue, the host is not approving anything, and telling a guest to wait for them is both
           untrue and endless — the page polled every 45 seconds for the life of the tab saying it.
           Undefined (a server too old to count) still reads as "waiting", which is the old
           behaviour and the safe direction to be wrong in. -->
      <div class="state">
        <p class="state-t">The host is still approving photos</p>
        <p class="state-d">They appear here as each one is approved — you don't need to refresh.</p>
      </div>
    {:else}
      <div class="state">No photos yet</div>
    {/if}
  {:else}
    {#if guestToken && (faceMatching || faceEnrolled)}
      <FaceFinder sessionToken={guestToken} bind:enrolled={faceEnrolled}
                  onMatched={(ids) => { facePhotoIds = new Set(ids); meOnly = ids.length > 0; }} />
    {/if}
    {#if faceEnrolled}
      <div class="gfilter" role="tablist" aria-label="Filter photos">
        <button class="gchip" class:on={!meOnly} on:click={() => (meOnly = false)}>All <span class="n">{photos.length}</span></button>
        <button class="gchip" class:on={meOnly} on:click={() => (meOnly = true)}>Me <span class="n">{facePhotoIds.size}</span></button>
      </div>
    {/if}
    {#if anyHearts}
      <!-- The same chip row as the face filter, because it is the same kind of choice. -->
      <div class="gfilter" role="tablist" aria-label="Sort photos">
        <button class="gchip" class:on={sort === 'newest'} on:click={() => (sort = 'newest')}>Newest</button>
        <button class="gchip" class:on={sort === 'hearted'} on:click={() => (sort = 'hearted')}>Most loved</button>
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
         style={`--tile-ar:${tileAspect(event?.aspectRatios)};${tileVars(tileSize)}`}>
      {#each shownPhotos as p, i (p.id)}
        <PhotoCard photo={p} selected={selecting && selected.has(p.id)}
                   selectable={selecting}
                   saved={saved.has(p.id)}
                   hearts={event?.heartsEnabled ? (heartCounts[p.id] ?? 0) : undefined}
                   hearted={heartMine.has(p.id)}
                   canHeart={canReact && !selecting}
                   comments={event?.commentsEnabled ? (p.comments ?? 0) : undefined}
                   on:heart={(e) => toggleHeart(p, e.detail)}
                   canDownload={revealed && allowDownloads && !selecting}
                   saving={savingOne === p.id}
                   tileAr={tileAspect(event?.aspectRatios)}
                   meta={`${p.participantName} · ${fmtTime(p.takenAt)}`}
                   tileLabel={selecting ? `Select photo by ${p.participantName}` : `Open photo by ${p.participantName}`}
                   on:open={() => onThumb(p, i)}
                   on:download={() => saveOne(p)}>
          <svelte:fragment slot="tile">
            <!-- Top-RIGHT, off the heart's corner. In select mode it steps aside for the tick
                 rather than disappearing — see `.star.aside`. -->
            {#if p.isHighlighted}
              <span class="star" class:aside={selecting} title="The host's favourite"><StarIcon filled size={17} /></span>
            {/if}
          </svelte:fragment>
        </PhotoCard>
      {/each}
    </div>

    <!-- The bottom of the grid, watched rather than scrolled-for. Rendered only while there IS a
         next page, so a finished gallery has nothing hanging off the end of it. -->
    {#if nextCursor}
      <div class="more" bind:this={sentinel}>
        <span class="more-dot" aria-hidden="true"></span>
        <span class="vh">Loading more photos</span>
      </div>
    {/if}
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
  <!-- Two pick events, one question — see the dispatcher in ShareScope.svelte for why the hearts
       scopes travel separately. Both land in the same handler here. -->
  <ShareScope action="download" voice="guest" approvedCount={photos.length} favouriteCount={dlFavourites.length}
              heartedCount={dlHearted.length} bothCount={dlBoth.length}
              videoCount={dlVideos} canSelect={true} newCount={dlNew.length}
              on:pick={(e) => pickDownloadScope(e.detail)}
              on:pickHearts={(e) => pickDownloadScope(e.detail)}
              on:close={() => (dlScopeOpen = false)} />
{/if}

{#if lbOpen}
  <!-- Only when the host has allowed downloads: this is everyone's album, not the guest's own roll. -->
  <!-- rotateMode 'own': a guest may straighten a shot of their own that the phone stored sideways,
       and nothing else in this album. A stranger holding the link has no session to do it with and
       is offered nothing. The host's own surface is the review screen, which does not use this
       component. -->
  <Lightbox photos={shownPhotos} index={lbIndex} allowSave={allowDownloads}
            rotateMode={guestToken ? 'own' : 'none'}
            commentsOn={canComment} {code} sessionToken={guestToken}
            {visitorToken}
            ensureVisitor={guestToken ? null : ensureVisitor}
            ensureNamed={guestToken ? null : ensureNamed}
            hearts={event?.heartsEnabled ? (heartCounts[shownPhotos[lbIndex]?.id ?? ''] ?? 0) : undefined}
            hearted={heartMine.has(shownPhotos[lbIndex]?.id ?? '')}
            canHeart={canReact}
            on:heart={(e) => { const p = shownPhotos[lbIndex]; if (p) void toggleHeart(p, e.detail); }}
            on:photochange={(e) => (lbIndex = e.detail)}
            on:saved={(e) => (saved = markSaved(code, [e.detail]))}
            on:rotated={(e) => applyRotation(e.detail.result)}
            on:commented={(e) => bumpComments(e.detail.id, e.detail.delta)}
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
  .gchip.on { border-color: var(--accent); background: var(--accent-fill); color: var(--accent-ink, #111); }
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
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; text-decoration: none; color: var(--text); flex: none; }
  /* Pinned to the first row with the brand — never shrinks, never wraps. */
  .back-ev { flex: none; }
  /* Takes the width left beside the brand and packs to the RIGHT. Left-aligned inside a box only
     as wide as its widest row, the buttons wrapped earlier than they had to and the sticky bar grew
     a row it did not need. */
  .nav-right { display: flex; gap: 8px; flex-wrap: wrap; flex: 1 1 auto; justify-content: flex-end; }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 7px 14px; font-size: .82rem;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; }
  /* `class="btn primary"` was on this page with no rule behind it, so the gallery's primary action
     painted in the UA's ButtonFace instead of the brand gold — the same class of bug as the guest
     list and the share-link row; app.css explains why the rule has to be local, not global.
     Spelled `.primary` to match `.ghost` directly below, which is this file's convention. */
  .primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
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
  /* The moderated wait. A heading rather than one grey line, because it is an explanation of why
     the page is empty and not a shrug. */
  .state-t { font-size: 1.1rem; font-weight: 700; color: var(--text); margin: 0 0 8px; }
  .state-d { font-size: .9rem; margin: 0 auto; max-width: 34ch; line-height: 1.45; }

  .reveal-wall {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; gap: 14px; padding: 64px 16px; min-height: 50dvh;
  }
  .reveal-wall .lock { font-size: 3rem; }
  .reveal-wall .msg { font-size: 1.15rem; font-weight: 700; max-width: 28ch; }
  .ask-host { margin: 6px 0 0; font-weight: 700; color: var(--accent); }
  .reveal-wall .count { color: var(--text-muted); font-size: .9rem; }
  .countdown {
    font-family: var(--font-mono); font-size: clamp(1.6rem, 8vw, 2.6rem); font-weight: 800;
    color: var(--accent); letter-spacing: .04em;
  }

  /* The grid and the card itself are PhotoCard's (.pgrid / .pcell-wrap). All that belongs to this
     page is what it overlays on the tile. */
  /* Mirrored copy of the heart's flush corner wash — see PhotoCard.svelte. */
  /* Deliberately quiet: this is not a control and pressing it does nothing. It marks the place the
     next page arrives, and on a fast connection it is gone before anyone reads it. */
  .more { display: flex; align-items: center; justify-content: center; padding: 26px 0 40px; }
  .more-dot { width: 26px; height: 26px; border-radius: 50%; border: 2px solid var(--border);
    border-top-color: var(--accent); animation: more-spin 720ms linear infinite; }
  @keyframes more-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .more-dot { animation: none; opacity: .6; } }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .name-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 320;
    display: flex; align-items: center; justify-content: center; padding: 18px; }
  .name-box { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 22px; width: min(400px, 100%); }
  .name-box h2 { margin: 0 0 4px; font-size: 1.1rem; }
  .name-box p { margin: 0 0 14px; font-size: .85rem; color: var(--text-muted); }
  .name-box input { width: 100%; padding: 10px 12px; border-radius: var(--radius-sm); font-size: 1rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  .name-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
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
  /* ── Save-or-zip chooser ── */
</style>

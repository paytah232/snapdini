<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { savePhotoByUrl } from '$lib/saveImage';
  import DownloadIcon from '$lib/components/DownloadIcon.svelte';
  import HeartIcon from '$lib/components/HeartIcon.svelte';
  import RotateControl from '$lib/components/RotateControl.svelte';
  import { fitScaleFor, previewTransform } from '$lib/rotatePreview';
  import { mediaMeta, getComments, addComment, deleteComment,
           getShareComments, addShareComment, deleteShareComment,
           setCommentHeart, shareCommentHeart,
           rotatePhoto, normalizeTurn,
           type Photo, type PhotoComment, type PhotoRotation } from '$lib/events';
  import { writeFailed } from '$lib/api';
  import { clampComment, COMMENT_MAX } from '../../../../shared/comment';
  import { showToast } from '$lib/toast';
  import { wantSound } from '$lib/sound';
  import { compactCount } from '$lib/counts';

  export let photos: Photo[] = [];
  export let index = 0;

  /** Who may caption from in here. 'own' = only the viewer's own shots (the guest's roll), 'any' =
   *  every photo (the host, in Review), 'none' = the read-only galleries. Opening the same editor
   *  the grid uses, rather than a second one, is the whole point: a caption written full-screen and
   *  a caption written on a tile have to behave identically. */
  export let captionMode: 'none' | 'own' | 'any' = 'none';
  /** Who may turn a photo the phone stored sideways. The same three answers as captionMode, and
   *  the same reasoning: 'own' is a guest's own shots, 'any' is the host over their whole event,
   *  'none' is every surface where a viewer is only a viewer.
   *
   *  Deliberately NOT inferred from holding an organizerCode or a sessionToken. Those say who is
   *  asking; they do not say that THIS screen is a place to write from — a share link hands the
   *  lightbox a visitor token and a read-only gallery hands it a session, and neither is an
   *  invitation to re-encode somebody's photograph. The parent decides, as it does for captions. */
  export let rotateMode: 'none' | 'own' | 'any' = 'none';
  /** Offer the download. Off where the host has not allowed downloads. (It reaches Photos via the
   *  share sheet on iOS and a download on Android — one word for both, see saveThis.) */
  export let allowSave = false;
  /** Comments. `code` + `sessionToken` (or `organizerCode`) is what lets this fetch and post; with
   *  neither, the thread is read-only, which is right for a stranger on a shared gallery link. */
  export let commentsOn = false;
  export let code = '';
  export let sessionToken: string | null = null;
  export let organizerCode: string | null = null;
  /** Share-link mode. With `shareToken` set the thread is fetched and posted through the share API
   *  instead of the event's: the person reading has no join code and no session, only the link.
   *  `ensureVisitor` is the page's "ask for a name" step — it resolves to a visitor token once they
   *  have given one, or null if they backed out, and is only ever called when they try to write. */
  export let shareToken = '';
  export let visitorToken: string | null = null;
  /** TWO steps, deliberately kept apart. `ensureVisitor` mints an identity SILENTLY — all a heart
   *  needs, since nothing shows who pressed one. `ensureNamed` is the one that asks, because a
   *  comment puts words under a name. Wiring hearts to the asking one would put a dialog in front
   *  of the smallest gesture in the product. */
  export let ensureVisitor: (() => Promise<string | null>) | null = null;
  export let ensureNamed: (() => Promise<string | null>) | null = null;
  /** The photo's own heart, here as well as on the tile. Looking at a shot full-screen — and
   *  reading what people said about it — is exactly when someone decides they love it, and having
   *  to close the photo and find the tile again to say so is the wrong way round.
   *  `hearts` undefined means the whole thing is absent, the same convention PhotoCard uses. */
  export let hearts: number | undefined = undefined;
  export let hearted = false;
  export let canHeart = false;
  /** Who may write here: a guest with a session, or a LINK visitor — on a curated /s/ share or on
   *  the event's own gallery link (0063). `ensureVisitor` being set is what says "this surface can
   *  mint an identity"; without a session and without it, the thread is read-only, which is right
   *  for a stranger where the host has not opened things up. */
  $: canWrite = !!sessionToken || !!ensureNamed || (!!visitorToken && !!shareToken);
  $: canCaption = captionMode === 'any' || (captionMode === 'own' && !!photo?.isOwn);
  $: canRotate = rotateMode === 'any' || (rotateMode === 'own' && !!photo?.isOwn);

  const dispatch = createEventDispatcher<{ close: void; caption: Photo; photochange: number; saved: string; commented: { id: string; delta: number }; heart: boolean;
    rotated: { id: string; quarter: number; result: PhotoRotation } }>();

  // ── The thread on the photo being looked at ────────────────────────────────
  // Fetched per photo rather than carried on the gallery payload: a thread is only ever read while
  // a photo is open, and the gallery reply is shared-cacheable — a comment written thirty seconds
  // ago would sit behind that cache for everyone else.
  let thread: PhotoComment[] = [];
  let threadFor = '';
  let draft = '';
  let posting = false;
  /** Which comment's delete is armed. Cleared whenever the thread changes underneath it, so an
   *  armed bin cannot survive onto a different photo and delete something else's first line. */
  let confirmDel: string | null = null;

  /** How the thread is ordered. Oldest first by default, because a thread under a photo reads as a
   *  conversation and a default that reorders itself as hearts land moves the comment you just
   *  wrote out from under you. Most loved is the choice you make when the thread is long enough for
   *  the question to matter. */
  let sort: 'oldest' | 'loved' = 'oldest';
  // Never sorted in place: `thread` is the server's order, and sorting it would make "oldest" mean
  // whatever the last sort left behind.
  $: shownThread = sort === 'loved'
    ? [...thread].sort((a, b) => (b.hearts ?? 0) - (a.hearts ?? 0))
    : thread;
  $: anyCommentHearts = thread.some((c) => (c.hearts ?? 0) > 0);

  /** A long thread arrives folded. Twenty-five remarks under one photo is a wall to scroll past on
   *  the way to the box you actually came to type in, and most of it is read by nobody. The first
   *  dozen is enough to see what kind of thread it is; the rest is there for whoever wants it. */
  const THREAD_FOLD = 12;
  let threadOpen = false;
  $: folded = !threadOpen && shownThread.length > THREAD_FOLD;
  $: visibleThread = folded ? shownThread.slice(0, THREAD_FOLD) : shownThread;
  $: hiddenCount = shownThread.length - visibleThread.length;

  async function heartComment(c: PhotoComment) {
    const want = !c.hearted;
    const before = c.hearts ?? 0;
    // Optimistic on the DELTA only — the server's own total replaces it. Guessing the total is what
    // drifts when two people press at once.
    const set = (hearts: number, hearted: boolean) => {
      thread = thread.map((x) => (x.id === c.id ? { ...x, hearts, hearted } : x));
    };
    set(Math.max(0, before + (want ? 1 : -1)), want);
    try {
      let r: { hearts: number };
      if (shareToken) {
        const vt = visitorToken ?? (ensureVisitor ? await ensureVisitor() : null);
        if (!vt) { set(before, !want); return; }
        r = await shareCommentHeart(shareToken, c.id, vt, want);
      } else {
        // A heart needs an identity but not a name, so this mints one silently where it can.
        let vt: string | null = null;
        if (!sessionToken) {
          vt = visitorToken ?? (ensureVisitor ? await ensureVisitor() : null);
          if (!vt) { set(before, !want); return; }
        }
        r = await setCommentHeart(c.id, sessionToken ?? '', want, vt);
      }
      set(r.hearts, want);
    } catch {
      set(before, !want);
      showToast('Could not save that', true);
    }
  }

  $: if (commentsOn && photo?.id && photo.id !== threadFor) { threadFor = photo.id; void loadThread(photo.id); }

  async function loadThread(id: string) {
    thread = [];
    confirmDel = null;
    threadOpen = false;
    if (!code && !shareToken) return;
    try {
      const r = shareToken
        ? await getShareComments(shareToken, [id], visitorToken)
        : await getComments(code, [id], {
            sessionToken: sessionToken ?? undefined, organizerCode: organizerCode ?? undefined,
            visitorToken,
          });
      // Guard against a slow reply for a photo the viewer has already paged past.
      if (threadFor === id) thread = r.comments[id] ?? [];
    } catch { /* a thread that will not load must not take the photo down with it */ }
  }

  async function postComment() {
    const body = clampComment(draft);
    if (!body || !canWrite || posting) return;
    posting = true;
    try {
      let added: PhotoComment;
      if (shareToken) {
        // Always THROUGH ensureVisitor, never short-circuited on `visitorToken` already being set.
        // Holding a token is not the same as having given a name: hearting mints one silently, so
        // somebody who hearted first arrives here with a token and no name, and skipping the ask
        // sent the comment straight into the server's "Enter your name first" with nothing on
        // screen to explain it. The page's own handler returns immediately when it has both.
        const vt = ensureNamed ? await ensureNamed() : visitorToken;
        if (!vt) { posting = false; return; }
        added = await addShareComment(shareToken, photo.id, vt, body);
      } else {
        // Same two-step as the share path: a guest posts with their session, anybody else is asked
        // for a name first. Always THROUGH ensureVisitor — holding a token is not having a name.
        let vt: string | null = null;
        if (!sessionToken) {
          vt = ensureNamed ? await ensureNamed() : visitorToken;
          if (!vt) { posting = false; return; }
        }
        added = await addComment(photo.id, sessionToken ?? '', body, vt);
      }
      thread = [...thread, added];
      draft = '';
      // The card behind us shows a count; tell it rather than making it refetch the gallery.
      dispatch('commented', { id: photo.id, delta: 1 });
    } catch { showToast('Could not post that', true); }
    finally { posting = false; }
  }

  async function removeComment(c: PhotoComment) {
    try {
      if (shareToken && visitorToken) await deleteShareComment(shareToken, c.id, visitorToken);
      else await deleteComment(c.id, { sessionToken: sessionToken ?? undefined,
                                       organizerCode: organizerCode ?? undefined, visitorToken });
      thread = thread.filter((x) => x.id !== c.id);
      confirmDel = null;
      dispatch('commented', { id: photo.id, delta: -1 });
    } catch { showToast('Could not remove that', true); }
  }
  // ── Sound ───────────────────────────────────────────────────────────────────
  //
  // A clip used to autoplay asking for sound. Browsers do not simply grant that: without a user
  // gesture the policy decides, and the outcomes differ — some refuse to start, some start muted.
  // Starting muted with nothing saying so is the worst of them, because the clip IS playing and
  // there is nothing to press.
  //
  // So it starts muted and says so, and one tap turns sound on for the rest of the visit: that tap
  // is the gesture the policy wanted, so every clip after it plays with sound straight away. Kept
  // in memory rather than storage — it is about this visit, and a new tab has not made the gesture.
  /** Just the picture: caption, thread and everything else out of the way.
   *
   *  A layout state rather than the Fullscreen API, the same call the review screen made — iOS
   *  Safari will not take an arbitrary element fullscreen, so the API version works on some of the
   *  devices this is most wanted on and silently does nothing on the rest. */
  let photoOnly = false;

  let videoEl: HTMLVideoElement | undefined;
  function enableSound() {
    $wantSound = true;
    if (videoEl) {
      videoEl.muted = false;
      // The play() is what converts the tap into the gesture the policy is looking for; a clip
      // paused by a failed autoplay starts here too.
      void videoEl.play().catch(() => { /* already playing, or the browser said no */ });
    }
  }
  // Someone who unmutes with the native controls has said the same thing — remember it, so the next
  // clip does not go back to silent and make them say it twice.
  function onVolumeChange(e: Event) {
    const el = e.currentTarget as HTMLVideoElement;
    if (!el.muted && el.volume > 0) $wantSound = true;
  }

  // A clip opened after sound is already on starts with it: the attribute alone can lose the race
  // with autoplay, which begins the moment the element is attached.
  $: if (videoEl && $wantSound) videoEl.muted = false;

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

  // Tell the parent when the subject changes, so anything it is showing ABOUT this photo — a
  // "Caption saved" confirmation, say — goes with it rather than hanging over the next one.
  let saving = false;
  let savedMsg = '';
  async function saveThis() {
    if (saving || !photo) return;
    saving = true; savedMsg = '';
    try {
      const stamp = new Date(photo.takenAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const ext = photo.mediaType === 'video' ? 'mp4' : 'jpg';
      const out = await savePhotoByUrl(photo.url, `snapdini-${stamp}.${ext}`);
      // A cancelled share is the guest's decision, so it says nothing at all.
      // One word for the outcome whichever route the device took. iOS reaches Photos through the
      // share sheet and Android through a download, and naming each after its mechanism made the
      // same button report two different things on two phones.
      if (out === 'shared' || out === 'downloaded') savedMsg = '✓ Downloaded';
      else if (out === 'failed') savedMsg = 'Couldn’t download';
      // Tell the grid behind us, so the tick appears on the tile the moment this closes. Only on
      // an outcome that actually reached the device — a cancel or a failure marks nothing.
      if (out === 'shared' || out === 'downloaded') dispatch('saved', photo.id);
    } catch { savedMsg = 'Couldn’t download'; }
    finally {
      saving = false;
      if (savedMsg) setTimeout(() => (savedMsg = ''), 2500);
    }
  }

  // ── Turning a photo the phone stored sideways ───────────────────────────────
  //
  // With rotation lock on, a landscape scene is written into a portrait-shaped file and nothing
  // downstream can see the difference — capture_orientation records that the phone was HELD
  // sideways and never which way up, so the only one who knows is the person looking at it. That
  // is why this is a manual control at all, and why it is PREVIEW THEN COMMIT: turn it on screen
  // until it looks right, then write it once. A request per 90° tap would re-encode the file,
  // republish it and evict it from every cache three times over on the way to a place one request
  // could have reached.

  /** Degrees clockwise turned on screen and not yet written; 0 when nothing is pending.
   *  Folded into (-180, 180] on every tap, so a fourth tap really is 0 — and the Save that would
   *  have posted a full circle is not there to be pressed. */
  let turn = 0;
  let rotating = false;
  /** Which photo `turn` belongs to.
   *
   *  The subject does not only change on prev/next: the gallery behind us polls and hands down a
   *  fresh `photos` array, so whatever sits at `index` can become a different photograph with
   *  nothing in here being called. Keyed on the id, a half-finished turn cannot leak onto the next
   *  one — which is the single way this feature could do real damage. */
  let turnFor = '';
  $: if (photo?.id !== turnFor) { turnFor = photo?.id ?? ''; turn = 0; }

  /** The corrected media, held here until the parent's own state catches up.
   *
   *  Keyed by id and never written back into `photos`: that array belongs to the page that opened
   *  us, and a child reaching into its parent's state is how two copies of the truth begin. The
   *  parent is told instead (`rotated`, carrying the whole reply) and folds it in. This exists so
   *  the picture in front of the person who pressed Save is the corrected one on that tick.
   *
   *  It has to hold the NEW NAMES, not a flag saying "re-fetch": the rotation renamed the file and
   *  the old name is already unlinked, so anything still pointing at it is a broken image rather
   *  than a stale one. */
  let fixed: { id: string; url: string; playUrl?: string } | null = null;
  $: mended = fixed && photo && fixed.id === photo.id ? fixed : null;
  $: stillSrc = mended?.url ?? photo?.url ?? '';
  $: clipSrc = mended?.playUrl ?? mended?.url ?? photo?.playUrl ?? photo?.url ?? '';

  /** How far to shrink a quarter-turned picture so it still fits the room it had — see
   *  rotatePreview.ts, which is where the reasoning lives now that the review screen runs the
   *  same preview through the same two lines. */
  let imgEl: HTMLImageElement | undefined;
  let fitScale = 1;
  function measureFit() {
    const el: HTMLElement | undefined = photo?.mediaType === 'video' ? videoEl : imgEl;
    fitScale = fitScaleFor(el?.offsetWidth ?? 0, el?.offsetHeight ?? 0);
  }
  $: preview = previewTransform(turn, fitScale);

  function turnBy(q: number) {
    if (rotating) return;
    // Measured at the tap. The element is laid out by now, and a transform never changes a layout
    // box, so this answers the same thing however many turns it has already been given.
    measureFit();
    turn = normalizeTurn(turn + q);
  }

  async function saveTurn() {
    const p = photo;
    if (!p || rotating) return;
    const quarter = normalizeTurn(turn);
    // Four taps is where it started: nothing to write, and nothing to tell the parent about. The
    // route refuses 0 anyway, and is right to — honouring it would rename the file and unlink the
    // old name to hand back the same picture — so sending it would be a round trip spent earning
    // an error for a viewer who has done nothing wrong.
    if (quarter === 0) { turn = 0; return; }
    rotating = true;
    try {
      // The caption's pair of credentials, and exactly one of them: the host's code reaches any
      // photo in their event, a guest's session reaches only their own.
      const who: { sessionToken: string } | { organizerCode: string } =
        organizerCode ? { organizerCode } : { sessionToken: sessionToken ?? '' };
      // The one place the running total meets the API's literal union. `turn` is only ever
      // normalizeTurn of a multiple of 90, so it is one of these three or it is 0 — and 0 returned
      // two lines up.
      const r = await rotatePhoto(p.id, quarter as 90 | -90 | 180, who);
      // The reply's own urls, never the ones we came in with — see PhotoRotation. playUrl can be
      // absent for a moment after a clip is turned (the crop is rebuilt behind the response), and
      // `url` is the right thing to play until it lands, which is the ladder the markup already
      // walks for every other clip.
      fixed = { id: p.id, url: r.url, playUrl: r.playUrl };
      // Dropped only once the corrected source is in hand, so the picture never flicks back to the
      // orientation that was just corrected while the new bytes are still on the wire.
      turn = 0;
      // The grid behind us is still showing the old thumbnail. Tell it — the same call every other
      // change in here makes, rather than writing into an array we do not own.
      dispatch('rotated', { id: p.id, quarter, result: r });
    } catch (e) {
      // 404 is this route's answer for "not yours" as well as "not there" — it will not confirm
      // that somebody else's photo id exists. Both are the same sentence to the person looking at
      // it, and api() already writes it; a 409 (two rotations racing) arrives with the server's
      // own words. The fallback is only for a failure that brought none.
      showToast(writeFailed(e, 'Could not rotate that'), true);
    } finally { rotating = false; }
  }

  // Paging DISCARDS a pending turn rather than standing in the way of it. The turn is a preview
  // nobody has committed to, and a viewer held on one picture until they answer a question about
  // it is a worse thing to build than one who has to press rotate again. The discard itself is the
  // `turnFor` guard above, which also covers the routes to another photo that do not come through
  // here (the gallery's poll being the one that matters). What IS refused is moving mid-write: for
  // the moment a save is in flight the photo under the request stays the photo on screen.
  function prev() { if (!rotating && index > 0) { index--; dispatch('photochange', index); } }
  function next() { if (!rotating && index < photos.length - 1) { index++; dispatch('photochange', index); } }
  function onKey(e: KeyboardEvent) {
    // Someone typing has the keyboard, not the viewer. Without this, writing a caption over the
    // lightbox pages the album out from under the half-typed text, and Escape closes the photo
    // instead of the editor — arrow keys in a textarea are how you move the cursor.
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    // One layer at a time: Escape out of photo-only first, and only then out of the photo. Closing
    // the lot from inside photo-only loses the thread somebody was reading. An un-saved rotation
    // is a layer too — and the innermost one bar an armed delete, because it is the thing the
    // viewer is in the middle of doing.
    if (e.key === 'Escape') {
      if (confirmDel) confirmDel = null;
      else if (turn) turn = 0;
      else if (photoOnly) photoOnly = false;
      else dispatch('close');
    }
    else if (e.key === 'f') photoOnly = !photoOnly;
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'ArrowRight') next();
  }
</script>

<!-- A tap anywhere else backs out of an armed delete — the same way out the camera gives it. The
     bin stops propagation, so this only ever sees taps that are NOT the confirm button. Without it
     the only way to clear an armed bin was to page to another photo. -->
<svelte:window on:keydown={onKey} on:click={() => (confirmDel = null)} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="lb" class:stacked={commentsOn && !photoOnly} class:bare={photoOnly} bind:this={lbEl} on:click|self={() => dispatch('close')} role="dialog" aria-modal="true" aria-label="Photo viewer" tabindex="-1">
  <!-- One bar, so the controls cannot drift out of line with each other. They were three separately
       positioned buttons at slightly different tops and heights, which is exactly the sort of thing
       that only shows up once someone looks at it on a phone. A flex row makes alignment structural
       rather than three numbers that have to be kept in step by hand.

       THREE groups, not two, and the third is the point. The bar used to be "caption on the left,
       everything else on the right", with the right-hand group wrapping as a whole — so on a phone
       the last thing on it, which is Close, was the thing that dropped to a second line, and it
       dropped to a DIFFERENT line depending on how many controls the photo happened to offer. The
       window chrome (just-the-photo, Close) is now its own group that never wraps and never leaves
       the top-right corner; the actions wrap underneath themselves instead. -->
  <div class="lb-bar">
    {#if canCaption}
      <!-- Rendered only when it is offered, rather than an empty box holding the left end of a
           space-between: with the box always present, a bar with no caption button still reserved
           a column for one. `.lb-bar-r` takes the right-hand end with an auto margin instead, which
           is true whether or not this is here. -->
      <div class="lb-bar-l">
        <!-- Looking at a photo full-screen is when someone actually thinks of what to say about it;
             making them close it and find the tile again is the wrong way round. -->
        <button class="lb-btn" on:click|stopPropagation={() => dispatch('caption', photo)}
                aria-label={photo.caption ? 'Edit this caption' : 'Add a caption'}>
          💬 {photo.caption ? 'Edit caption' : 'Add a caption'}
        </button>
      </div>
    {/if}
    <div class="lb-bar-r">
      {#if allowSave || canRotate}
        <div class="lb-acts">
          {#if allowSave}
            <!-- iOS has no API that writes to the camera roll, so a download lands in Files. The
                 share sheet has "Save Image" on it. Android goes straight to a download instead —
                 its sheet only offers apps to send the photo TO, which is not keeping it. See
                 saveImage.ts. -->
            <button class="lb-btn" on:click|stopPropagation={saveThis} disabled={saving}
                    aria-label="Download this photo to your device">
              {#if saving}…{:else if savedMsg}{savedMsg}{:else}<DownloadIcon /> Download{/if}
            </button>
          {/if}
          {#if canRotate}
            <!-- Next to Download because that is where the owner asked for it and because both are
                 things you do TO the photo you are looking at. Nothing is written until Save; see
                 `turn` for why a request per tap was the wrong shape, and RotateControl for why the
                 slot no longer changes size when you press it. -->
            <RotateControl variant="bar" pending={turn} busy={rotating}
                           on:turn={(e) => turnBy(e.detail)} on:save={saveTurn}
                           on:cancel={() => (turn = 0)} />
          {/if}
        </div>
      {/if}
      <div class="lb-chrome">
        <!-- Only worth offering when there is something to get out of the way. -->
        {#if commentsOn || photo?.caption || photo?.challenge}
          <button class="lb-btn" on:click|stopPropagation={() => (photoOnly = !photoOnly)}
                  aria-pressed={photoOnly}
                  title={photoOnly ? 'Show the details' : 'Just the photo'}
                  aria-label={photoOnly ? 'Show the details' : 'Just the photo'}>
            {photoOnly ? '⤢' : '⛶'}
          </button>
        {/if}
        <button class="lb-btn close" on:click={() => dispatch('close')} aria-label="Close">✕</button>
      </div>
    </div>
  </div>
  {#if photo}
    {#if photo.mediaType === 'video'}
      <!-- svelte-ignore a11y-media-has-caption -->
      <!-- playUrl when it exists: the original may be VP8/WebM, which stutters on phones and does
           not play at all in Safari. Downloads still take the original. -->
      <!-- muted, then unmuted the moment the browser will allow it. See `wantSound` below: an
           autoplay that asks for sound is the browser's decision, not ours, and the answer varies —
           which is how a clip ends up playing silently with nothing on screen to say why. -->
      <!-- Wrapped so the sound prompt can sit against the BOTTOM OF THE PICTURE. Positioned on
           `.lb` it was placed against the viewport instead, which put it somewhere different on
           every clip depending on how tall the video happened to be. -->
      <div class="media">
        <!-- svelte-ignore a11y-media-has-caption -->
        <!-- The preview transform applies here too: a clip shot sideways is the same complaint,
             and the server turns one losslessly through its display matrix. The browser's own
             control bar is part of the element and turns with the picture while a rotation is
             pending, which is odd to look at for the few seconds it is there — the alternative was
             a video whose rotate button did nothing visible until after it had been committed,
             which is worse. -->
        <video bind:this={videoEl} src={clipSrc}
               controls autoplay playsinline muted={!$wantSound}
               style:transform={preview} on:loadedmetadata={measureFit}
               on:volumechange={onVolumeChange}></video>
        {#if !$wantSound}
          <button class="unmute" on:click|stopPropagation={enableSound}>🔇 Sound</button>
        {/if}
      </div>
    {:else}
      <img bind:this={imgEl} src={stillSrc} alt="Photo by {photo.participantName}" decoding="async"
           style:transform={preview} on:load={measureFit} />
    {/if}
    <!-- Whatever the grid captioned this with must not vanish on the way into the photo. The
         written caption leads; the mission follows it, demoted, so a captioned trick shot still
         says which trick it was. -->
    <!-- Three tiers, not one run. Everything used to be the same size on one full-width line, so
         the words somebody wrote sat level with the pixel dimensions and the caption was bold at
         0.82rem — small AND bold, which is the least legible pairing there is. -->
    <div class="cap" hidden={photoOnly}>
      {#if photo.caption}<p class="cap-written">{photo.caption}</p>{/if}
      {#if photo.challenge}<p class="cap-mission" class:secondary={!!photo.caption}>{photo.challenge}</p>{/if}
      <p class="cap-meta">
        {#if hearts !== undefined}
          <!-- First on the row, before the name and the timestamp: it is the one thing here you can
               press, and the rest is description. -->
          <button class="cap-heart" class:on={hearted} disabled={!canHeart}
                  on:click|stopPropagation={() => canHeart && dispatch('heart', !hearted)}
                  aria-pressed={hearted}
                  aria-label={!canHeart ? `${hearts} hearts` : hearted ? 'Remove your heart' : 'Heart this photo'}
                  title={!canHeart ? `${hearts} ${hearts === 1 ? 'heart' : 'hearts'}` : hearted ? 'Remove your heart' : 'Heart this photo'}>
            <HeartIcon filled={hearted} size={17} />
            {#if hearts > 0}<span class="hn">{compactCount(hearts)}</span>{/if}
          </button>
          <span class="sep" aria-hidden="true">·</span>
        {/if}
        <span class="who">{photo.participantName}</span>
        <span class="sep" aria-hidden="true">·</span>{shotAt(photo.takenAt)}
        {#if mediaMeta(photo)}<span class="sep" aria-hidden="true">·</span>{mediaMeta(photo)}{/if}
        <span class="sep" aria-hidden="true">·</span>{index + 1} of {photos.length}
      </p>
      {#if commentsOn}
        <div class="thread">
          {#if anyCommentHearts && thread.length > 2}
            <!-- Shown only once there is something to sort BY and enough of a thread for the order
                 to matter — a control that reorders three comments by a column of zeroes reads as
                 broken. -->
            <div class="thread-sort">
              <button class="tsort" class:on={sort === 'oldest'} on:click|stopPropagation={() => (sort = 'oldest')}>Oldest</button>
              <button class="tsort" class:on={sort === 'loved'} on:click|stopPropagation={() => (sort = 'loved')}>Most loved</button>
            </div>
          {/if}
          {#each visibleThread as c (c.id)}
            <p class="cmt">
              <span class="cmt-who">{c.author}</span>
              <!-- Marked, not hidden: anybody can type any name into a forwarded link, so the thread
                   says which names were actually at the event and which were not. -->
              {#if c.authorKind === 'visitor'}<span class="cmt-via" title="Commented from a shared link — not a guest at the event">via link</span>{/if}
              <!-- `{c.body}` — Svelte escapes this. NEVER {@html}: this is text a guest typed and
                   it is rendered to every other guest at the event. -->
              <span class="cmt-body">{c.body}</span>
              <!-- Bin and heart travel together on the right, in that order: the bin sits INSIDE and
                   the heart takes the edge. The auto margin lives on the GROUP, so the row lays out
                   the same whether or not this viewer can delete the comment. -->
              <span class="cmt-acts">
                {#if c.canDelete}
                  <!-- Two-step, the same as deleting a shot in the camera: the first tap arms it,
                       the second commits. Both labels are always present with one hidden, so arming
                       it cannot resize the thing you are about to tap a second time. -->
                  <button class="cmt-x" class:confirm={confirmDel === c.id}
                          on:click|stopPropagation={() => (confirmDel === c.id ? removeComment(c) : (confirmDel = c.id))}
                          title={confirmDel === c.id ? 'Tap again to delete' : 'Delete this comment'}
                          aria-label={confirmDel === c.id ? 'Tap again to confirm deleting this comment' : 'Delete this comment'}>
                    <span class="lbl" class:off={confirmDel === c.id} aria-hidden="true">🗑️</span>
                    <span class="lbl" class:off={confirmDel !== c.id} aria-hidden="true">Sure?</span>
                  </button>
                {/if}
                <!-- The ICON is pinned to the left of a fixed-width slot and the count grows
                     RIGHTWARD into the rest of it. That is the whole trick: a right-aligned button
                     that sizes to its contents shifts its icon left every time the number gets a
                     digit longer, so the heart you are aiming at drifts as the count climbs. The
                     slot never changes width, so the icon never moves — and the heart is not hard
                     against the edge, because the space reserved for the count is what sits there. -->
                <button class="cmt-heart" class:on={c.hearted} disabled={!canWrite}
                        on:click|stopPropagation={() => canWrite && heartComment(c)}
                        aria-pressed={!!c.hearted}
                        aria-label={c.hearted ? 'Remove your heart' : 'Heart this comment'}>
                  <HeartIcon filled={!!c.hearted} size={13} />
                  <span class="chn">{(c.hearts ?? 0) > 0 ? compactCount(c.hearts ?? 0) : ''}</span>
                </button>
              </span>
            </p>
          {/each}
          {#if folded}
            <!-- Under the comments and above the box, which is the order they are read in. -->
            <button class="cmt-more" on:click|stopPropagation={() => (threadOpen = true)}>
              Show {hiddenCount} more
            </button>
          {/if}
          {#if canWrite}
            <form class="cmt-new" on:submit|preventDefault={postComment}>
              <!-- Neutral on purpose. "Say something nice" tells people what to feel as well as
                   what to type, and it reads oddly on the one comment somebody needs to write that
                   isn't a compliment. -->
              <input bind:value={draft} maxlength={COMMENT_MAX} placeholder="Add a comment…"
                     aria-label="Add a comment" />
              <button class="btn" type="submit" disabled={posting || !draft.trim()}>{posting ? '…' : 'Post'}</button>
            </form>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  {#if index > 0}<button class="nav l" on:click={prev} aria-label="Previous">‹</button>{/if}
  {#if index < photos.length - 1}<button class="nav r" on:click={next} aria-label="Next">›</button>{/if}
</div>

<style>
  .lb { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.92); z-index: 300;
    display: flex; align-items: center; justify-content: center; padding: 24px; }
  /* The transition is what makes a rotation read as a TURN rather than a jump cut — it is the
     movement that tells somebody the picture moved, and did not simply come back different. */
  img, video { max-width: 100%; max-height: 86vh; border-radius: 8px;
    transition: transform .18s ease; }

  /* ── Stacked: the photo, then the words UNDER it ──────────────────────────────────────────────
   *
   * The caption block is absolutely positioned over the bottom of the picture, which is right for a
   * line or two of caption and wrong the moment a thread is in it: it covers the photo it is about,
   * and — because the overlay is `pointer-events: none` so the picture stays clickable through it —
   * the thread could not be scrolled, clicked or reached at all. It was a caption that had grown
   * into a panel while keeping a caption's positioning.
   *
   * So with comments on, the whole dialog becomes a scrolling column: picture first, words beneath,
   * one scroll for the lot. The thread keeps no scroller of its own — nested scrollers on a phone
   * are the thing where you swipe and the wrong layer moves. */
  .lb.stacked { flex-direction: column; align-items: center; justify-content: flex-start;
    overflow-y: auto; overscroll-behavior: contain; padding: 64px 16px 28px; gap: 14px; }
  /* flex: none — in a column flex container an image is a flex item and would otherwise be squashed
     to make room for a long thread rather than the column scrolling. */
  .lb.stacked img, .lb.stacked video { flex: none; max-height: 62vh; }
  .lb.stacked .media video { max-height: 62vh; }
  .lb.stacked .cap { position: static; background: none; padding: 0; pointer-events: auto;
    width: min(620px, 100%); text-align: left; }
  .lb.stacked .cap > * { max-width: none; margin-left: 0; margin-right: 0; }
  .lb.stacked .cap-meta { justify-content: flex-start; }
  .lb.stacked .thread { max-height: none; overflow: visible; margin-top: 14px;
    padding-top: 12px; border-top: 1px solid rgba(255,255,255,.16); }
  /* The chrome stays put while the column scrolls under it — absolute would scroll away with the
     content, taking the close button with it. */
  .lb.stacked .lb-bar { position: fixed; top: 12px; left: 12px; right: 12px; }
  .lb.stacked .nav { position: fixed; }
  /* Held to a readable measure and kept clear of the nav arrows, rather than run edge to edge. The
     scrim does the legibility work a text-shadow was being asked to do alone over a bright photo. */
  .cap { position: absolute; bottom: 0; left: 0; right: 0; padding: 48px 64px 18px; color: #fff;
    text-align: center; pointer-events: none;
    background: linear-gradient(to top, rgba(0,0,0,.72) 0%, rgba(0,0,0,.45) 45%, transparent 100%); }
  .cap > * { unicode-bidi: plaintext; max-width: 56ch; margin: 0 auto; }
  /* The caption block lets clicks through to the picture behind it (`pointer-events: none`), so
     anything in it that IS pressable has to opt back in by name. */
  .cap-heart { pointer-events: auto; }
  .thread { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; text-align: left;
    max-height: 26vh; overflow-y: auto; }
  /* plaintext, like every other place a guest's own words are shown — a right-to-left message in a
     left-to-right paragraph does not merely look wrong, it reorders the line. */
  .cmt { unicode-bidi: plaintext; margin: 0; font-size: .82rem; line-height: 1.4; color: #fff;
    display: flex; gap: 6px; align-items: baseline; }
  .cmt-who { font-weight: 700; opacity: .85; flex: none; }
  .cmt-via { flex: none; font-size: .62rem; font-weight: 700; letter-spacing: .02em; line-height: 1;
    padding: 2px 6px; border-radius: 999px; align-self: center; white-space: nowrap;
    border: 1px solid rgba(255,255,255,.22); color: rgba(255,255,255,.62); }
  .cmt-body { min-width: 0; overflow-wrap: anywhere; }
  /* The camera's bin, to the pixel — same pill, same weight, same confirm colour (.pcell-bin in
     Camera.svelte). Two controls that do the same thing in the same two taps should not be two
     different-looking things. */
  .cmt-more { align-self: flex-start; margin-top: 2px; padding: 5px 11px; border-radius: 999px;
    cursor: pointer; font: inherit; font-size: .72rem; font-weight: 700; line-height: 1;
    border: 1px solid rgba(255,255,255,.22); background: transparent; color: rgba(255,255,255,.8); }
  .cmt-more:hover { color: #fff; border-color: rgba(255,255,255,.45); }
  .thread-sort { display: flex; gap: 6px; margin-bottom: 4px; }
  .tsort { padding: 3px 9px; border-radius: 999px; cursor: pointer; font: inherit; font-size: .68rem;
    font-weight: 700; line-height: 1; border: 1px solid rgba(255,255,255,.22);
    background: transparent; color: rgba(255,255,255,.7); }
  .tsort.on { background: var(--accent-fill); color: var(--accent-ink, #111); border-color: var(--accent); }
  /* One group, pushed right. The auto margin lives HERE rather than on either control, so the row
     lays out the same whether or not this viewer can delete the comment. */
  .cmt-acts { flex: none; margin-left: auto; align-self: center;
    display: inline-flex; align-items: center; gap: 6px; }
  /* Fixed slot, icon pinned to its left edge: the count grows into reserved space on the right
     instead of pushing the icon along in front of it. */
  .cmt-heart { flex: none; display: inline-flex;
    align-items: center; justify-content: flex-start; gap: 4px;
    min-width: 38px; padding: 0; border: 0; background: none; cursor: pointer;
    color: rgba(255,255,255,.6); font: inherit; line-height: 1; }
  .cmt-heart:hover:not(:disabled) { color: #fff; }
  .cmt-heart.on { color: var(--heart-red, #ec2f55); }
  .cmt-heart:disabled { cursor: default; }
  .cmt-heart :global(svg) { display: block; }
  /* tabular-nums so the digits themselves are the same width row to row — proportional figures
     make a column of counts ripple. */
  .cmt-heart .chn { font-size: .68rem; font-weight: 800; font-variant-numeric: tabular-nums;
    color: rgba(255,255,255,.85); }

  .cmt-x { flex: none; align-self: center;
    min-width: 30px; height: 26px; padding: 0 7px;
    /* Grid, not flex: the two labels share one cell so the pill is sized by the wider of them and
       does not change width when it arms. */
    display: inline-grid; place-items: center;
    font: inherit; font-size: .74rem; line-height: 1; border-radius: 999px; cursor: pointer;
    background: rgba(0,0,0,.6); color: #fff; border: 1px solid rgba(255,255,255,.4);
    -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
  .cmt-x .lbl { grid-area: 1 / 1; white-space: nowrap; }
  .cmt-x .lbl.off { visibility: hidden; }
  .cmt-x:active { transform: scale(.94); }
  .cmt-x.confirm { background: #c0392b; border-color: #e6795f; font-weight: 700; letter-spacing: .01em; }
  .cmt-new { display: flex; gap: 6px; margin-top: 4px; }
  .cmt-new input { flex: 1; min-width: 0; padding: 8px 12px; border-radius: 999px; font: inherit;
    font-size: .82rem; color: #fff; background: rgba(255,255,255,.12);
    border: 1px solid rgba(255,255,255,.22); }
  .cmt-new input:focus-visible { outline: none; border-color: var(--accent); }
  /* Written here rather than inherited: Svelte scopes a component's styles to that component, and
     there is deliberately no global `.btn` (see app.css) — so this button was painting in the
     browser's own grey next to a rounded field on a black scrim. */
  .btn { flex: none; font: inherit; font-size: .82rem; font-weight: 700; line-height: 1;
    padding: 9px 16px; border-radius: 999px; border: 1px solid transparent; cursor: pointer;
    background: var(--accent-fill); color: var(--accent-ink, #111); }
  .btn:hover:not(:disabled) { filter: brightness(1.06); }
  .btn:disabled { opacity: .5; cursor: default; }
  .cap-written { font-size: 1rem; line-height: 1.45; font-weight: 500; overflow-wrap: anywhere; }
  .cap-mission { margin-top: 4px; font-size: .84rem; line-height: 1.4; font-weight: 700; }
  .cap-meta { margin-top: 7px; font-size: .74rem; line-height: 1.5; color: rgba(255,255,255,.72);
    display: flex; flex-wrap: wrap; align-items: baseline; justify-content: center; gap: 0 6px; }
  .cap-heart + .sep { align-self: center; }
  .cap-meta .who { font-weight: 600; color: rgba(255,255,255,.9); }
  /* No plate and no pill — the same call PhotoCard's heart makes. The drop shadow is what holds it
     against a bright frame; a chip here would read as a button bolted onto the caption. */
  /* `align-self: center`, because the row it sits in is baseline-aligned and this item has no text
     baseline to align ON — its first child is an SVG, so the browser falls back to the element's
     bottom margin edge and the whole control rides high above the line of text beside it. Centring
     it against the line is what "in line with the rest" actually means here. */
  .cap-heart { display: inline-flex; align-items: center; align-self: center; gap: 5px;
    padding: 0; border: 0; background: none; color: rgba(255,255,255,.82); cursor: pointer;
    font: inherit; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
  .cap-heart :global(svg) { display: block; }
  .cap-heart.on { color: var(--heart-red, #ec2f55); }
  /* Not a control for this viewer — still shows the count, and says so by not inviting a press. */
  .cap-heart:disabled { cursor: default; }
  .cap-heart .hn { font-size: .74rem; font-weight: 800; font-variant-numeric: tabular-nums;
    color: rgba(255,255,255,.9); }
  .cap-meta .sep { opacity: .45; }
  /* flex-START, not centre. With the actions on two lines and the caption button on one, centring
     hung the caption button halfway down the taller group and nothing in the bar lined up with
     anything else — which is exactly what it looked like. Every group now starts at the same top
     edge, so the first row of controls is one straight line however many rows follow it. */
  .lb-bar { position: absolute; top: 12px; left: 12px; right: 12px; z-index: 3;
    display: flex; align-items: flex-start; gap: 8px;
    pointer-events: none; }
  .lb-bar-l { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* The auto margin, not `justify-content: space-between` on the bar: space-between only puts this
     at the right-hand end while something else is at the left, and the caption button is not
     always there. An auto margin is right either way. */
  .lb-bar-r { display: flex; align-items: flex-start; gap: 8px; margin-left: auto; }
  /* Wraps rather than overflowing — with Download and the rotate slot side by side this is wider
     than a phone, and a bar that runs off the screen used to take the Close button with it. Only
     the ACTIONS wrap now; the chrome beside them does not. */
  .lb-acts { display: flex; align-items: center; justify-content: flex-end; gap: 8px;
    flex-wrap: wrap; }
  .lb-chrome { flex: none; display: flex; align-items: center; gap: 8px; }
  /* On a phone the bar becomes rows rather than a ragged run of pills: the chrome keeps the
     top-right corner, the actions fill the width beside and beneath it, and the caption button —
     the widest and the least urgent — drops to a row of its own at the bottom. Every control is
     the same height and every row is full width, which is what "one set of controls" looks like
     when there is not enough width to put them on one line. */
  @media (max-width: 560px) {
    .lb-bar { flex-wrap: wrap; }
    .lb-bar-l { order: 2; flex: 1 1 100%; }
    .lb-bar-l .lb-btn { flex: 1 1 auto; }
    .lb-bar-r { flex: 1 1 auto; }
    .lb-acts { flex: 1 1 auto; }
    .lb-acts > .lb-btn { flex: 1 1 auto; }
  }
  /* One pill, three uses — same height, same weight, whatever is in it.
     `gap`, not a space in the markup: this is a flex container, so a whitespace-only run between
     the download icon and the word beside it generates no flex item and collapses to nothing —
     "Save" would sit hard against the arrow. min-height goes to 44 with it: the pill holds a 20px
     icon now, and it is a control on a phone (Camera.svelte's touch-target note). */
  .lb-btn { pointer-events: auto; display: inline-flex; align-items: center; justify-content: center;
    gap: 7px;
    min-height: 44px; padding: 0 15px; border-radius: 999px;
    border: 1px solid rgba(255,255,255,.28); background: rgba(0,0,0,.5); color: #fff;
    font: inherit; font-size: .82rem; line-height: 1; cursor: pointer;
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .lb-btn:hover { border-color: rgba(255,255,255,.5); }
  .lb-btn:disabled { opacity: .6; cursor: default; }
  /* The close is the one round one: it is an icon, not a phrase. Square to the bar's height. */
  .lb-btn.close { width: 44px; padding: 0; font-size: 1rem; }
  /* Save and Cancel used to be two more pills here. They live inside the rotate slot now, so that
     pressing ↻ cannot change how many controls the bar is holding — see RotateControl.svelte. */
  /* Demoted, not dropped: with a caption present the mission is attribution, not the headline. */
  .cap-mission.secondary { font-weight: 400; opacity: .78; }
  /* The video and its sound prompt as one unit, so the prompt can be placed against the picture
     rather than against the window. */
  .media { position: relative; display: flex; min-width: 0; }
  .media video { display: block; }
  .lb.stacked .media { flex: none; }
  /* Low in the corner of the picture and quiet about it — but on the LEFT, and higher.
     The right-hand end of the browser's own control bar is where its menus live (settings, quality,
     playback speed, picture-in-picture) and they all open UPWARD, straight through where this used
     to sit. The left end holds play and volume, which expand along the bar rather than above it, so
     there is nothing to collide with there. 66px clears the bar itself (~40px) with room to spare.
     It is a hint that sound is available, not an announcement. */
  .unmute { position: absolute; left: 10px; bottom: 66px; z-index: 4;
    display: inline-flex; align-items: center; gap: 5px;
    padding: 5px 10px; border-radius: 999px; cursor: pointer;
    border: 1px solid rgba(255,255,255,.22); background: rgba(0,0,0,.5); color: rgba(255,255,255,.9);
    font: inherit; font-size: .7rem; font-weight: 600; line-height: 1;
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .unmute:hover { background: rgba(0,0,0,.72); color: #fff; }
  /* Photo-only: the picture gets the room the caption was using. */
  .lb.bare img, .lb.bare video { max-height: 92vh; }
  .nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.4);
    color: #fff; border: none; width: 44px; height: 64px; font-size: 2rem; cursor: pointer; }
  .nav.l { left: 8px; border-radius: 0 8px 8px 0; } .nav.r { right: 8px; border-radius: 8px 0 0 8px; }
</style>
